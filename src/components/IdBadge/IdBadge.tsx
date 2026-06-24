// Small "ID: <id>" line with a copy-to-clipboard button.
//
// Shown under the title in command/workflow cards and editor headers so a user
// can grab the stable UUID (e.g. to run the entity over the HTTP API by id when
// it has no slug — see docs/http-server.md). The id is otherwise not surfaced
// anywhere in the UI.
//
// Its own `id-badge__*` BEM family (see theme.css); the copy button reuses the
// shared `.btn--ghost .btn--icon` variant. Copying surfaces a success/failure
// toast via Arco's `Message` (the one Arco component used app-wide).

import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Message } from "@arco-design/web-react";
import { CopyIcon } from "../icons";

interface IdBadgeProps {
  /** The entity id (UUID) to display and copy. */
  id: string;
}

export function IdBadge({ id }: IdBadgeProps): ReactElement {
  const { t } = useTranslation();

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
      Message.success(t("idBadge.copied"));
    } catch {
      Message.error(t("idBadge.copyFailed"));
    }
  };

  return (
    <div className="id-badge">
      <span className="id-badge__label">
        {t("idBadge.label")}{" "}
        <code className="id-badge__value">{id}</code>
      </span>
      <button
        type="button"
        className="btn btn--ghost btn--icon id-badge__copy"
        onClick={() => void handleCopy()}
        aria-label={t("idBadge.copy")}
        title={t("idBadge.copy")}
      >
        <CopyIcon />
      </button>
    </div>
  );
}
