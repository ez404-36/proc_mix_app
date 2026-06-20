import type { NodeTypes } from "@xyflow/react";
import { StartNode } from "./StartNode";
import { CommandNode } from "./CommandNode";
import { ConditionNode } from "./ConditionNode";
import { SwitchNode } from "./SwitchNode";
import { LoopNode } from "./LoopNode";
import { TryNode } from "./TryNode";
import { DataNode } from "./DataNode";
import { ParserNode } from "./ParserNode";
import { TextNode } from "./TextNode";
import { ParallelNode } from "./ParallelNode";
import { JoinNode } from "./JoinNode";
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
  switch: SwitchNode,
  loop: LoopNode,
  try: TryNode,
  data: DataNode,
  parser: ParserNode,
  text: TextNode,
  parallel: ParallelNode,
  join: JoinNode,
  end: EndNode,
};

export {
  StartNode,
  CommandNode,
  ConditionNode,
  SwitchNode,
  LoopNode,
  TryNode,
  DataNode,
  ParserNode,
  TextNode,
  ParallelNode,
  JoinNode,
  EndNode,
};
