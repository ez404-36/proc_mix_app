import type { WorkflowNodeData } from "../../../utils/workflowGraph";

/**
 * Map a node's live-run status to a CSS modifier suffix appended to the
 * `wf-node` class. Returns an empty string when the node has no run state
 * (the static, not-currently-running case). Kept tiny and shared so every
 * node component highlights identically.
 */
export function runStatusClass(
  status: WorkflowNodeData["runStatus"],
): string {
  switch (status) {
    case "running":
      return " is-running";
    case "finished":
      return " is-finished";
    case "pending":
    case undefined:
    default:
      return "";
  }
}

/**
 * Modifier suffix marking a node as one of the two neighbours a dragged
 * command would be inserted between (see `markInsertNeighbors`). Shared so
 * every node kind renders the same insertion-highlight border.
 */
export function insertNeighborClass(insertNeighbor: boolean | undefined): string {
  return insertNeighbor === true ? " is-insert-neighbor" : "";
}
