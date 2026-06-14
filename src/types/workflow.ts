// Workflow data model — the persisted graph an automation runs, plus
// the runtime event stream the backend emits while executing it.
//
// The shapes here are the UI-facing types (using `undefined` for absent
// optionals). The repository layer (`utils/workflowRepository.ts`,
// added in Phase 3) owns the `null` <-> `undefined` translation against
// the Rust `WorkflowRecord` wire format, exactly like `commandRepository`
// does for `Command`. The runtime event union mirrors `execution.ts`.

/**
 * Kind discriminator for a node in the workflow graph.
 *   - "start"     → unique entry node; exactly one per workflow. Has a
 *     single `out` edge.
 *   - "command"   → runs a referenced `Command` (by `commandId`). Picks
 *     its single `out` edge once the command finishes.
 *   - "condition" → runs its referenced command as a test, then branches:
 *     when a `condition` predicate is set it is evaluated, otherwise it
 *     falls back to the exit code (exit 0 → `then`, non-zero → `else`).
 *   - "switch"    → runs its command, then takes the first matching `case`
 *     edge (by its `condition`), or `default` when none match. (v0.7.0)
 *   - "loop"      → repeats its `body` subgraph a bounded number of times
 *     (count or while-condition), then takes `done`. (v0.7.0)
 *   - "try"       → runs its command with retries; `ok` on success, `catch`
 *     once retries are exhausted. (v0.7.0)
 *   - "data"      → pure transformation node: derives data-flow variables
 *     without spawning a process. (v0.7.0)
 *   - "end"       → terminal node; stops traversal. A workflow may have
 *     several end nodes (e.g. one per branch).
 *
 * The kinds tagged (v0.7.0) are the advanced-workflow additions; they
 * mirror the Rust `NodeKind` in `core/workflow.rs`. The storage layer keeps
 * `kind` a plain string, so adding a kind needs no DB migration.
 */
export type WorkflowNodeKind =
  | "start"
  | "command"
  | "condition"
  | "switch"
  | "loop"
  | "try"
  | "data"
  | "end";

/**
 * Branch label on an edge leaving a node. Mirrors the Rust `Branch` mapping
 * in `core/workflow.rs`:
 *   - `out`              → single exit (start / command / data nodes).
 *   - `then` / `else`    → the two exits of a `condition` node.
 *   - `case:${id}`       → a `switch` case, matched in declaration order.
 *   - `default`          → a `switch`'s fallback when no case matches.
 *   - `body` / `done`    → a `loop`'s iteration entry / completion exit.
 *   - `ok` / `catch`     → a `try`'s success / retries-exhausted exits.
 */
export type WorkflowEdgeBranch =
  | "out"
  | "then"
  | "else"
  | `case:${string}`
  | "default"
  | "body"
  | "done"
  | "ok"
  | "catch";

/**
 * What a {@link WorkflowCondition} compares against. Mirrors the Rust
 * `Subject` enum (`core/workflow_condition.rs`), serialised `{ kind, … }`.
 */
export type ConditionSubject =
  | { kind: "exitCode" }
  | { kind: "variable"; name: string }
  | { kind: "stdout" };

/** Comparison operator. Mirrors the Rust `Op` enum. */
export type ConditionOp = "eq" | "ne" | "contains" | "regex" | "gt" | "lt";

/**
 * A single predicate the runner evaluates to choose a branch. Used by
 * `condition` (optional — falls back to exit code when absent), `switch`
 * cases, and a `loop`'s while-guard. Mirrors the Rust `Condition` struct.
 */
export interface WorkflowCondition {
  subject: ConditionSubject;
  op: ConditionOp;
  /** Right-hand operand; the pattern source for `regex`. Defaults to "". */
  value: string;
}

/**
 * Bounded-iteration config for a `loop` node. Exactly one of `count` /
 * `while` drives termination; `maxIterations` is the hard safety cap the
 * runner enforces regardless (mirrors the Rust `LoopLimit`).
 */
export interface LoopConfig {
  /** Fixed iteration count. Mutually exclusive with `while`. */
  count?: number;
  /** Repeat while this predicate holds. Mutually exclusive with `count`. */
  while?: WorkflowCondition;
  /** Hard upper bound on iterations; the runner aborts past this. */
  maxIterations: number;
}

/**
 * Retry config for a `try` (or retrying `command`) node. `retries` is the
 * number of ADDITIONAL attempts after the first; `backoffMs` is the pause
 * between attempts. Mirrors the Rust retry handling.
 */
export interface RetryConfig {
  retries: number;
  backoffMs?: number;
}

/**
 * Where a `data` node assignment gets its value. A tagged union mirroring the
 * Rust `DataSourceRecord` (serialised `{ kind, … }`):
 *   - `manual`       → a literal / `${ref}`-templated string the user typed.
 *   - `rawOutput`    → the previous node's raw stdout (bounded tail).
 *   - `schemaOutput` → the prev node's FULL extracted output-schema result as
 *      one value (compact JSON of all fields); only offered when the prev
 *      command has a schema.
 *   - `exitCode`     → the previous node's process exit code.
 *   - `field`        → a single named output-schema field of the prev node.
 *   - `retryCount` → attempts a `try` predecessor made (1 = no retry).
 *   - `conditionResult` → "true"/"false": did a `condition` predecessor pass.
 *   - `matchedCase`     → the case id a `switch` predecessor took ("default"
 *      when none matched).
 *   - `loopIterations`  → completed iterations of a `loop` predecessor (count).
 * Every non-`manual` source reads from the node executed immediately before
 * this data node on the path that reached it (resolved at run time).
 */
export type DataSource =
  | { kind: "manual"; value: string }
  | { kind: "rawOutput" }
  | { kind: "schemaOutput" }
  | { kind: "exitCode" }
  | { kind: "field"; field: string }
  | { kind: "retryCount" }
  | { kind: "conditionResult" }
  | { kind: "matchedCase" }
  | { kind: "loopIterations" };

/**
 * One assignment performed by a `data` node: set the data-flow variable
 * `name` to a value pulled from `source`. Mirrors the Rust
 * `DataAssignmentRecord`.
 *
 * `value` is RETAINED for backward compatibility: pre-source records (and the
 * `manual` source) store the literal here, and `source` is omitted/`manual`.
 * When `source` is present and non-`manual`, `value` is ignored at run time.
 */
export interface DataAssignment {
  name: string;
  value: string;
  source?: DataSource;
}

/**
 * One case of a `switch` node: a predicate plus the id used to label its
 * outgoing edge (`case:${id}`). Evaluated in array order; the first match
 * wins, else the `default` edge is taken. Mirrors the Rust `SwitchCaseRecord`.
 */
export interface SwitchCase {
  id: string;
  condition: WorkflowCondition;
}

/**
 * A single node in the graph. `position` is canvas coordinates owned by
 * the visual editor (reactflow); the runner ignores it. `commandId` is
 * required for command-running kinds (`command` / `condition` / `switch` /
 * `try`) and absent for the rest — the editor validates this before save.
 */
export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  /** Reference to the `Command` this node runs. Command-running kinds only. */
  commandId?: string;
  /** Optional human label shown on the canvas; falls back to the kind. */
  label?: string;
  /**
   * Branch predicate for a `condition` node. When omitted, the node falls
   * back to exit-code branching (`then`/`else`), preserving MVP behaviour.
   */
  condition?: WorkflowCondition;
  /** Per-case predicates for a `switch` node, keyed by the case id used in
   * its `case:${id}` edge. Evaluated in insertion order. */
  cases?: SwitchCase[];
  /** Loop config for a `loop` node. */
  loop?: LoopConfig;
  /** Retry config for a `try` (or retrying `command`) node. */
  retry?: RetryConfig;
  /** Variable assignments performed by a `data` node, in order. */
  data?: DataAssignment[];
  /** Canvas coordinates for the visual editor. */
  position: { x: number; y: number };
}

/**
 * A directed edge connecting `source` → `target`. `branch` disambiguates
 * the two exits of a `condition` node; `out` is used for the single exit
 * of start / command nodes.
 */
export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  branch: WorkflowEdgeBranch;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  tags: string[];
  categoryId?: string;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  runCount: number;
}

export type WorkflowEventKind =
  | "nodeStarted"
  | "nodeFinished"
  | "branchTaken"
  | "loopIteration"
  | "nodeRetry"
  | "workflowFinished"
  | "workflowCancelled"
  | "workflowError";

export interface WorkflowEventBase {
  kind: WorkflowEventKind;
  /** Run id assigned when the workflow was triggered. */
  runId: string;
  workflowId: string;
}

export interface WorkflowNodeStartedEvent extends WorkflowEventBase {
  kind: "nodeStarted";
  nodeId: string;
  /**
   * For `command` nodes, the execution id of the underlying command run
   * (the same id carried on the `execution-event` channel) so the UI can
   * cross-link graph progress to the OutputPanel. Absent for non-command
   * nodes that perform no execution.
   */
  executionId?: string;
}

export interface WorkflowNodeFinishedEvent extends WorkflowEventBase {
  kind: "nodeFinished";
  nodeId: string;
  /** Exit code of the node's command, or null when not applicable. */
  exitCode: number | null;
}

export interface WorkflowBranchTakenEvent extends WorkflowEventBase {
  kind: "branchTaken";
  /** The condition / switch / loop node whose branch was selected. */
  nodeId: string;
  branch: WorkflowEdgeBranch;
  /** The edge id that was followed. */
  edgeId: string;
}

export interface WorkflowLoopIterationEvent extends WorkflowEventBase {
  kind: "loopIteration";
  /** The loop node entering its body. */
  nodeId: string;
  /** 1-based iteration number (the first body entry is 1). */
  iteration: number;
}

export interface WorkflowNodeRetryEvent extends WorkflowEventBase {
  kind: "nodeRetry";
  /** The try node about to retry its command. */
  nodeId: string;
  /** 1-based number of the attempt about to run (first retry is 2). */
  attempt: number;
}

export interface WorkflowFinishedEvent extends WorkflowEventBase {
  kind: "workflowFinished";
  durationMs: number;
}

export interface WorkflowCancelledEvent extends WorkflowEventBase {
  kind: "workflowCancelled";
}

export interface WorkflowErrorEvent extends WorkflowEventBase {
  kind: "workflowError";
  message: string;
}

export type WorkflowEvent =
  | WorkflowNodeStartedEvent
  | WorkflowNodeFinishedEvent
  | WorkflowBranchTakenEvent
  | WorkflowLoopIterationEvent
  | WorkflowNodeRetryEvent
  | WorkflowFinishedEvent
  | WorkflowCancelledEvent
  | WorkflowErrorEvent;

export type WorkflowStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "cancelled";
