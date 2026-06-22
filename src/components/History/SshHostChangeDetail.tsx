import { type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { SshHostSnapshot } from "../../types";

interface SshHostChangeDetailProps {
  before: SshHostSnapshot;
  after: SshHostSnapshot;
}

/** A single changed field row, in `Field: old > new` form. */
interface FieldChange {
  label: string;
  before: string;
  after: string;
}

/** Render an optional value for display; an unset value shows as an em-dash. */
function show(value: string | number | null): string {
  if (value === null || value === "") return "—";
  return String(value);
}

/**
 * Collect the modelled-field changes between two snapshots. Only fields that
 * actually differ are returned. Labels are the literal ssh_config directive
 * names (Host/HostName/User/Port/IdentityFile) — not translated — to match the
 * connection form.
 */
function fieldChanges(before: SshHostSnapshot, after: SshHostSnapshot): FieldChange[] {
  const changes: FieldChange[] = [];
  const push = (label: string, b: string | number | null, a: string | number | null): void => {
    if (show(b) !== show(a)) changes.push({ label, before: show(b), after: show(a) });
  };
  push("Host", before.name, after.name);
  push("HostName", before.hostName, after.hostName);
  push("User", before.user, after.user);
  push("Port", before.port, after.port);
  push("IdentityFile", before.identityFile, after.identityFile);
  return changes;
}

/**
 * Detail body for an SSH `edited` / `editedExternally` history event,
 * rendered inside the row's `<details>` disclosure (mirroring how
 * `ScheduledRunOutput` reveals captured output). Shows each changed modelled
 * field as `Field: old > new`, plus the full new block when the raw text
 * changed beyond the modelled fields (e.g. comments / unmodelled directives).
 */
export function SshHostChangeDetail({
  before,
  after,
}: SshHostChangeDetailProps): ReactElement {
  const { t } = useTranslation();
  const changes = fieldChanges(before, after);
  const rawChanged = before.rawText !== after.rawText;

  return (
    <div className="ssh-host-change">
      {changes.length > 0 ? (
        <dl className="ssh-host-change__fields">
          {changes.map((c) => (
            <div key={c.label} className="ssh-host-change__row">
              <dt className="ssh-host-change__field">{c.label}</dt>
              <dd className="ssh-host-change__values">
                <span className="ssh-host-change__old">{c.before}</span>
                <span className="ssh-host-change__arrow" aria-hidden="true">
                  {" > "}
                </span>
                <span className="ssh-host-change__new">{c.after}</span>
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="form-hint">
          {t("history.ssh.noModelledFieldChanges", {
            defaultValue: "No changes to the standard fields.",
          })}
        </p>
      )}

      {rawChanged && (
        <details className="ssh-host-change__raw">
          <summary>
            {t("history.ssh.fullBlock", { defaultValue: "Full block (new)" })}
          </summary>
          <pre className="ssh-host-change__raw-pre">{after.rawText}</pre>
        </details>
      )}
    </div>
  );
}
