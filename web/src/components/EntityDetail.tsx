// Entity detail modal (F4/F5) — read-only command/workflow preview + run.
//
// Fetches the full record via the B1 detail endpoints and renders it in the
// shared DetailModal frame. View + run only: no edit/delete. The command body
// shows shell, timeout, script, and the variables list (sensitive values
// masked server-side); the workflow body shows a read-only step list (the web
// app has no reactflow canvas). Run hands off to the run-prompt flow, which
// collects any declared variables before firing.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, getCommand, getWorkflow } from "../api/client";
import type {
  ApiEntitySummary,
  CommandDetail,
  VariableSpec,
  WorkflowDetail,
} from "../api/types";
import { entityRef } from "../api/types";
import { DetailModal } from "./DetailModal";

interface EntityDetailProps {
  /** The entity to show, or null when closed. */
  entity: ApiEntitySummary | null;
  onClose: () => void;
  /** Begin the run flow for this entity (variable prompt → fire). */
  onRun: (entity: ApiEntitySummary, variables?: VariableSpec[]) => void;
}

export function EntityDetail({
  entity,
  onClose,
  onRun,
}: EntityDetailProps): React.JSX.Element | null {
  const { t } = useTranslation();
  const [command, setCommand] = useState<CommandDetail | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!entity) {
      setCommand(null);
      setWorkflow(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCommand(null);
    setWorkflow(null);
    const ref = entityRef(entity);
    const fetcher =
      entity.kind === "command"
        ? getCommand(ref).then((c) => {
            if (!cancelled) setCommand(c);
          })
        : getWorkflow(ref).then((w) => {
            if (!cancelled) setWorkflow(w);
          });
    fetcher
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.code : "unknown");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entity]);

  if (!entity) return null;

  const runLabel = entity.kind === "command" ? t("common.run") : t("workflow.run");
  const variables = command?.variables ?? [];

  return (
    <DetailModal
      title={entity.name}
      ariaLabel={entity.name}
      runLabel={runLabel}
      onRun={() => onRun(entity, variables)}
      onClose={onClose}
      description={command?.description ?? workflow?.description}
      meta={
        <>
          {command?.shell ? (
            <span className="shell-badge">{command.shell}</span>
          ) : null}
          {workflow ? (
            <span className="shell-badge">
              {t("workflow.nodeCount", {
                count: workflow.nodes.length,
                defaultValue: "{{count}} steps",
              })}
            </span>
          ) : null}
          {(command?.tags ?? workflow?.tags ?? []).map((tag) => (
            <span key={tag} className="tag-chip">
              {tag}
            </span>
          ))}
        </>
      }
    >
      {loading ? (
        <p className="command-view__value command-view__value--muted" role="status">
          {t("common.loading", "Loading…")}
        </p>
      ) : error ? (
        <p className="command-view__value command-view__value--muted" role="alert">
          {t("web.error.load", "Could not load. Check your connection.")}
        </p>
      ) : command ? (
        <CommandBody command={command} />
      ) : workflow ? (
        <WorkflowBody workflow={workflow} />
      ) : null}
    </DetailModal>
  );
}

function CommandBody({ command }: { command: CommandDetail }): React.JSX.Element {
  const { t } = useTranslation();
  const variables = command.variables ?? [];
  return (
    <>
      <section className="command-view__field">
        <h3 className="command-view__label">
          {t("commandForm.fields.timeoutSeconds")}
        </h3>
        <p className="command-view__value">
          {command.timeoutSeconds !== undefined
            ? t("commandView.timeoutValue", { count: command.timeoutSeconds })
            : t("commandView.noTimeout")}
        </p>
      </section>

      <section className="command-view__field">
        <h3 className="command-view__label">{t("commandForm.fields.script")}</h3>
        <pre className="command-view__script">{command.script}</pre>
      </section>

      <section className="command-view__field">
        <h3 className="command-view__label">
          {t("commandForm.variables.title")}
        </h3>
        {variables.length === 0 ? (
          <p className="command-view__value command-view__value--muted">
            {t("commandView.noVariables")}
          </p>
        ) : (
          <ul className="command-view__var-list">
            {variables.map((spec) => (
              <VariableRow key={spec.name} spec={spec} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function VariableRow({ spec }: { spec: VariableSpec }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <li className="command-view__var">
      <div className="command-view__var-head">
        <code className="command-view__var-name">{spec.name}</code>
        {spec.sensitive ? (
          <span className="shell-badge command-view__var-sensitive">
            {t("commandForm.variables.sensitive")}
          </span>
        ) : null}
      </div>
      <p className="command-view__var-default">
        {spec.sensitive
          ? t("commandView.sensitiveValue")
          : spec.defaultValue !== undefined
            ? t("commandView.defaultValue", { value: spec.defaultValue })
            : t("commandForm.variables.promptAtRuntime")}
      </p>
      {spec.description ? (
        <p className="command-view__var-desc">{spec.description}</p>
      ) : null}
    </li>
  );
}

function WorkflowBody({
  workflow,
}: {
  workflow: WorkflowDetail;
}): React.JSX.Element {
  const { t } = useTranslation();
  // Skip the synthetic start/end markers — show the meaningful steps only.
  const steps = workflow.nodes.filter(
    (n) => n.kind !== "start" && n.kind !== "end",
  );
  return (
    <section className="command-view__field">
      <h3 className="command-view__label">
        {t("web.detail.steps", "Steps")}
      </h3>
      {steps.length === 0 ? (
        <p className="command-view__value command-view__value--muted">
          {t("web.detail.noSteps", "No steps.")}
        </p>
      ) : (
        <ol className="command-view__var-list">
          {steps.map((node) => (
            <li key={node.id} className="command-view__var">
              <div className="command-view__var-head">
                <code className="command-view__var-name">
                  {node.label ?? node.kind}
                </code>
                <span className="shell-badge">{node.kind}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
