// Local consent memory for run-scoped assistant snapshots.
//
// The global assistant setting remains the durable default. A per-subject
// "Allow" is explicit consent for this command/workflow; a denial is tied to
// the individual execution so a later run can ask again.

const STORAGE_KEY = "procmix.runAssistant.snapshotConsents.v1";

export type RunSnapshotConsent = "unknown" | "allowed" | "denied";

interface StoredRunSnapshotConsents {
  allowedSubjects: string[];
  deniedRuns: string[];
}

const EMPTY: StoredRunSnapshotConsents = {
  allowedSubjects: [],
  deniedRuns: [],
};

function read(): StoredRunSnapshotConsents {
  if (typeof localStorage === "undefined") return EMPTY;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return EMPTY;
    const record = value as Partial<StoredRunSnapshotConsents>;
    const isStringArray = (input: unknown): input is string[] =>
      Array.isArray(input) && input.every((item) => typeof item === "string");
    return {
      allowedSubjects: isStringArray(record.allowedSubjects)
        ? record.allowedSubjects
        : [],
      deniedRuns: isStringArray(record.deniedRuns) ? record.deniedRuns : [],
    };
  } catch {
    return EMPTY;
  }
}

function write(value: StoredRunSnapshotConsents): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function resolveRunSnapshotConsent(input: {
  allowAllRuns: boolean | null;
  subjectKey: string;
  runId: string;
}): RunSnapshotConsent {
  if (input.allowAllRuns === true) return "allowed";
  if (input.allowAllRuns === null) return "unknown";
  const stored = read();
  if (stored.allowedSubjects.includes(input.subjectKey)) return "allowed";
  if (stored.deniedRuns.includes(input.runId)) return "denied";
  return "unknown";
}

export function allowRunSnapshotSubject(subjectKey: string): void {
  const stored = read();
  write({
    allowedSubjects: stored.allowedSubjects.includes(subjectKey)
      ? stored.allowedSubjects
      : [...stored.allowedSubjects, subjectKey],
    deniedRuns: stored.deniedRuns,
  });
}

export function denyRunSnapshotRun(runId: string): void {
  const stored = read();
  write({
    allowedSubjects: stored.allowedSubjects,
    deniedRuns: stored.deniedRuns.includes(runId)
      ? stored.deniedRuns
      : [...stored.deniedRuns, runId],
  });
}
