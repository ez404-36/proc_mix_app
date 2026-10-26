import { useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import {
  CancelIcon,
  SendIcon,
  SidebarToggleIcon,
  SpinnerIcon,
  TrashIcon,
  UserIcon,
} from "../icons";
import { Dropdown } from "../Dropdown/Dropdown";
import { MarkdownMessage } from "../Assistant/MarkdownMessage";
import { ConfirmDialog } from "../ConfirmDialog";
import {
  getAssistantSettings,
  getAssistantRunAccess,
  cancelAssistantGeneration,
  generateAssistantResponse,
  setAssistantRunAccess,
} from "../../services/assistantService";
import type {
  AssistantChatMessage,
  AssistantRunAccess,
  AssistantSettings,
  AssistantSessionError,
} from "../../types/assistant";
import type { ExecutionRunAssistant } from "../../utils/executionRunAssistant";
import {
  allowRunSnapshotSubject,
  denyRunSnapshotRun,
  resolveRunSnapshotConsent,
} from "../../utils/runAssistantConsent";
import {
  clearRunAssistantSession,
  loadRunAssistantSession,
  saveRunAssistantSession,
} from "../../utils/runAssistantSessions";

interface RunAssistantPanelProps {
  assistant: ExecutionRunAssistant | null;
  title: string;
  /** Stable cache scope: `execution:<id>` or `history:<eventId>`. */
  sessionKey: string;
}

function messageId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `run-assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type AssistantBackendErrorCode =
  | "disabled"
  | "notConfigured"
  | "authFailed"
  | "network"
  | "timeout"
  | "provider"
  | "invalidAssistantResponse"
  | "inputTooLarge"
  | "runSnapshotsDisabled"
  | "runSnapshotObjectDenied";

const ASSISTANT_ERROR_CODES: Record<string, AssistantBackendErrorCode> = {
  ASSISTANT_DISABLED: "disabled",
  ASSISTANT_NOT_CONFIGURED: "notConfigured",
  ASSISTANT_AUTH_FAILED: "authFailed",
  ASSISTANT_NETWORK: "network",
  ASSISTANT_TIMEOUT: "timeout",
  ASSISTANT_PROVIDER: "provider",
  ASSISTANT_INVALID_RESPONSE: "invalidAssistantResponse",
  ASSISTANT_INPUT_TOO_LARGE: "inputTooLarge",
  ASSISTANT_RUN_SNAPSHOTS_DISABLED: "runSnapshotsDisabled",
  ASSISTANT_RUN_SNAPSHOT_DENIED_FOR_OBJECT: "runSnapshotObjectDenied",
};

const MIN_RUN_ASSISTANT_WIDTH = 260;

type RunConsentDecision = "unknown" | "allowed" | "denied";

function errorToSessionError(error: unknown): AssistantSessionError {
  if (typeof error === "string") {
    const providerHttp = /^ASSISTANT_PROVIDER_HTTP_(\d{3})$/.exec(error);
    if (providerHttp !== null) {
      return { kind: "providerHttp", status: Number(providerHttp[1]) };
    }
    const matched = Object.keys(ASSISTANT_ERROR_CODES).find((code) =>
      error.startsWith(code),
    );
    if (matched !== undefined) {
      return ASSISTANT_ERROR_CODES[matched];
    }
  }
  if (
    error instanceof Error &&
    error.message === "ASSISTANT_INPUT_TOO_LARGE"
  ) {
    return "inputTooLarge";
  }
  return "invalidResponse";
}

function ErrorText({
  error,
}: {
  error: AssistantSessionError;
}): ReactElement {
  const { t } = useTranslation();
  if (typeof error === "string") {
    return <>{t(`assistant.errors.${error}`)}</>;
  }
  if (error.kind === "providerHttp") {
    return (
      <>
        {error.status === 429
          ? t("assistant.errors.rateLimited")
          : t("assistant.errors.providerHttp", { status: error.status })}
      </>
    );
  }
  if (error.kind === "contract") {
    return (
      <>
        {t("assistant.contractIssues", {
          issue: t(`assistant.contractIssues.${error.issue}`),
        })}
      </>
    );
  }
  return <>{t("assistant.backendCode", { code: error.code })}</>;
}

function clampAssistantWidth(width: number, maxWidth: number): number {
  return Math.min(
    Math.max(width, MIN_RUN_ASSISTANT_WIDTH),
    Math.max(MIN_RUN_ASSISTANT_WIDTH, maxWidth),
  );
}

function assistantWidthLimits(aside: HTMLElement | null): {
  width: number;
  maxWidth: number;
} {
  const width = aside?.getBoundingClientRect().width ?? 360;
  const parentWidth = aside?.parentElement?.clientWidth ?? 720;
  return {
    width,
    maxWidth: Math.max(MIN_RUN_ASSISTANT_WIDTH, parentWidth - 180),
  };
}

function parseRunAccess(value: string): AssistantRunAccess | null {
  return value === "inherit" || value === "allow" || value === "deny"
    ? value
    : null;
}

export function RunAssistantPanel({
  assistant,
  title,
  sessionKey,
}: RunAssistantPanelProps): ReactElement {
  const { t } = useTranslation();
  const initialSession = loadRunAssistantSession(sessionKey);
  const [isExpanded, setIsExpanded] = useState(initialSession.isExpanded);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<AssistantChatMessage[]>(
    initialSession.messages,
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<AssistantSessionError | null>(null);
  const [allowAllRuns, setAllowAllRuns] = useState<boolean | null>(null);
  const [objectAccess, setObjectAccess] = useState<AssistantRunAccess | null>(
    null,
  );
  const [consent, setConsent] = useState<RunConsentDecision>("unknown");
  const [isSavingConsent, setIsSavingConsent] = useState(false);
  const [isClearConfirmOpen, setIsClearConfirmOpen] = useState(false);
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const isMountedRef = useRef(true);
  const hasInFlightRequestRef = useRef(false);
  const [width, setWidth] = useState<number | null>(initialSession.width);
  const resizeStateRef = useRef<{
    startX: number;
    startWidth: number;
    maxWidth: number;
  } | null>(null);

  useEffect(() => {
    const element = messagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [isExpanded, messages]);

  useEffect(() => {
    const element = composerInputRef.current;
    if (element === null) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
  }, [draft, isExpanded, isGenerating]);

  useEffect(() => {
    if (!isExpanded) return;
    let isSubscribed = true;

    Promise.all([
      getAssistantSettings(),
      assistant === null
        ? Promise.resolve<AssistantRunAccess>("inherit")
        : getAssistantRunAccess(assistant.target, assistant.objectId ?? ""),
    ])
      .then(([settings, access]: [AssistantSettings, AssistantRunAccess]) => {
        if (!isSubscribed) return;
        const allowAll = settings.allowRunSnapshots;
        setAllowAllRuns(allowAll);
        setObjectAccess(access);
        if (assistant === null) return;
        if (access === "inherit") {
          setConsent(
            resolveRunSnapshotConsent({
              allowAllRuns: allowAll,
              subjectKey: assistant.subjectKey,
              runId: assistant.runId,
            }),
          );
        } else {
          setConsent(access === "allow" ? "allowed" : "denied");
        }
      })
      .catch((settingsError: unknown) => {
        if (!isSubscribed) return;
        setAllowAllRuns(false);
        setObjectAccess("inherit");
        setConsent("denied");
        setError(errorToSessionError(settingsError));
      });

    return () => {
      isSubscribed = false;
    };
  }, [assistant, isExpanded]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (hasInFlightRequestRef.current) {
        void cancelAssistantGeneration();
      }
    };
  }, []);

  useEffect(() => {
    saveRunAssistantSession(sessionKey, { messages, isExpanded, width });
  }, [isExpanded, messages, sessionKey, width]);

  const clearChat = (): void => {
    setMessages([]);
    setDraft("");
    setError(null);
    clearRunAssistantSession(sessionKey);
    setIsClearConfirmOpen(false);
  };

  const submit = (): void => {
    const userMessage = draft.trim();
    const canReadSnapshot =
      objectAccess === "allow" ||
      (objectAccess === "inherit" &&
        (allowAllRuns === true || consent === "allowed"));
    if (
      userMessage === "" ||
      isGenerating ||
      assistant === null ||
      allowAllRuns === null ||
      objectAccess === null ||
      consent === "unknown"
    ) {
      return;
    }

    const user: AssistantChatMessage = {
      id: messageId(),
      role: "user",
      text: userMessage,
      createdAt: new Date().toISOString(),
    };
    const snapshot = canReadSnapshot
      ? (assistant.snapshot ?? undefined)
      : undefined;
    const context =
      snapshot === undefined
        ? {
            ...assistant.context,
            draft: {
              ...assistant.context.draft,
              runSnapshotAccess: "denied",
            },
          }
        : assistant.context;
    hasInFlightRequestRef.current = true;
    setMessages((current) => [...current, user]);
    setDraft("");
    setIsGenerating(true);
    setError(null);

    void generateAssistantResponse(
      {
        target: assistant.target,
        objectId: assistant.objectId,
        draftVersion: assistant.draftVersion,
        userMessage,
        ...(snapshot !== undefined
          ? { attachedRunSnapshotId: snapshot.id }
          : {}),
        ...(snapshot !== undefined && allowAllRuns !== true
          ? { runSnapshotConsent: true }
          : {}),
      },
      context,
      snapshot,
    )
      .then((response) => {
        hasInFlightRequestRef.current = false;
        if (!isMountedRef.current) return;
        setMessages((current) => [
          ...current,
          {
            id: response.messageId,
            role: "assistant",
            text: response.text,
            createdAt: new Date().toISOString(),
          },
        ]);
        setIsGenerating(false);
      })
      .catch((requestError: unknown) => {
        hasInFlightRequestRef.current = false;
        if (!isMountedRef.current) return;
        setError(errorToSessionError(requestError));
        setIsGenerating(false);
      });
  };

  const handleConsent = (
    decision: "allowed" | "allowObject" | "denied",
  ): void => {
    if (assistant === null || isSavingConsent) return;
    setIsSavingConsent(true);
    setError(null);

    const apply = async (): Promise<void> => {
      if (decision === "allowObject") {
        if (assistant === null) return;
        await setAssistantRunAccess(
          assistant.target,
          assistant.objectId ?? assistant.subjectKey,
          "allow",
        );
        setObjectAccess("allow");
        setConsent("allowed");
        return;
      }
      if (decision === "allowed") {
        allowRunSnapshotSubject(assistant.subjectKey);
        setConsent("allowed");
        return;
      }
      denyRunSnapshotRun(assistant.runId);
      setConsent("denied");
    };

    void apply()
      .catch((consentError: unknown) => {
        setError(errorToSessionError(consentError));
      })
      .finally(() => {
        setIsSavingConsent(false);
      });
  };

  const changeAccess = (value: string): void => {
    const access = parseRunAccess(value);
    if (
      access === null ||
      assistant === null ||
      objectAccess === null ||
      isSavingConsent
    ) {
      return;
    }
    setIsSavingConsent(true);
    setError(null);

    const apply = async (): Promise<void> => {
      await setAssistantRunAccess(
        assistant.target,
        assistant.objectId ?? assistant.subjectKey,
        access,
      );
      setObjectAccess(access);
      if (access === "allow") {
        setConsent("allowed");
      } else if (access === "deny") {
        setConsent("denied");
      } else {
        setConsent(
          resolveRunSnapshotConsent({
            allowAllRuns: allowAllRuns === true,
            subjectKey: assistant.subjectKey,
            runId: assistant.runId,
          }),
        );
      }
    };

    void apply()
      .catch((accessError: unknown) => {
        setError(errorToSessionError(accessError));
      })
      .finally(() => {
        setIsSavingConsent(false);
      });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const handleResizePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    event.preventDefault();
    const aside = event.currentTarget.parentElement;
    const limits = assistantWidthLimits(aside);
    resizeStateRef.current = {
      startX: event.clientX,
      startWidth: limits.width,
      maxWidth: limits.maxWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleResizePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const resizeState = resizeStateRef.current;
    if (resizeState === null) return;
    const nextWidth =
      resizeState.startWidth - (event.clientX - resizeState.startX);
    setWidth(clampAssistantWidth(nextWidth, resizeState.maxWidth));
  };

  const handleResizePointerEnd = (): void => {
    resizeStateRef.current = null;
  };

  const handleResizeKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const limits = assistantWidthLimits(event.currentTarget.parentElement);
    const currentWidth =
      width ?? limits.width;
    // For a left-edge handle, ArrowLeft grows the sidebar and ArrowRight
    // shrinks it — the edge follows the arrow direction.
    const nextWidth =
      event.key === "ArrowLeft" ? currentWidth + step : currentWidth - step;
    setWidth(clampAssistantWidth(nextWidth, limits.maxWidth));
  };

  const isConsentPending =
    objectAccess === null ||
    allowAllRuns === null ||
    (objectAccess === "inherit" &&
      allowAllRuns === false &&
      consent === "unknown");
  const isAccessAllowed =
    objectAccess === "allow" ||
    (objectAccess === "inherit" && allowAllRuns === true);

  if (!isExpanded) {
    return (
      <aside
        className="run-assistant run-assistant--collapsed"
        role="region"
        aria-label={title}
      >
        <button
          type="button"
          className="run-assistant__trigger"
          onClick={() => setIsExpanded(true)}
          aria-expanded={false}
          aria-label={t("outputPanel.runAssistant.open")}
          title={t("outputPanel.runAssistant.open")}
        >
          <span className="run-assistant__trigger-label" aria-hidden="true">
            AI
          </span>
          <span className="run-assistant__trigger-icon" aria-hidden="true">
            <SidebarToggleIcon />
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside
      className={`run-assistant${width !== null ? " run-assistant--resized" : ""}`}
      role="region"
      aria-label={title}
      style={
        width === null
          ? undefined
          : { flexBasis: `${width}px`, width: `${width}px` }
      }
    >
      <div
        className="run-assistant__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("outputPanel.runAssistant.resize")}
        tabIndex={0}
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
        onLostPointerCapture={handleResizePointerEnd}
        onKeyDown={handleResizeKeyDown}
      />
      <header className="run-assistant__header">
        <div>
          <p className="run-assistant__eyebrow">
            {t("outputPanel.runAssistant.title")}
          </p>
          <h2 className="run-assistant__name">{title}</h2>
        </div>
        <div className="run-assistant__header-actions">
          <Dropdown
            value={objectAccess ?? "inherit"}
            className={`run-assistant__access${
              isAccessAllowed ? " is-allowed" : " is-denied"
            }`}
            popupClassName="run-assistant__access-popup"
            popupAlign="end"
            popupTitle={t("outputPanel.runAssistant.access.title")}
            popupSubtitle={t("outputPanel.runAssistant.access.section")}
            ariaLabel={t("outputPanel.runAssistant.access.ariaLabel")}
            triggerTitle={t("outputPanel.runAssistant.access.tooltip")}
            triggerIcon={<UserIcon />}
            disabled={
              assistant === null ||
              assistant.objectId === null ||
              objectAccess === null ||
              isSavingConsent
            }
            onChange={changeAccess}
            options={[
              {
                value: "inherit",
                label: t(
                  allowAllRuns === true
                    ? "outputPanel.runAssistant.access.systemAllowed"
                    : "outputPanel.runAssistant.access.systemDenied",
                ),
              },
              { value: "allow", label: t("outputPanel.runAssistant.access.allow") },
              { value: "deny", label: t("outputPanel.runAssistant.access.deny") },
            ]}
          />
          <button
            type="button"
            className="run-assistant__clear"
            onClick={() => setIsClearConfirmOpen(true)}
            disabled={isGenerating}
            aria-label={t("outputPanel.runAssistant.clearChat")}
            title={t("outputPanel.runAssistant.clearChat")}
          >
            <TrashIcon />
          </button>
          <button
            type="button"
            className="run-assistant__collapse"
            onClick={() => setIsExpanded(false)}
            aria-expanded={true}
            aria-label={t("outputPanel.runAssistant.close")}
            title={t("outputPanel.runAssistant.close")}
          >
            <span className="run-assistant__trigger-icon" aria-hidden="true">
              <SidebarToggleIcon />
            </span>
          </button>
        </div>
      </header>

      <div ref={messagesRef} className="run-assistant__messages">
        {allowAllRuns === null ? (
          <div className="run-assistant__status" role="status">
            <span className="run-assistant__spinner" aria-hidden="true">
              <SpinnerIcon />
            </span>
            {t("outputPanel.runAssistant.consent.loading")}
          </div>
        ) : objectAccess === "inherit" &&
          allowAllRuns === false &&
          consent === "unknown" ? (
          <section className="run-assistant__consent" aria-live="polite">
            <h3>{t("outputPanel.runAssistant.consent.title")}</h3>
            <p>{t("outputPanel.runAssistant.consent.description")}</p>
            <div className="run-assistant__consent-actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={isSavingConsent}
                onClick={() => handleConsent("allowObject")}
              >
                {t("outputPanel.runAssistant.access.allow")}
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={isSavingConsent}
                onClick={() => handleConsent("denied")}
              >
                {t("outputPanel.runAssistant.consent.deny")}
              </button>
            </div>
          </section>
        ) : null}
        {objectAccess === "deny" ? (
          <section className="run-assistant__notice" role="note">
            <p>
              <strong>{t("outputPanel.runAssistant.objectDeniedTitle")}</strong>
            </p>
            <p>{t("outputPanel.runAssistant.objectDeniedHint")}</p>
          </section>
        ) : allowAllRuns === false && consent === "denied" ? (
          <p className="run-assistant__notice" role="note">
            {t("outputPanel.runAssistant.consent.deniedHint")}
          </p>
        ) : null}
        {messages.map((message) => (
          <article
            key={message.id}
            className={`run-assistant__message run-assistant__message--${message.role} selectable`}
          >
            <MarkdownMessage text={message.text} />
          </article>
        ))}
        {isGenerating ? (
          <div className="run-assistant__status" role="status">
            <span className="run-assistant__spinner" aria-hidden="true">
              <SpinnerIcon />
            </span>
            {t("assistant.thinking")}
          </div>
        ) : null}
        {error !== null ? (
          <div className="run-assistant__error-row" role="alert">
            <p className="run-assistant__error selectable">
              <ErrorText error={error} />
            </p>
            <button
              type="button"
              className="btn btn--ghost"
              disabled={isGenerating}
              onClick={() => setError(null)}
            >
              {t("common.close")}
            </button>
          </div>
        ) : null}
      </div>

      {isConsentPending ? null : (
        <footer className="run-assistant__composer">
	          <div
	            className={`run-assistant__composer-field${
	              isGenerating ? " is-generating" : ""
	            }`}
	          >
	            <textarea
	              ref={composerInputRef}
	              className="input"
	              value={draft}
	              onChange={(event) => setDraft(event.target.value)}
	              onKeyDown={onKeyDown}
	              placeholder={t("outputPanel.runAssistant.placeholder")}
	              aria-label={t("outputPanel.runAssistant.composerLabel")}
	              rows={1}
	            />
	            {isGenerating ? (
	              <button
	                type="button"
	                className="run-assistant__cancel"
	                onClick={() => void cancelAssistantGeneration()}
	                aria-label={t("common.cancel")}
	                title={t("common.cancel")}
	              >
	                <CancelIcon />
	              </button>
	            ) : null}
            {draft.trim() !== "" ? (
              <button
                type="button"
                className="run-assistant__send"
                onClick={submit}
                disabled={isGenerating}
                aria-label={t("assistant.send")}
                title={`${t("assistant.send")} — ${t("assistant.sendHint")}`}
              >
                <SendIcon />
              </button>
            ) : null}
          </div>
        </footer>
      )}
      <ConfirmDialog
        open={isClearConfirmOpen}
        title={t("outputPanel.runAssistant.clearChatTitle")}
        message={t("outputPanel.runAssistant.clearChatMessage")}
        confirmLabel={t("common.clear")}
        danger
        onConfirm={clearChat}
        onCancel={() => setIsClearConfirmOpen(false)}
      />
    </aside>
  );
}
