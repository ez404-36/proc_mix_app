import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  CancelIcon,
  ChevronIcon,
  SidebarToggleIcon,
  SpinnerIcon,
} from "../icons";
import { useContextMenu } from "../ContextMenu";
import { MarkdownMessage } from "./MarkdownMessage";

import { useAssistantStore } from "../../stores/assistantStore";
import type {
  AssistantChatMessage,
  AssistantObjectContext,
  AssistantPatch,
  AssistantRunSnapshot,
  AssistantTarget,
} from "../../types/assistant";
import { previewAssistantPatch } from "../../utils/assistantPatches";
import {
  copyText,
  getSelectionWithin,
  selectAllWithin,
} from "../../utils/consoleClipboard";
import {
  buildAssistantPatchRetryPrompt,
  type AssistantPatchFeedbackError,
} from "../../utils/assistantPatchFeedback";

interface AssistantPanelProps {
  target: AssistantTarget;
  objectId: string | null;
  draftVersion: number;
  context: AssistantObjectContext<unknown>;
  title: string;
  onClose?: () => void;
  onApplyPatch?: (
    patch: AssistantPatch,
  ) => { ok: boolean; error?: AssistantPatchFeedbackError };
  runSnapshot?: AssistantRunSnapshot | null;
  onRequestRun?: () => void;
  /** Editor tests pass this to inspect the expanded chat directly. */
  defaultExpanded?: boolean;
}

export interface AssistantPatchApplyOutcome {
  ok: boolean;
  error?: AssistantPatchFeedbackError;
}

export function AssistantPanel({
  target,
  objectId,
  draftVersion,
  context,
  title,
  onClose,
  onApplyPatch,
  runSnapshot,
  onRequestRun,
  defaultExpanded = false,
}: AssistantPanelProps): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const { show } = useContextMenu();
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const session = useAssistantStore((state) => state.session);
  const startSession = useAssistantStore((state) => state.startSession);
  const sendMessage = useAssistantStore((state) => state.sendMessage);
  const cancelSession = useAssistantStore((state) => state.cancelSession);
  const [appliedMessageId, setAppliedMessageId] = useState<string | null>(null);
  const [applyError, setApplyError] =
    useState<AssistantPatchFeedbackError | null>(null);
  const [snapshotPreviewOpen, setSnapshotPreviewOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(!defaultExpanded);
  const setRunSnapshot = useAssistantStore((state) => state.setRunSnapshot);

  useEffect(() => {
    startSession(target, objectId, draftVersion);
  }, [draftVersion, objectId, startSession, target]);

  const submit = (): void => {
    if (draft.trim() === "" || session?.isGenerating) return;
    void sendMessage(context, draft);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const handleMessagesContextMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
  ): void => {
    const selectedText = getSelectionWithin(messagesRef.current);
    const chatText = (session?.messages ?? [])
      .map((message) => {
        const action = message.action;
        return action?.kind === "requestRun" || action?.kind === "requestOutput"
          ? `${message.text}\n\n${action.reason}`
          : message.text;
      })
      .join("\n\n");

    show({
      event: {
        clientX: event.clientX,
        clientY: event.clientY,
        preventDefault: () => event.preventDefault(),
      },
      items: [
        {
          id: "copy",
          label: t("contextMenu.copy"),
          disabled: selectedText.length === 0,
          onSelect: () => copyText(selectedText),
        },
        {
          id: "copy-chat",
          label: t("assistant.copyAll"),
          disabled: chatText.length === 0,
          onSelect: () => copyText(chatText),
        },
        { id: "assistant-copy-divider", divider: true },
        {
          id: "select-all",
          label: t("contextMenu.selectAll"),
          disabled: (session?.messages.length ?? 0) === 0,
          onSelect: () => selectAllWithin(messagesRef.current),
        },
      ],
    });
  };

  if (isCollapsed) {
    return (
      <aside className="assistant-panel assistant-panel--collapsed" role="region" aria-label={title}>
        <button
          type="button"
          className="assistant-panel__collapsed-trigger"
          onClick={() => setIsCollapsed(false)}
          aria-expanded={false}
          aria-label={t("nav.expand")}
          title={t("nav.expand")}
        >
          <span className="assistant-panel__collapsed-label" aria-hidden="true">
            AI
          </span>
          <span className="assistant-panel__toggle-icon" aria-hidden="true">
            <SidebarToggleIcon />
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="assistant-panel" role="region" aria-label={title}>
      <header className="assistant-panel__header">
        <div>
          <p className="assistant-panel__eyebrow">{t("assistant.title")}</p>
          <h2 className="assistant-panel__title">{title}</h2>
        </div>
        <button
          type="button"
          className="assistant-panel__collapse-toggle"
          onClick={() => {
            setIsCollapsed(true);
            onClose?.();
          }}
          aria-expanded={true}
          aria-label={t("nav.collapse")}
          title={t("nav.collapse")}
        >
          <span className="assistant-panel__toggle-icon" aria-hidden="true">
            <SidebarToggleIcon />
          </span>
        </button>
      </header>

      {runSnapshot ? (
        <section className="assistant-panel__run" aria-label={t("assistant.run.title")}>
          <div className="assistant-panel__run-summary">
            <strong>{t("assistant.run.title")}</strong>
            <span>
              {t("assistant.run.exit", { code: runSnapshot.exitCode ?? "?" })}
            </span>
            <span>{t("assistant.run.stdout", { size: runSnapshot.stdoutTail.length })}</span>
            <span>{t("assistant.run.stderr", { size: runSnapshot.stderrTail.length })}</span>
            <span>
              {t("assistant.run.schema", {
                yes: runSnapshot.outputSchema === undefined ? "no" : "yes",
              })}
            </span>
          </div>
          <div className="assistant-panel__run-actions">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setSnapshotPreviewOpen((open) => !open)}
              aria-expanded={snapshotPreviewOpen}
            >
              {t("assistant.run.preview")}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setRunSnapshot(runSnapshot)}
              disabled={session?.attachedRunSnapshotId === runSnapshot.id}
            >
              {t("assistant.run.send")}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => setRunSnapshot(null)}
            >
              {t("assistant.run.dismiss")}
            </button>
          </div>
          {snapshotPreviewOpen ? (
            <pre className="assistant-panel__run-preview">
              {JSON.stringify(runSnapshot, null, 2)}
            </pre>
          ) : null}
        </section>
      ) : null}

      <div
        ref={messagesRef}
        className="assistant-panel__messages"
        onContextMenu={handleMessagesContextMenu}
      >
        {session?.messages.map((message) => (
          <article
            key={message.id}
            className={`assistant-panel__message assistant-panel__message--${message.role} selectable`}
          >
            {message.role === "user" && message.kind === "patchRetry" ? (
              <PatchRetryMessage text={message.text} />
            ) : (
              <MarkdownMessage text={message.text} />
            )}
            {message.action ? (
              <div className="assistant-panel__action">
                <strong>{t(`assistant.actions.${message.action.kind}`)}</strong>
                {message.action.kind === "proposePatch" ? (
                  <PatchCardBody
                    message={message}
                    draft={context.draft}
                    applied={appliedMessageId === message.id}
                    error={applyError}
                    canApply={
                      onApplyPatch !== undefined &&
                      session?.isGenerating !== true
                    }
                    isGenerating={session?.isGenerating === true}
                    onApply={() => {
                      if (!onApplyPatch) return;
                      if (message.action?.kind !== "proposePatch") return;
                      const result = onApplyPatch(message.action.patch);
                      if (result.ok) {
                        setAppliedMessageId(message.id);
                        setApplyError(null);
                      } else {
                        const applyError = result.error ?? "applyFailed";
                        setApplyError(applyError);
                        void sendMessage(
                          context,
                          buildAssistantPatchRetryPrompt({
                            target,
                            patch: message.action.patch,
                            error: applyError,
                          }),
                        );
                      }
                    }}
                  />
                ) : (
                  <div>
                    <MarkdownMessage text={message.action.reason} />
                    {message.action.kind === "requestRun" && onRequestRun ? (
                      <button
                        type="button"
                        className="btn btn--ghost"
                        onClick={onRequestRun}
                      >
                        {t("assistant.run.now")}
                      </button>
                    ) : null}
                  </div>
                )}
              </div>
            ) : null}
          </article>
        ))}
        {session?.isGenerating && session.streamingText ? (
          <article className="assistant-panel__message assistant-panel__message--assistant">
            <MarkdownMessage text={session.streamingText} />
          </article>
        ) : null}
        {session?.isGenerating ? (
          <div className="assistant-panel__status" role="status">
            <span className="assistant-panel__status-spinner" aria-hidden="true">
              <SpinnerIcon />
            </span>
            {session.streamingText ? t("assistant.streaming") : t("assistant.thinking")}
          </div>
        ) : null}
        {session?.error ? (
          <p className="assistant-panel__error selectable" role="alert">
            {typeof session.error === "string"
              ? t(`assistant.errors.${session.error}`, {
                  defaultValue: t("assistant.errors.invalidResponse"),
                })
              : session.error.kind === "providerHttp"
                ? session.error.status === 429
                  ? t("assistant.errors.rateLimited")
                  : t("assistant.errors.providerHttp", {
                      status: session.error.status,
                    })
                : session.error.kind === "contract"
                  ? t("assistant.contractIssues", {
                      issue: t(
                        `assistant.contractIssues.${session.error.issue}`,
                      ),
                    })
                  : t("assistant.backendCode", {
                      code: session.error.code,
                    })}
          </p>
        ) : null}
      </div>

      <footer className="assistant-panel__composer">
        <textarea
          className="input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("assistant.placeholder")}
          aria-label={t("assistant.composerLabel")}
          rows={3}
        />
        <div className="assistant-panel__composer-actions">
          <span className="assistant-panel__hint">{t("assistant.sendHint")}</span>
          <button
            type="button"
            className="btn btn--primary"
            onClick={submit}
            disabled={session?.isGenerating || draft.trim() === ""}
          >
            {t("assistant.send")}
          </button>
          {session?.isGenerating ? (
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void cancelSession()}
            >
              <span className="command-form__action-icon--cancel">
                <CancelIcon />
              </span>
              {t("common.cancel")}
            </button>
          ) : null}
        </div>
      </footer>
    </aside>
  );
}

function PatchCardBody({
  message,
  draft,
  applied,
  error,
  onApply,
  canApply,
  isGenerating,
}: {
  message: AssistantChatMessage;
  draft: unknown;
  applied: boolean;
  error: string | null;
  onApply: () => void;
  canApply: boolean;
  isGenerating: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const action = message.action;
  if (action?.kind !== "proposePatch") {
    return <div />;
  }

  const preview = previewAssistantPatch(action.patch, draft);
  return (
    <div className="assistant-panel__patch">
      <ul className="assistant-panel__patch-list">
        {action.patch.operations.map((operation, index) => (
          <li key={`${operation.path}-${index}`}>
            <span className="assistant-panel__patch-path">{operation.path}</span>
            <code className="assistant-panel__patch-before">
              {JSON.stringify(preview[index]?.before ?? null)}
            </code>
            <code className="assistant-panel__patch-after">
              {operation.op === "remove" ? "null" : JSON.stringify(operation.value)}
            </code>
          </li>
        ))}
      </ul>
      {action.patch.warnings?.map((warning) => (
        <p key={warning} className="assistant-panel__warning">
          {warning}
        </p>
      ))}
      {error !== null ? (
        <p className="assistant-panel__error">
          {t(`assistant.applyErrors.${error}`, {
            defaultValue: t("assistant.applyFailed"),
          })}
        </p>
      ) : null}
      <button
        type="button"
        className="btn btn--primary command-form__action"
        onClick={onApply}
        disabled={!canApply || applied || isGenerating}
      >
        {applied ? t("assistant.applied") : t("assistant.apply")}
      </button>
    </div>
  );
}

/**
 * A failed apply auto-sends a technical retry request as a user message. Its
 * full text (validation rules + failed patch JSON) is noise for most reads,
 * so it collapses behind the localized apply error with a disclosure chevron.
 */
function PatchRetryMessage({ text }: { text: string }): ReactElement {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const applyError = /APPLY_ERROR: (\w+)/.exec(text)?.[1] ?? "applyFailed";

  return (
    <>
      <button
        type="button"
        className="assistant-panel__retry-toggle"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span className="assistant-panel__retry-title">
          {t(`assistant.applyErrors.${applyError}`, {
            defaultValue: t("assistant.applyErrors.applyFailed"),
          })}
        </span>
        <span
          className={`assistant-panel__retry-chevron${isOpen ? " is-open" : ""}`}
          aria-hidden="true"
        >
          <ChevronIcon />
        </span>
      </button>
      {isOpen ? <MarkdownMessage text={text} /> : null}
    </>
  );
}
