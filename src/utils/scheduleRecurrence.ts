// Structured recurrence model for the schedule form.
//
// The user picks a recurrence TYPE (every-N-minutes, every-N-hours, daily,
// weekly, monthly, or a raw custom expression) and fills a small per-type
// parameter form. `buildCron` turns the structured value into a 5-field Unix
// cron string (the canonical value stored in `Schedule.cron`); `parseCron`
// does the reverse for edit mode, falling back to `custom` when a stored
// expression doesn't match any structured shape.
//
// All cron strings are 5-field (min hour dom month dow), evaluated in local
// time by the backend. Weekday numbers follow cron convention 0–6 = Sun–Sat;
// we expose Monday-first in the UI but store the cron numbers.

export type RecurrenceType =
  | "everyNMinutes"
  | "everyNHours"
  | "daily"
  | "weekly"
  | "monthly"
  | "custom";

export interface EveryNMinutesRecurrence {
  type: "everyNMinutes";
  /** Interval in minutes, 1–59. */
  interval: number;
}

export interface EveryNHoursRecurrence {
  type: "everyNHours";
  /** Interval in hours, 1–23. */
  interval: number;
  /** Minute of the hour the run fires on, 0–59. */
  minute: number;
}

export interface DailyRecurrence {
  type: "daily";
  hour: number; // 0–23
  minute: number; // 0–59
}

export interface WeeklyRecurrence {
  type: "weekly";
  /** Cron weekday numbers (0–6, Sun–Sat). At least one to be valid. */
  days: number[];
  hour: number;
  minute: number;
}

export interface MonthlyRecurrence {
  type: "monthly";
  /** Day of month, 1–31. */
  day: number;
  hour: number;
  minute: number;
}

export interface CustomRecurrence {
  type: "custom";
  /** Raw 5-field cron expression typed by the user. */
  cron: string;
}

export type Recurrence =
  | EveryNMinutesRecurrence
  | EveryNHoursRecurrence
  | DailyRecurrence
  | WeeklyRecurrence
  | MonthlyRecurrence
  | CustomRecurrence;

/** The order recurrence types appear in the form's type dropdown. */
export const RECURRENCE_TYPES: readonly RecurrenceType[] = [
  "everyNMinutes",
  "everyNHours",
  "daily",
  "weekly",
  "monthly",
  "custom",
];

/** Cron weekday numbers in Monday-first display order, with i18n key suffix. */
export const WEEKDAYS: ReadonlyArray<{ cron: number; key: string }> = [
  { cron: 1, key: "mon" },
  { cron: 2, key: "tue" },
  { cron: 3, key: "wed" },
  { cron: 4, key: "thu" },
  { cron: 5, key: "fri" },
  { cron: 6, key: "sat" },
  { cron: 0, key: "sun" },
];

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const n = Math.trunc(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** A sensible blank value for each recurrence type (form defaults). */
export function defaultRecurrence(type: RecurrenceType): Recurrence {
  switch (type) {
    case "everyNMinutes":
      return { type, interval: 15 };
    case "everyNHours":
      return { type, interval: 2, minute: 0 };
    case "daily":
      return { type, hour: 9, minute: 0 };
    case "weekly":
      return { type, days: [1], hour: 9, minute: 0 };
    case "monthly":
      return { type, day: 1, hour: 9, minute: 0 };
    case "custom":
      return { type, cron: "" };
  }
}

/**
 * Build the 5-field cron string for a structured recurrence. For `custom`
 * the raw expression is returned trimmed (validation happens server-side via
 * the preview command). Numeric fields are clamped to valid ranges so the
 * output is always a well-formed expression for the structured types.
 */
export function buildCron(r: Recurrence): string {
  switch (r.type) {
    case "everyNMinutes": {
      const n = clampInt(r.interval, 1, 59);
      return `*/${n} * * * *`;
    }
    case "everyNHours": {
      const n = clampInt(r.interval, 1, 23);
      const m = clampInt(r.minute, 0, 59);
      return `${m} */${n} * * *`;
    }
    case "daily": {
      const h = clampInt(r.hour, 0, 23);
      const m = clampInt(r.minute, 0, 59);
      return `${m} ${h} * * *`;
    }
    case "weekly": {
      const h = clampInt(r.hour, 0, 23);
      const m = clampInt(r.minute, 0, 59);
      // Preserve display order (Mon..Sun) for readability, de-duplicated.
      const days = WEEKDAYS.map((d) => d.cron).filter((c) =>
        r.days.includes(c),
      );
      const dow = days.length > 0 ? days.join(",") : "*";
      return `${m} ${h} * * ${dow}`;
    }
    case "monthly": {
      const d = clampInt(r.day, 1, 31);
      const h = clampInt(r.hour, 0, 23);
      const m = clampInt(r.minute, 0, 59);
      return `${m} ${h} ${d} * *`;
    }
    case "custom":
      return r.cron.trim();
  }
}

const INT_FIELD = /^\d+$/;

function parseIntField(field: string): number | null {
  if (!INT_FIELD.test(field)) return null;
  return Number.parseInt(field, 10);
}

// Parse a cron step field (asterisk-slash-N), returning N (or null otherwise).
function parseStep(field: string): number | null {
  const m = /^\*\/(\d+)$/.exec(field);
  if (!m || m[1] === undefined) return null;
  return Number.parseInt(m[1], 10);
}

/** Parse a comma list of weekday numbers (e.g. `1,3,5`), all 0–6. */
function parseWeekdayList(field: string): number[] | null {
  const parts = field.split(",");
  const out: number[] = [];
  for (const p of parts) {
    const n = parseIntField(p);
    if (n === null || n < 0 || n > 6) return null;
    out.push(n);
  }
  return out;
}

// Reverse of `buildCron`: recognise a stored cron as one of the structured
// recurrence types, else fall back to `custom` carrying the raw string.
// Recognised shapes (after whitespace normalisation), where SLASH-N means a
// cron step field:
//
//   - step-N minute, all-else wildcard   -> everyNMinutes
//   - numeric minute, step-N hour        -> everyNHours
//   - numeric minute + hour, dom/dow wild -> daily
//   - numeric minute + hour, weekday list -> weekly
//   - numeric minute + hour, numeric dom  -> monthly
export function parseCron(cron: string): Recurrence {
  const raw = cron.trim();
  const fields = raw.replace(/\s+/g, " ").split(" ");
  const fallback: CustomRecurrence = { type: "custom", cron: raw };
  if (fields.length !== 5) return fallback;
  const [minF, hourF, domF, monF, dowF] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  // everyNMinutes: */N * * * *
  if (monF === "*" && domF === "*" && dowF === "*" && hourF === "*") {
    const n = parseStep(minF);
    if (n !== null && n >= 1 && n <= 59) {
      return { type: "everyNMinutes", interval: n };
    }
    return fallback;
  }

  // The remaining structured shapes all require a numeric minute and a
  // wildcard month.
  if (monF !== "*") return fallback;

  // everyNHours: M */N * * *
  if (domF === "*" && dowF === "*") {
    const stepH = parseStep(hourF);
    const minute = parseIntField(minF);
    if (stepH !== null && stepH >= 1 && stepH <= 23 && minute !== null && minute <= 59) {
      return { type: "everyNHours", interval: stepH, minute };
    }
  }

  const minute = parseIntField(minF);
  const hour = parseIntField(hourF);

  // daily: M H * * *
  if (
    domF === "*" &&
    dowF === "*" &&
    minute !== null &&
    minute <= 59 &&
    hour !== null &&
    hour <= 23
  ) {
    return { type: "daily", hour, minute };
  }

  // weekly: M H * * D[,D...]
  if (
    domF === "*" &&
    dowF !== "*" &&
    minute !== null &&
    minute <= 59 &&
    hour !== null &&
    hour <= 23
  ) {
    const days = parseWeekdayList(dowF);
    if (days !== null && days.length > 0) {
      return { type: "weekly", days, hour, minute };
    }
  }

  // monthly: M H D * *
  if (dowF === "*" && domF !== "*" && minute !== null && minute <= 59 && hour !== null && hour <= 23) {
    const day = parseIntField(domF);
    if (day !== null && day >= 1 && day <= 31) {
      return { type: "monthly", day, hour, minute };
    }
  }

  return fallback;
}
