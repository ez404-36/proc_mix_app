import { create } from "zustand";
import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateInfo {
  version: string;
  body: string;
  date: string | null;
}

type UpdatePhase = "idle" | "checking" | "downloading" | "installing";

export type CheckResult =
  | { status: "available" }
  | { status: "up-to-date" }
  | { status: "error"; message: string }
  | { status: "busy" };

interface UpdateState {
  info: UpdateInfo | null;
  phase: UpdatePhase;
  downloadProgress: number;
  error: string | null;
  dismissed: boolean;
  isModalOpen: boolean;

  checkForUpdate: () => Promise<CheckResult>;
  installUpdate: () => Promise<void>;
  openModal: () => void;
  closeModal: () => void;
  dismiss: () => void;
  reset: () => void;
}

let pendingUpdate: Update | null = null;

export const useUpdateStore = create<UpdateState>()((set, get) => ({
  info: null,
  phase: "idle" as UpdatePhase,
  downloadProgress: 0,
  error: null,
  dismissed: false,
  isModalOpen: false,

  checkForUpdate: async (): Promise<CheckResult> => {
    const { phase } = get();
    if (phase !== "idle") return { status: "busy" };
    set({ phase: "checking", error: null });
    try {
      const update = await check();
      if (update) {
        pendingUpdate = update;
        set({
          info: {
            version: update.version,
            body: update.body ?? "",
            date: update.date ?? null,
          },
          dismissed: false,
        });
        return { status: "available" };
      }
      pendingUpdate = null;
      set({ info: null });
      return { status: "up-to-date" };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("Could not fetch a valid release")) {
        pendingUpdate = null;
        set({ info: null });
        return { status: "up-to-date" };
      }
      return { status: "error", message };
    } finally {
      set({ phase: "idle" });
    }
  },

  installUpdate: async () => {
    const { phase } = get();
    if (phase === "downloading" || phase === "installing") return;

    // If the previous download failed, the Update resource may be stale.
    // Re-check first so we get a fresh handle.
    if (!pendingUpdate || get().error) {
      set({ phase: "checking", error: null, downloadProgress: 0 });
      try {
        const update = await check();
        if (!update) {
          set({ phase: "idle", info: null, error: null });
          pendingUpdate = null;
          return;
        }
        pendingUpdate = update;
        set({
          info: {
            version: update.version,
            body: update.body ?? "",
            date: update.date ?? null,
          },
        });
      } catch (e) {
        set({
          phase: "idle",
          error: e instanceof Error ? e.message : String(e),
        });
        return;
      }
    }

    set({ phase: "downloading", downloadProgress: 0, error: null });
    try {
      let contentLength = 0;
      let downloaded = 0;
      await pendingUpdate.downloadAndInstall((progress: DownloadEvent) => {
        if (progress.event === "Started") {
          contentLength = progress.data.contentLength ?? 0;
        } else if (progress.event === "Progress") {
          downloaded += progress.data.chunkLength;
          if (contentLength > 0) {
            set({ downloadProgress: Math.min(downloaded / contentLength, 1) });
          }
        }
      });
      set({ phase: "installing" });
      await relaunch();
    } catch (e) {
      set({
        phase: "idle",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  },

  openModal: () => set({ isModalOpen: true }),
  closeModal: () => set({ isModalOpen: false }),

  dismiss: () => set({ dismissed: true }),

  reset: () => {
    pendingUpdate = null;
    set({
      info: null,
      phase: "idle",
      downloadProgress: 0,
      error: null,
      dismissed: false,
      isModalOpen: false,
    });
  },
}));
