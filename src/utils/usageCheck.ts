import type { Schedule, Workflow } from '../types';

export interface DeleteBlocker {
  kind: 'workflow' | 'schedule';
  id: string;
  name: string;
}

/**
 * Returns every workflow and schedule that reference the given command id.
 * A non-empty result means deletion must be blocked.
 */
export function checkCommandBlockers(
  commandId: string,
  workflows: ReadonlyArray<Workflow>,
  schedules: ReadonlyArray<Schedule>,
): DeleteBlocker[] {
  const blockers: DeleteBlocker[] = [];

  for (const wf of workflows) {
    const used = wf.nodes.some(
      (n) => n.kind === 'command' && n.commandId === commandId,
    );
    if (used) {
      blockers.push({ kind: 'workflow', id: wf.id, name: wf.name });
    }
  }

  for (const s of schedules) {
    if (s.targetKind === 'command' && s.targetId === commandId) {
      blockers.push({ kind: 'schedule', id: s.id, name: s.name });
    }
  }

  return blockers;
}

/**
 * Returns every schedule that references the given workflow id.
 * A non-empty result means deletion must be blocked.
 */
export function checkWorkflowBlockers(
  workflowId: string,
  schedules: ReadonlyArray<Schedule>,
): DeleteBlocker[] {
  return schedules
    .filter((s) => s.targetKind === 'workflow' && s.targetId === workflowId)
    .map((s) => ({ kind: 'schedule' as const, id: s.id, name: s.name }));
}
