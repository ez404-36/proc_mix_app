// History row (F7) — one read-only run event.
//
// Run-only and view-only: the B2 endpoint returns only `commandRun` /
// `workflowRun` rows, and the web History has NO delete / restore / cancel /
// select. A row shows: a run icon, the localized "Ran <name>" title, a status
// badge, a timestamp, and — when output was captured — an expandable
// `<details>` revealing the console block / result. Rows without captured
// output stay plain (no empty expander), mirroring the desktop.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { RunIcon } from "@app/components/icons/RunIcon";
import type {
  ExtractedResult,
  HistoryEventWire,
  HistoryLogLine,
  RunStatus,
} from "../api/types";

/** Locale-aware timestamp; falls back to the raw ISO string on parse failure. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function statusText(
  status: RunStatus,
  t: TFunction,
  exitCode?: number,
  timedOut?: boolean,
): string {
  switch (status) {
    case "running":
      return t("history.runStatus.running", "Running");
    case "succeeded":
      return t("history.runStatus.succeeded", "Succeeded");
    case "failed":
      return timedOut
        ? t("history.runStatus.timedOut", "Timed out")
        : t("history.runStatus.failed", "Failed (exit {{code}})").replace(
            "{{code}}",
            String(exitCode ?? "?"),
          );
    case "cancelled":
      return t("history.runStatus.cancelled", "Cancelled");
  }
}

export function HistoryRow({
  event,
}: {
  event: HistoryEventWire;
}): React.JSX.Element {
  const { t } = useTranslation();
  // In the web History every row is a run, so the verbose "Ran command/workflow
  // …" prefix is redundant — show just the entity name, with a small kind badge
  // (command/workflow) carrying that distinction, like the cards do.
  const name = event.commandName ?? event.workflowName ?? "";
  const isCommand = event.kind === "commandRun";
  const kindKey = isCommand ? "command" : "workflow";

  const titleNode = (
    <span className="history-row__title">
      <span className={`type-badge type-badge--${kindKey}`}>
        {isCommand ? t("home.typeCommand") : t("home.typeWorkflow")}
      </span>
      {name}
    </span>
  );

  const badge = (
    <span
      className={`history-row__status history-row__status--${event.status}${
        event.timedOut ? " history-row__status--timedOut" : ""
      }`}
    >
      {statusText(event.status, t, event.exitCode, event.timedOut)}
    </span>
  );

  const icon = (
    <span className="history-row__action-icon history-row__action-icon--run">
      <RunIcon />
    </span>
  );

  const meta = (
    <div className="history-row__meta">
      <time
        className="history-row__timestamp"
        dateTime={event.createdAt}
        title={event.createdAt}
      >
        {formatTimestamp(event.createdAt)}
      </time>
    </div>
  );

  // Expandable only when output was persisted. Older / no-output runs stay plain.
  const hasOutput = event.output !== undefined && event.output.length > 0;
  const hasResult = event.result !== undefined;

  if (hasOutput || hasResult) {
    return (
      <li className="history-row history-row--scheduled">
        <details className="history-row__disclosure">
          <summary className="history-row__summary">
            <div className="history-row__main">
              {icon}
              {titleNode}
              {badge}
            </div>
            {meta}
          </summary>
          <RunOutput output={event.output} result={event.result} />
        </details>
      </li>
    );
  }

  return (
    <li className="history-row">
      <div className="history-row__main">
        {icon}
        {titleNode}
        {badge}
      </div>
      {meta}
    </li>
  );
}

/** The captured console output / extracted result, reusing console classes. */
function RunOutput({
  output,
  result,
}: {
  output?: HistoryLogLine[];
  result?: ExtractedResult;
}): React.JSX.Element {
  const { t } = useTranslation();
  const lines = output !== undefined && output.length > 0 ? output : undefined;
  const [tab, setTab] = useState<"output" | "result">(
    lines ? "output" : "result",
  );

  if (lines === undefined && result === undefined) {
    return (
      <div className="schedule-history__body">
        <p className="schedule-history__no-output">
          {t("web.console.noOutput", "No output.")}
        </p>
      </div>
    );
  }

  const both = lines !== undefined && result !== undefined;

  return (
    <div className="schedule-history__body">
      {both ? (
        <div className="schedule-history__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "output"}
            className={`schedule-history__tab${tab === "output" ? " is-active" : ""}`}
            onClick={() => setTab("output")}
          >
            {t("scheduler.view.outputLabel", "Output")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "result"}
            className={`schedule-history__tab${tab === "result" ? " is-active" : ""}`}
            onClick={() => setTab("result")}
          >
            {t("scheduler.view.resultLabel", "Result")}
          </button>
        </div>
      ) : null}

      {(both ? tab === "output" : lines !== undefined) && lines ? (
        <pre className="schedule-history__console">
          {lines.map((line, i) => (
            <span
              key={i}
              className={`schedule-history__line schedule-history__line--${line.stream}`}
            >
              {line.line}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : result !== undefined ? (
        <pre className="schedule-history__console">
          {JSON.stringify(result, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
