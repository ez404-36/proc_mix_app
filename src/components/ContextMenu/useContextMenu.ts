import { useContext } from "react";
import { ContextMenuContext } from "./context";
import type { ContextMenuContextValue } from "./types";

export function useContextMenu(): ContextMenuContextValue {
  const ctx = useContext(ContextMenuContext);
  if (!ctx) {
    throw new Error("useContextMenu must be used within ContextMenuProvider");
  }
  return ctx;
}
