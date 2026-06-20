import type { ReactElement } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import {
  parallelBranchIndices,
  type WorkflowNodeData,
} from "../../../utils/workflowGraph";
import { insertNeighborClass, runStatusClass } from "./runStatus";

/**
 * A fork node that fans execution out into N concurrent branches: one source
 * handle per branch (id `branch:<n>`). The handle ids ARE the branch labels, so
 * the graph converter reads `sourceHandle` directly as the `WorkflowEdge.branch`.
 *
 * The rendered handle count is driven by the node's OWN `data.parallelBranchCount`
 * (the wired-branch count, see `parallelBranchCount`), NOT the global edge
 * store: one handle per wired `branch:<n>` slot plus a single trailing free
 * handle to drag the next branch from (see `parallelBranchIndices`). Reading
 * from data means the handles exist at first paint, so a saved fork's
 * `branch:<n>` edges render immediately — reading the store instead is empty at
 * mount and leaves those edges (and thus the branches) unrendered. The canvas
 * keeps `parallelBranchCount` in sync as branches are wired/unwired.
 *
 * Each branch's CAPTION sits on the same vertical center as its output handle:
 * caption and handle share one absolute `top` (`(slot+1)/(slots+1)`), instead
 * of the caption flowing in a separate column — so labels line up exactly with
 * their handles. Wired branches read "Ветка 1/2/…" by slot order; the trailing
 * free slot reads "Новая ветка".
 */
export function ParallelNode({
  data,
}: NodeProps<Node<WorkflowNodeData>>): ReactElement {
  const { t } = useTranslation();
  // Derive the rendered slots from the node's own wired-branch count: one
  // handle per wired branch (so every saved `branch:<n>` edge has its handle)
  // plus one trailing free slot. Defaults to 0 (a fresh fork → just the free
  // "Новая ветка" handle) when the count is not yet stamped.
  const indices = parallelBranchIndices(data.parallelBranchCount ?? 0);
  const slots = indices.length;

  // Grow the node with the slot count so caption rows never overlap each other
  // or the title. `HEADER` reserves vertical space for the kind + title; each
  // slot then occupies a `SLOT_HEIGHT` band BELOW that header. A slot's handle
  // and caption share one absolute `top` at the center of its band, so they
  // always sit beneath the title (never between "Параллель" and its count) —
  // including the empty-fork case where the only slot is "Новая ветка".
  const SLOT_HEIGHT = 24;
  const HEADER = 52;
  const minHeight = HEADER + slots * SLOT_HEIGHT;
  const slotTop = (slot: number): number =>
    HEADER + slot * SLOT_HEIGHT + SLOT_HEIGHT / 2;

  return (
    <div
      className={`wf-node wf-node--parallel${runStatusClass(
        data.runStatus,
      )}${insertNeighborClass(data.insertNeighbor)}`}
      style={{ minHeight }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="wf-node__kind">{t("editor.nodes.parallel")}</div>
      <div className="wf-node__title">
        {t("editor.nodes.parallelBranches", { count: slots - 1 })}
      </div>
      {indices.map((branchIndex, slot) => {
        // The last slot is always the trailing free handle (see
        // parallelBranchIndices) → "Новая ветка". Earlier slots are wired
        // branches, numbered by their slot order.
        const isFreeSlot = slot === slots - 1;
        return (
          <span
            key={`label:${branchIndex}`}
            className={`wf-branch-label wf-branch-label--row${
              isFreeSlot ? " wf-branch-label--new" : ""
            }`}
            style={{ top: slotTop(slot) }}
          >
            {isFreeSlot
              ? t("editor.nodes.newBranch")
              : t("editor.nodes.branchSlot", { n: slot + 1 })}
          </span>
        );
      })}
      {indices.map((branchIndex, slot) => (
        <Handle
          key={branchIndex}
          type="source"
          position={Position.Right}
          id={`branch:${branchIndex}`}
          style={{ top: slotTop(slot) }}
        />
      ))}
    </div>
  );
}
