import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventBody } from '@ampli-world/shared';
import { GyrosBridge, toGyrosRun, transition, type NudgeMemory } from '../src/gyros.ts';

const raw = (over: Record<string, unknown> = {}) => ({
  run_id: 'r1',
  workflow: 'carplan',
  ticket_key: 'CP-12',
  ticket_summary: 'Fix the login',
  status: 'running',
  current_node: 'implement',
  pending_kind: null,
  round: 1,
  busy: true,
  pr_url: null,
  updated_at: '2026-10-29T10:00:00Z',
  // Everything below must not cross over.
  error: 'secret stack trace',
  cost_usd: 1.23,
  owner: 'someone@example.com',
  metrics: { tokens: 1 },
  ...over,
});

test('only whitelisted fields cross over', () => {
  const run = toGyrosRun(raw())!;
  assert.deepEqual(Object.keys(run).sort(), [
    'busy', 'node', 'overdue', 'pending', 'pendingLabel', 'prUrl', 'round', 'runId', 'station', 'status',
    'stepLabel', 'ticketKey', 'title', 'updatedAt', 'waitingSince', 'workflow',
  ]);
  assert.equal(run.station, 'bench');
  assert.equal(run.stepLabel, 'the agent is working');
  assert.equal(JSON.stringify(run).includes('secret'), false);
  assert.equal(toGyrosRun(raw({ pr_url: 'javascript:alert(1)' }))!.prUrl, null);
  assert.equal(toGyrosRun({ status: 'running' }), null, 'needs a run id');
});

test('transitions: start, steps, needs you, resumed, published, stopped, finished', () => {
  const r = (over: Record<string, unknown>) => toGyrosRun(raw(over))!;
  assert.equal(transition(undefined, r({})), 'started');
  assert.equal(transition(undefined, r({ status: 'done' })), null, 'old finished runs are not news');
  assert.equal(transition(r({}), r({ current_node: 'gates' })), 'step');
  assert.equal(transition(r({}), r({ current_node: 'overseer_fix' })), null, 'same station, no news');
  assert.equal(transition(r({}), r({ status: 'waiting', pending_kind: 'verdict', current_node: 'verdict' })), 'needs_you');
  assert.equal(transition(r({ status: 'waiting', pending_kind: 'verdict' }), r({})), 'resumed');
  assert.equal(transition(r({ current_node: 'publish' }), r({ status: 'watching', current_node: 'publish' })), 'published');
  assert.equal(transition(r({}), r({ status: 'stopped' })), 'stopped');
  assert.equal(transition(r({ status: 'watching' }), r({ status: 'done' })), 'finished');
});

test('the bridge logs changes only after the first look', () => {
  const events: EventBody[] = [];
  const bridge = new GyrosBridge('http://unused', 'http://ui', (e) => events.push(e));
  bridge.apply([raw(), raw({ run_id: 'old', status: 'done' })]);
  assert.equal(events.length, 0, 'baseline only');
  assert.deepEqual(bridge.state().runs.map((r) => r.runId), ['r1'], 'finished runs are not on the map');
  bridge.apply([raw({ status: 'waiting', pending_kind: 'draft_review', current_node: 'review_draft' })]);
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.equal(e.type === 'gyros' && e.data.kind, 'needs_you');
  assert.equal(e.type === 'gyros' && e.data.pendingLabel, 'a draft to review');
  assert.equal(bridge.state().uiUrl, 'http://ui');
});

test('the bell: overdue after the threshold, rung once per wait, remembered, cleared when the run moves on', () => {
  const HOUR = 3_600_000;
  let now = Date.parse('2026-10-29T12:00:00Z');
  let saved: NudgeMemory | null = null;
  const options = {
    nudgeAfterMs: 2 * HOUR,
    now: () => now,
    memory: { load: () => saved, save: (m: NudgeMemory) => (saved = structuredClone(m)) },
  };
  const waiting = (since: string, over: Record<string, unknown> = {}) =>
    raw({ status: 'waiting', pending_kind: 'verdict', current_node: 'verdict', waiting_since: since, ...over });
  const bridge = new GyrosBridge('http://unused', null, () => {}, options);
  bridge.apply([waiting('2026-10-29T11:00:00Z'), waiting('2026-10-29T08:00:00Z', { run_id: 'r2', ticket_key: 'CP-2' })]);
  const overdue = () => bridge.state().runs.filter((r) => r.overdue).map((r) => r.runId);
  assert.deepEqual(overdue(), ['r2'], 'one hour is not long enough yet');

  assert.equal(bridge.nudge(['r1'], 'hello', 10), null, 'runs that are not overdue are not rung for');
  const nudge = bridge.nudge(['r1', 'r2'], 'CP-2 has waited 4 h for a verdict.', 10)!;
  assert.deepEqual(nudge.runs.map((r) => r.runId), ['r2']);
  assert.deepEqual(overdue(), [], 'rung once per wait');
  assert.equal(bridge.state().nudge?.text, 'CP-2 has waited 4 h for a verdict.');

  const restarted = new GyrosBridge('http://unused', null, () => {}, options);
  restarted.apply([waiting('2026-10-29T11:00:00Z'), waiting('2026-10-29T08:00:00Z', { run_id: 'r2', ticket_key: 'CP-2' })]);
  assert.deepEqual(restarted.state().runs.filter((r) => r.overdue).map((r) => r.runId), [], 'survives a restart');
  assert.equal(restarted.state().nudge?.runs.length, 1);

  // r2 gets its answer: the bell is over. Later it waits again, for something new.
  restarted.apply([waiting('2026-10-29T11:00:00Z'), raw({ run_id: 'r2', ticket_key: 'CP-2' })]);
  assert.equal(restarted.state().nudge, null);
  now += 5 * HOUR;
  restarted.apply([waiting('2026-10-29T11:00:00Z'), waiting('2026-10-29T13:00:00Z', { run_id: 'r2', ticket_key: 'CP-2' })]);
  assert.deepEqual(restarted.state().runs.filter((r) => r.overdue).map((r) => r.runId).sort(), ['r1', 'r2']);
});

test('the bell is off without a threshold', () => {
  const bridge = new GyrosBridge('http://unused', null, () => {});
  bridge.apply([raw({ status: 'waiting', pending_kind: 'verdict', waiting_since: '2020-01-01T00:00:00Z' })]);
  assert.equal(bridge.state().runs[0]!.overdue, false);
});
