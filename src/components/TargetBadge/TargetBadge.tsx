// Small "where does this run" badge for a command's execution target.
//
// Renders the localized `.target-badge` chip (e.g. "Remote: prod") for any
// non-local target, and nothing at all for a local one. Centralises the
// `isRemoteTarget(target) ? <span className="target-badge">…</span> : null`
// pattern that previously repeated across the library tile, command view,
// history row, console, and workflow inspector.
//
// Reuses the shared `.target-badge` class (see theme.css); no new styling.

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import type { ExecutionTarget } from "../../types";
import { formatTargetBadge, isRemoteTarget } from "../../utils/targetLabel";

interface TargetBadgeProps {
  /** The command's execution target. `undefined` means local (no badge). */
  target: ExecutionTarget | undefined;
}

export function TargetBadge({ target }: TargetBadgeProps): ReactElement | null {
  const { t } = useTranslation();
  if (!isRemoteTarget(target)) return null;
  return <span className="target-badge">{formatTargetBadge(target, t)}</span>;
}
