import type { NodeTypes } from "reactflow";
import { StartNode } from "./StartNode";
import { CommandNode } from "./CommandNode";
import { ConditionNode } from "./ConditionNode";
import { EndNode } from "./EndNode";

/**
 * Custom-node registry, keyed by `WorkflowNodeKind`. Defined ONCE at module
 * scope: reactflow treats a fresh `nodeTypes` object on every render as a
 * change and re-mounts every node (with a console warning), so this MUST be
 * a stable reference. The kind strings here match `node.type` produced by
 * `workflowToFlow` / `makeInitialFlow`.
 */
export const workflowNodeTypes: NodeTypes = {
  start: StartNode,
  command: CommandNode,
  condition: ConditionNode,
  end: EndNode,
};

export { StartNode, CommandNode, ConditionNode, EndNode };
