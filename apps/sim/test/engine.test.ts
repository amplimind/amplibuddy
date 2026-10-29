import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLACES,
  WALK_TILES_PER_SECOND,
  pathBetween,
  pathLength,
  walkMinutes,
  type EventBody,
  type Needs,
} from '@ampli-world/shared';
import { Engine, initialState, START_TIME } from '../src/engine.ts';
import { Store } from '../src/store.ts';

function setup() {
  const events: { body: EventBody; simTime: number }[] = [];
  const engine = new Engine(initialState(), (body, simTime) => events.push({ body, simTime }), () => 'A Book');
  return { engine, events, types: () => events.map((e) => e.body.type) };
}

test('needs decay while idle', () => {
  const { engine } = setup();
  const before = { ...engine.agent.needs };
  engine.advance(60);
  assert.equal(engine.agent.needs.satiety, before.satiety - 6);
  assert.equal(engine.agent.needs.fun, before.fun - 8);
  assert.equal(engine.simTime, START_TIME + 60);
});

test('activity at the current place starts immediately and finishes on time', () => {
  const { engine, types } = setup();
  assert.deepEqual(engine.plan({ kind: 'nap' }), { ok: true });
  assert.equal(engine.idle, false);
  engine.advance(59);
  assert.ok(engine.agent.activity);
  engine.advance(1);
  assert.equal(engine.agent.activity, null);
  assert.equal(engine.idle, true);
  assert.deepEqual(types(), ['activity_started', 'activity_finished']);
});

test('plan elsewhere walks first, then starts the activity on arrival', () => {
  const { engine, events, types } = setup();
  engine.plan({ kind: 'eat' });
  assert.equal(engine.agent.place, null);
  assert.ok(engine.agent.walk);

  const walk = walkMinutes('home', 'cafe', 1);
  engine.advance(walk / 2);
  assert.notDeepEqual(engine.agent.position, PLACES.home.spot);

  engine.advance(walk / 2 + 5);
  assert.equal(engine.agent.place, 'cafe');
  assert.equal(engine.agent.activity?.kind, 'eat');
  assert.equal(engine.agent.activity?.startedAt, START_TIME + walk, 'starts exactly on arrival');
  assert.deepEqual(types(), ['walk_started', 'activity_started']);
  assert.equal(events[1]!.simTime, START_TIME + walk);
});

test('one big advance crosses several boundaries correctly', () => {
  const { engine, types } = setup();
  engine.plan({ kind: 'coffee' });
  engine.advance(600);
  assert.deepEqual(types(), ['walk_started', 'activity_started', 'activity_finished']);
  assert.equal(engine.idle, true);
  assert.equal(engine.agent.place, 'cafe');
});

test('busy agent rejects a new plan', () => {
  const { engine } = setup();
  engine.plan({ kind: 'nap' });
  assert.deepEqual(engine.plan({ kind: 'eat' }), { ok: false, error: 'busy' });
});

test('read needs a book and reports its title', () => {
  const { engine, events } = setup();
  assert.equal(engine.plan({ kind: 'read' }).ok, false);
  engine.plan({ kind: 'read', bookId: 'b1' });
  engine.advance(120);
  const started = events.find((e) => e.body.type === 'activity_started')!.body;
  assert.deepEqual(started.data, { kind: 'read', place: 'library', bookTitle: 'A Book' });
});

test('sleep lasts until 07:00 and restores energy', () => {
  const state = initialState();
  state.simTime = 22 * 60;
  state.agent.needs.energy = 10;
  const engine = new Engine(state, () => {});
  engine.plan({ kind: 'sleep' });
  assert.equal(engine.agent.activity?.endsAt, 24 * 60 + 7 * 60);
  engine.advance(9 * 60);
  assert.equal(engine.idle, true);
  assert.equal(engine.agent.needs.energy, 100);
});

test('store round-trips state, events and usage', () => {
  const store = new Store(':memory:');
  const { engine } = setup();
  engine.plan({ kind: 'eat' });
  store.saveState(engine.state());
  assert.deepEqual(store.loadState(), JSON.parse(JSON.stringify(engine.state())));

  store.appendEvent(10, { type: 'thought', data: { text: 'hm', source: 'routine' } });
  store.appendEvent(20, { type: 'reading', data: { bookId: 'b1', title: 'B', takeaway: 'x' } });
  assert.deepEqual(store.recentEvents(10).map((e) => e.simTime), [10, 20]);
  assert.equal(store.readCounts().get('b1'), 1);

  store.recordLlmCall('decide', { model: 'm', promptTokens: 10, completionTokens: 5, costUsd: 0.25, latencyMs: 1 });
  store.recordLlmCall('diary', { model: 'm', promptTokens: 10, completionTokens: 5, costUsd: 0.5, latencyMs: 1 });
  assert.deepEqual(store.usageToday(), { calls: 2, costUsd: 0.75 });
});

test('walks take the same real time at any sim speed', () => {
  const tiles = pathLength(pathBetween('home', 'cafe'));
  const realSeconds = tiles / WALK_TILES_PER_SECOND;
  for (const speed of [0.0166667, 0.1, 1, 10]) {
    assert.ok(Math.abs(walkMinutes('home', 'cafe', speed) / speed - realSeconds) < 1e-9);
  }
  assert.ok(realSeconds > 10 && realSeconds < 25, `home -> cafe should take a short stroll, got ${realSeconds}s`);
});

test('a walk saved at another speed keeps its progress and gets re-timed', () => {
  const state = initialState();
  // Saved mid-way through a slow walk (as if the old timing was 100 sim minutes).
  state.agent.place = null;
  state.agent.walk = {
    from: 'home',
    to: 'cafe',
    path: pathBetween('home', 'cafe'),
    startedAt: state.simTime - 50,
    endsAt: state.simTime + 50,
  };
  const engine = new Engine(state, () => {}, () => undefined, 0.1);
  const walk = engine.agent.walk!;
  const duration = walkMinutes('home', 'cafe', 0.1);
  assert.ok(Math.abs(walk.endsAt - walk.startedAt - duration) < 1e-9);
  assert.ok(Math.abs(walk.endsAt - engine.simTime - duration / 2) < 1e-9, 'half-way stays half-way');
});

test('company drains when alone and fills up when chatting', () => {
  const { engine } = setup();
  const start = engine.agent.needs.social;
  engine.advance(120);
  assert.equal(engine.agent.needs.social, start - 10);
  const state = initialState();
  state.simTime = 9 * 60;
  state.agent.place = 'cafe';
  state.agent.needs.social = 10;
  const chatty = new Engine(state, () => {});
  chatty.plan({ kind: 'chat' });
  chatty.advance(30);
  assert.equal(chatty.agent.needs.social, 10 + 35);
});

test('worlds saved before the social need get a default', () => {
  const state = initialState();
  const { social: _dropped, ...oldNeeds } = state.agent.needs;
  state.agent.needs = oldNeeds as Needs;
  const engine = new Engine(state, () => {});
  assert.equal(engine.agent.needs.social, 60);
});

test('a chat happens where the partner is, and names them', () => {
  const events: { body: EventBody; simTime: number }[] = [];
  const partners = { bruno: { name: 'Bruno', place: 'park' as const } };
  const engine = new Engine(
    initialState(),
    (body, simTime) => events.push({ body, simTime }),
    () => undefined,
    1,
    (id) => (id ? partners[id as keyof typeof partners] : undefined),
  );
  assert.deepEqual(engine.plan({ kind: 'chat', partnerId: 'nobody' }), { ok: false, error: 'nobody to chat with' });
  assert.deepEqual(engine.plan({ kind: 'chat', partnerId: 'bruno' }), { ok: true });
  assert.equal(engine.agent.walk?.to, 'park');
  engine.advance(60);
  const started = events.find((e) => e.body.type === 'activity_started')!.body;
  assert.deepEqual(started.type === 'activity_started' && started.data, { kind: 'chat', place: 'park', with: 'Bruno' });
});
