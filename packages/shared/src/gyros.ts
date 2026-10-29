// GyrOS (the ticket-to-pull-request pipeline) as seen from Ampli's workshop. Only
// whitelisted, read-only facts cross over: no ticket text, diffs, logs or prompts.

export type GyrosStation =
  | 'ticket'
  | 'questions'
  | 'draft'
  | 'setup'
  | 'bench'
  | 'gates'
  | 'browser'
  | 'review'
  | 'dock'
  | 'watch';

export interface GyrosRun {
  runId: string;
  workflow: string;
  ticketKey: string | null;
  title: string | null;
  status: string;
  node: string | null;
  station: GyrosStation;
  /** Plain words for what's happening, e.g. "running the gates". */
  stepLabel: string;
  /** Interrupt kind when GyrOS waits for a human, e.g. "draft_review". */
  pending: string | null;
  pendingLabel: string | null;
  round: number;
  busy: boolean;
  prUrl: string | null;
  waitingSince: string | null;
  updatedAt: string;
  /** Waited for a human longer than the nudge threshold, and Ampli hasn't rung the bell for this wait yet. */
  overdue: boolean;
}

/** A run Ampli rang the workshop bell for. */
export interface GyrosNudgeRun {
  runId: string;
  ticketKey: string | null;
  workflow: string;
  title: string | null;
  pendingLabel: string | null;
  waitingSince: string;
}

/** Ampli's latest bell: what it said and which waiting runs it was about. */
export interface GyrosNudge {
  text: string;
  simTime: number;
  runs: GyrosNudgeRun[];
}

export interface GyrosState {
  connected: boolean;
  /** GyrOS's own UI, for "open in GyrOS" links; null if not configured. */
  uiUrl: string | null;
  /** Active runs only (draft, running, waiting, watching). */
  runs: GyrosRun[];
  /** The latest bell, with only the runs that still wait; null once they all moved on. */
  nudge: GyrosNudge | null;
}

/** How long a run has waited, in words: "40 min", "3 h", "12 days". Real time, not sim time. */
export function waitedFor(since: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(since)) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

export type GyrosEventKind = 'started' | 'step' | 'needs_you' | 'resumed' | 'published' | 'stopped' | 'finished';

export const GYROS_STATIONS: { id: GyrosStation; label: string; icon: string }[] = [
  { id: 'ticket', label: 'Ticket', icon: '📋' },
  { id: 'questions', label: 'Questions', icon: '❓' },
  { id: 'draft', label: 'Draft', icon: '📝' },
  { id: 'setup', label: 'Setup', icon: '🧰' },
  { id: 'bench', label: 'Workbench', icon: '🔨' },
  { id: 'gates', label: 'Gates', icon: '🧪' },
  { id: 'browser', label: 'Browser check', icon: '🖥️' },
  { id: 'review', label: 'Review', icon: '🔍' },
  { id: 'dock', label: 'Dock', icon: '📦' },
  { id: 'watch', label: 'Watch', icon: '🔭' },
];

const NODE_STATION: Record<string, GyrosStation> = {
  import_ticket: 'ticket',
  resolve_pr: 'ticket',
  scope: 'ticket',
  merge_answers: 'ticket',
  post_questions: 'questions',
  wait_answers: 'questions',
  review_draft: 'draft',
  start: 'setup',
  preflight: 'setup',
  preflight_review: 'setup',
  checkout: 'setup',
  workspace: 'setup',
  start_app: 'setup',
  pr_checks: 'setup',
  test_plan: 'setup',
  implement: 'bench',
  overseer_fix: 'bench',
  protected_review: 'bench',
  gates: 'gates',
  ci_final: 'gates',
  verify_ux: 'browser',
  smoke_review: 'browser',
  review: 'review',
  pr_review: 'review',
  verdict: 'review',
  guardrail_stop: 'review',
  lessons: 'review',
  lesson_patch: 'review',
  publish: 'dock',
};

/** Plain words per graph node (after GyrOS's own NODE_LABEL). */
const NODE_LABEL: Record<string, string> = {
  import_ticket: 'reading the ticket',
  post_questions: 'asking questions on the ticket',
  wait_answers: 'waiting for answers on the ticket',
  merge_answers: 'folding the answers into the draft',
  review_draft: 'drafting the task',
  start: 'setting up the worktree',
  preflight: 'checking the environment',
  preflight_review: 'checking the environment',
  workspace: 'setting up the workspace',
  implement: 'the agent is working',
  overseer_fix: 'fixing what the overseer found',
  protected_review: 'checking protected files',
  gates: 'running the gates (lint, tests)',
  verify_ux: 'clicking through it in a browser',
  smoke_review: 'looking at the browser check',
  review: 'a second model reviews the change',
  guardrail_stop: 'stopped by a guardrail',
  lessons: 'collecting lessons',
  lesson_patch: 'a lesson to review',
  verdict: 'waiting for the verdict',
  publish: 'publishing the pull request',
  resolve_pr: 'reading the pull request',
  pr_checks: 'reading CI and conflicts',
  ci_final: 'reading CI again',
  start_app: 'starting the app',
  scope: 'reading the scope',
  checkout: 'checking out the pull request',
  test_plan: 'writing the testing guide',
  pr_review: 'a review to submit',
};

/** Plain words per interrupt kind (after GyrOS's own KIND_LABEL). */
const KIND_LABEL: Record<string, string> = {
  draft_review: 'a draft to review',
  questions: 'answers to its questions',
  verdict: 'a verdict',
  guardrail_stop: 'a decision after a guardrail stop',
  smoke_review: 'a look at the gate results',
  protected_review: 'an OK for protected files',
  preflight_review: 'an environment check',
  lesson_patch: 'a lesson to review',
  watch_paused: 'a paused watch',
  overseer_fix: 'an OK for the overseer fix',
  pr_review: 'a review to submit',
  agent_question: 'an answer to the agent',
};

export function gyrosStation(status: string, node: string | null): GyrosStation {
  if (status === 'watching') return 'watch';
  return (node && NODE_STATION[node]) || 'bench';
}

export function gyrosStepLabel(status: string, node: string | null): string {
  if (status === 'watching') return 'watching the pull request';
  return (node && NODE_LABEL[node]) || (node ? node.replace(/_/g, ' ') : 'getting started');
}

export function gyrosPendingLabel(kind: string | null): string | null {
  return kind ? (KIND_LABEL[kind] ?? kind.replace(/_/g, ' ')) : null;
}

export const GYROS_ACTIVE_STATUSES = ['draft', 'running', 'waiting', 'watching'];
