// Shared renderer for a run's captured output / extracted result.
//
// Used by the schedule view's "История" tab (ScheduleView.tsx) and the global
// History list (HistoryRow.tsx) so a scheduled run, a command run, and a
// workflow run all show the same expandable console block / result / "no
// output" note. It is intentionally prop-based (output + result) rather than
// event-typed so it works for ANY run kind that persists captured output.
// Keeping it in one place means the surfaces never drift.

import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AnsiText } from "../AnsiText";
import type { ExtractedResult, HistoryLogLine } from "../../types";

/** Which pane of the captured detail is showing. */
type DetailTab = "output" | "result";

/** The captured console lines as a styled `<pre>` block. */
function OutputPane({ lines }: { lines: HistoryLogLine[] }): ReactElement {
  return (
    <pre className="schedule-history__console">
      {lines.map((line, i) => (
        <span
          key={i}
          className={`schedule-history__line schedule-history__line--${line.stream}`}
        >
          <AnsiText text={line.line} />
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

/**
 * The extracted result: an inline error when extraction failed, otherwise the
 * return value and the full field map as pretty-printed JSON. Mirrors the
 * console `OutputPanel`'s `ResultView` so a scheduled run reads the same as a
 * live run with an output schema.
 */
function ResultPane({ result }: { result: ExtractedResult }): ReactElement {
  const { t } = useTranslation();
  if (result.error !== undefined) {
    return (
      <pre className="schedule-history__console">
        <span className="schedule-history__line schedule-history__line--stderr">
          {t("scheduler.view.resultError", { message: result.error })}
        </span>
      </pre>
    );
  }
  return (
    <pre className="schedule-history__console">
      {JSON.stringify(
        { returnValue: result.returnValue, fields: result.fields },
        null,
        2,
      )}
    </pre>
  );
}

/**
 * The body of a scheduled-run disclosure. When a run captured BOTH console
 * output and a structured result, the two are shown as tabs (mirroring the
 * console `OutputPanel`'s Вывод/Результат tabs). When only one is present, it
 * renders alone (a single tab would be pointless); when neither, a muted note.
 * Rendered inside a `<details>` body by the caller, so the markup is identical
 * on the schedule view's История tab and the global History list.
 */
export function ScheduledRunOutput({
  output: rawOutput,
  result,
}: {
  output?: HistoryLogLine[];
  result?: ExtractedResult;
}): ReactElement {
  const { t } = useTranslation();
  const output =
    rawOutput !== undefined && rawOutput.length > 0 ? rawOutput : undefined;
  const hasOutput = output !== undefined;
  const hasResult = result !== undefined;

  // Default to the output tab; only relevant when both panes exist.
  const [activeTab, setActiveTab] = useState<DetailTab>("output");

  // Both present → tabbed switcher.
  if (hasOutput && hasResult) {
    return (
      <div className="schedule-history__body">
        <div className="schedule-history__tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "output"}
            className={`schedule-history__tab${
              activeTab === "output" ? " is-active" : ""
            }`}
            onClick={() => setActiveTab("output")}
          >
            {t("scheduler.view.outputLabel")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === "result"}
            className={`schedule-history__tab${
              activeTab === "result" ? " is-active" : ""
            }`}
            onClick={() => setActiveTab("result")}
          >
            {t("scheduler.view.resultLabel")}
          </button>
        </div>
        {activeTab === "result" ? (
          <ResultPane result={result} />
        ) : (
          <OutputPane lines={output} />
        )}
      </div>
    );
  }

  // Exactly one present → a single labeled section (no tabs needed).
  if (hasOutput) {
    return (
      <div className="schedule-history__body">
        <div className="schedule-history__section">
          <span className="schedule-history__section-label">
            {t("scheduler.view.outputLabel")}
          </span>
          <OutputPane lines={output} />
        </div>
      </div>
    );
  }
  if (hasResult) {
    return (
      <div className="schedule-history__body">
        <div className="schedule-history__section">
          <span className="schedule-history__section-label">
            {t("scheduler.view.resultLabel")}
          </span>
          <ResultPane result={result} />
        </div>
      </div>
    );
  }

  // Neither: capture disabled, no output produced, or a run recorded before
  // the capture feature existed. Show a muted note so the disclosure still has
  // meaningful content.
  return (
    <div className="schedule-history__body">
      <p className="schedule-history__no-output">
        {t("scheduler.view.noOutput")}
      </p>
    </div>
  );
}
