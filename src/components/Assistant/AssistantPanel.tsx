import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent, ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import {
  CancelIcon,
  ChevronIcon,
  SendIcon,
  SidebarToggleIcon,
  SpinnerIcon,
  TrashIcon,
  UserIcon,
} from "../icons";
import { Dropdown } from "../Dropdown/Dropdown";
import { useContextMenu } from "../ContextMenu";
import { MarkdownMessage } from "./MarkdownMessage";
import { ConfirmDialog } from "../ConfirmDialog";

import { useAssistantStore } from "../../stores/assistantStore";
import type {
  AssistantChatMessage,
  AssistantObjectContext,
  AssistantPatch,
  AssistantRunSnapshot,
  AssistantRunAccess,
  AssistantTarget,
} from "../../types/assistant";
import {
  getAssistantSettings,
  getAssistantRunAccess,
  setAssistantRunAccess,
} from "../../services/assistantService";
import { previewAssistantPatch } from "../../utils/assistantPatches";
import { buildAssistantRunSnapshotPrompt } from "../../utils/assistantRunPrompt";
import {
  copyText,
  getSelectionWithin,
  selectAllWithin,
} from "../../utils/consoleClipboard";
import {
  buildAssistantPatchRetryPrompt,
  type AssistantPatchFeedbackError,
} from "../../utils/assistantPatchFeedback";
import { loadPanelPlacement, savePanelPlacement } from "../../utils/assistantPanelPlacement";

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
  /** Stable identity for persisted chat/placement; defaults to target:id. */
  sessionKey?: string;
  /** `embedded` renders the panel in place instead of as a fixed app rail. */
  variant?: "editor" | "embedded";
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
  variant = "editor",
  sessionKey: requestedSessionKey,
}: AssistantPanelProps): ReactElement {
  const resolvedSessionKey =
    requestedSessionKey ?? `${target}:${objectId ?? "draft"}`;
  const placement = loadPanelPlacement(resolvedSessionKey);
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const { show } = useContextMenu();
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const session = useAssistantStore((state) => state.session);
  const startSession = useAssistantStore((state) => state.startSession);
  const sendMessage = useAssistantStore((state) => state.sendMessage);
  const retryLastMessage = useAssistantStore(
    (state) => state.retryLastMessage,
  );
  const cancelSession = useAssistantStore((state) => state.cancelSession);
  const [appliedMessageId, setAppliedMessageId] = useState<string | null>(null);
  const [applyError, setApplyError] =
    useState<AssistantPatchFeedbackError | null>(null);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const [snapshotPreviewOpen, setSnapshotPreviewOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(
    !(defaultExpanded || placement.isExpanded),
  );
  const setRunSnapshot = useAssistantStore((state) => state.setRunSnapshot);
  const [runAccess, setRunAccess] = useState<AssistantRunAccess | null>(null);
  const [globalRunAllowed, setGlobalRunAllowed] = useState<boolean | null>(null);
  const [isSavingRunAccess, setIsSavingRunAccess] = useState(false);
  const supportsRunAccess =
    (target === "command" || target === "workflow") && objectId !== null;

  useEffect(() => {
    startSession(target, objectId, draftVersion, resolvedSessionKey);
  }, [
    draftVersion,
    objectId,
    resolvedSessionKey,
    startSession,
    target,
  ]);
  const clearSession = useAssistantStore((state) => state.clearSession);

  useEffect(() => {
    savePanelPlacement(resolvedSessionKey, {
      isExpanded: !isCollapsed,
      width: null,
    });
  }, [isCollapsed, resolvedSessionKey]);

  useEffect(() => {
    if (!supportsRunAccess || objectId === null) {
      setRunAccess(null);
      setGlobalRunAllowed(null);
      return;
    }

    let isSubscribed = true;
    void Promise.all([
      getAssistantSettings(),
      getAssistantRunAccess(target, objectId),
    ])
      .then(([settings, access]) => {
        if (!isSubscribed) return;
        setGlobalRunAllowed(settings.allowRunSnapshots);
        setRunAccess(access);
      })
      .catch(() => {
        if (!isSubscribed) return;
        setGlobalRunAllowed(false);
        setRunAccess("inherit");
      });

    return () => {
      isSubscribed = false;
    };
  }, [objectId, supportsRunAccess, target]);

  useEffect(() => {
    const element = composerInputRef.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [draft, isCollapsed, session?.isGenerating]);

  const clearChat = (): void => {
    setDraft("");
    setAppliedMessageId(null);
    setApplyError(null);
    clearSession();
    setIsClearConfirmOpen(false);
  };

  const changeRunAccess = (value: string): void => {
    const access =
      value === "allow" || value === "deny" ? value : "inherit";
    if (!supportsRunAccess || objectId === null || isSavingRunAccess) return;
    setIsSavingRunAccess(true);

    void setAssistantRunAccess(target, objectId, access)
      .then(() => setRunAccess(access))
      .catch(() => {
        Message.error(t("assistant.access.saveError"));
      })
      .finally(() => {
        setIsSavingRunAccess(false);
      });
  };

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

  const sendRunSnapshot = (): void => {
    if (runSnapshot == null || session?.isGenerating) return;
    void sendMessage(
      context,
      buildAssistantRunSnapshotPrompt(runSnapshot, {
        status: t("assistant.run.promptStatus"),
        duration: t("assistant.run.promptDuration"),
        request: t("assistant.run.prompt"),
        exit: t("assistant.run.promptExit", {
          code: runSnapshot.exitCode ?? "?",
        }),
        stdout: t("assistant.run.stdoutLabel"),
        stderr: t("assistant.run.stderrLabel"),
        truncated: t("assistant.run.promptTruncated"),
      }),
      { attachedRunSnapshot: runSnapshot },
    );
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
      <aside
        className={`assistant-panel assistant-panel--collapsed${
          variant === "embedded" ? " assistant-panel--embedded" : ""
        }`}
        role="region"
        aria-label={title}
      >
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
    <aside
      className={`assistant-panel${
        variant === "embedded" ? " assistant-panel--embedded" : ""
      }`}
      role="region"
      aria-label={title}
    >
      <header className="assistant-panel__header">
        <div>
          <p className="assistant-panel__eyebrow">{t("assistant.title")}</p>
          <h2 className="assistant-panel__title">{title}</h2>
        </div>
        <div className="assistant-panel__header-actions">
          {supportsRunAccess && objectId !== null ? (
            <Dropdown
              value={runAccess ?? "inherit"}
              className={`assistant-panel__access${
                runAccess === "allow" ||
                (runAccess === "inherit" && globalRunAllowed === true)
                  ? " is-allowed"
                  : " is-denied"
              }`}
              popupClassName="run-assistant__access-popup"
              popupAlign="end"
              popupTitle={t("assistant.access.title")}
              popupSubtitle={t("assistant.access.section")}
              ariaLabel={t("assistant.access.ariaLabel")}
              triggerTitle={t("assistant.access.tooltip")}
              triggerIcon={<UserIcon />}
              disabled={runAccess === null || isSavingRunAccess}
              onChange={changeRunAccess}
              options={[
                {
                  value: "inherit",
                  label: t(
                    globalRunAllowed === true
                      ? "assistant.access.systemAllowed"
                      : "assistant.access.systemDenied",
                  ),
                },
                { value: "allow", label: t("assistant.access.allow") },
                { value: "deny", label: t("assistant.access.deny") },
              ]}
            />
          ) : null}
          <button
            type="button"
            className="assistant-panel__clear-chat"
            onClick={() => setIsClearConfirmOpen(true)}
            disabled={session?.isGenerating === true}
            aria-label={t("assistant.clearChat")}
            title={t("assistant.clearChat")}
          >
            <TrashIcon />
          </button>
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
        </div>
      </header>

      {runSnapshot ? (
        <section className="assistant-panel__run" aria-label={t("assistant.run.title")}>
          <div className="assistant-panel__run-summary">
            <strong>{t("assistant.run.title")}</strong>
            <span>
              {t("assistant.run.exit", { code: runSnapshot.exitCode ?? "?" })}
            </span>
            {runSnapshot.status !== undefined ? (
              <span>
                {t("assistant.run.status", { status: runSnapshot.status })}
              </span>
            ) : null}
            {runSnapshot.durationMs !== undefined ? (
              <span>
                {t("assistant.run.duration", {
                  duration: runSnapshot.durationMs,
                })}
              </span>
            ) : null}
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
              onClick={sendRunSnapshot}
              disabled={session?.isGenerating === true}
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
          <div className="assistant-panel__error-row" role="alert">
            <p className="assistant-panel__error selectable">
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
            <button
              type="button"
              className="btn btn--ghost"
              disabled={session.isGenerating}
              onClick={() => void retryLastMessage(context)}
            >
              {t("common.retry")}
            </button>
          </div>
        ) : null}
      </div>

      <footer className="assistant-panel__composer">
        <div
          className={`assistant-panel__composer-field${
            session?.isGenerating ? " is-generating" : ""
          }`}
        >
          <textarea
            ref={composerInputRef}
            className="input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("assistant.placeholder")}
            aria-label={t("assistant.composerLabel")}
            rows={1}
          />
          {session?.isGenerating ? (
            <button
              type="button"
              className="assistant-panel__cancel"
              onClick={() => void cancelSession()}
              aria-label={t("common.cancel")}
              title={t("common.cancel")}
            >
              <CancelIcon />
            </button>
          ) : null}
          {draft.trim() !== "" ? (
            <button
              type="button"
              className="assistant-panel__send"
              onClick={submit}
              disabled={session?.isGenerating}
              aria-label={t("assistant.send")}
              title={`${t("assistant.send")} — ${t("assistant.sendHint")}`}
            >
              <SendIcon />
            </button>
          ) : null}
        </div>
      </footer>
      <ConfirmDialog
        open={isClearConfirmOpen}
        title={t("assistant.clearChatTitle")}
        message={t("assistant.clearChatMessage")}
        confirmLabel={t("common.clear")}
        danger
        onConfirm={clearChat}
        onCancel={() => setIsClearConfirmOpen(false)}
      />
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
