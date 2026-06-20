import type { ReactElement } from "react";
import { ControlButton, useReactFlow } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import { ZoomInIcon, ZoomOutIcon, FitViewIcon } from "../icons";

/**
 * The zoom-in / zoom-out / fit-view control buttons, shared by every reactflow
 * canvas (the editor and the read-only workflow-view preview). Localized
 * tooltips + app icons replace reactflow's hardcoded-English defaults, so the
 * three buttons look and read identically wherever a canvas is shown.
 *
 * Must be rendered inside `<ReactFlow>` (it calls `useReactFlow` for zoom/fit).
 * Callers wrap it in `<Controls>` and may add their own buttons (e.g. the
 * editor's lock / fullscreen toggles) alongside it.
 */
export function CanvasZoomControls(): ReactElement {
  const { t } = useTranslation();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <>
      <ControlButton
        onClick={() => zoomIn()}
        title={t("editor.controls.zoomIn")}
        aria-label={t("editor.controls.zoomIn")}
      >
        <ZoomInIcon />
      </ControlButton>
      <ControlButton
        onClick={() => zoomOut()}
        title={t("editor.controls.zoomOut")}
        aria-label={t("editor.controls.zoomOut")}
      >
        <ZoomOutIcon />
      </ControlButton>
      <ControlButton
        onClick={() => fitView()}
        title={t("editor.controls.fitView")}
        aria-label={t("editor.controls.fitView")}
      >
        <FitViewIcon />
      </ControlButton>
    </>
  );
}
