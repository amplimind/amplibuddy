import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAMES, PLACES, PLOTS, standPoint, type BrainContext, type TownState, type WorldEvent } from '@ampli-world/shared';
import { createApp } from '../src/http.ts';
import { Sim } from '../src/sim.ts';
import { Store } from '../src/store.ts';

const TOKEN = 'brain-secret';
const LANTERN = '<svg viewBox="0 0 64 64"><rect x="29" y="20" width="6" height="40" fill="#3b3127"/><circle cx="32" cy="16" r="8" fill="#ffd77a"/></svg>';
const PAINTING = '<svg viewBox="0 0 400 300"><rect width="400" height="300" fill="#9cc7e8"/></svg>';

function setup() {
  const neighbors = [
    { id: 'hedda', name: 'Hedda', species: 'hedgehog', look: 'hedgehog' as const, place: 'cafe' as const },
    { id: 'olli', name: 'Olli', species: 'raccoon', look: 'raccoon' as const, place: 'library' as const },
  ];
  const sim = new Sim(new Store(':memory:'), new Map(), { name: 'Ampli', species: 'fox', look: 'fox', town: 'X' }, 1, neighbors);
  const app = createApp(sim, { brainToken: TOKEN, webDist: '/nonexistent', adminToken: 'admin-secret' });
  const brain = (path: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-brain-token': TOKEN },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const get = async <T>(path: string) => (await (await app.request(path)).json()) as T;
  const events = async (type: string) => (await get<WorldEvent[]>('/api/events?limit=200')).filter((e) => e.type === type);
  const decide = (plan: object) => brain('/api/brain/decision', { plan, thought: { text: 'Let me.', source: 'routine' } });
  /** Lets the sim run until Ampli is idle again (walk + activity). */
  const finish = () => {
    for (let i = 0; i < 500 && !sim.engine.idle; i++) sim.tick(1);
  };
  const admin = (path: string) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'admin-secret' }, body: '{}' });
  return { sim, app, brain, get, events, decide, finish, admin };
}

test('town: plots and frames sit on the map, outside buildings and away from each other', () => {
  const inside = (p: { x: number; y: number }, a: { x: number; y: number; w: number; h: number }) =>
    p.x >= a.x && p.x < a.x + a.w && p.y >= a.y && p.y < a.y + a.h;
  const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const buildings = Object.values(PLACES).filter((p) => p.id !== 'park' && p.id !== 'plaza');
  for (const plot of PLOTS) {
    for (const b of buildings) assert.ok(!overlap(plot.area, b.area), `${plot.id} overlaps ${b.id}`);
    for (const other of PLOTS) if (other !== plot) assert.ok(!overlap(plot.area, other.area), `${plot.id} overlaps ${other.id}`);
    assert.ok(standPoint({ plot: plot.id }), plot.id);
  }
  for (const frame of FRAMES) {
    const place = PLACES[frame.place];
    assert.equal(inside({ x: frame.rect.x, y: frame.rect.y }, place.area), true, `${frame.id} hangs at ${frame.place}`);
    assert.ok(Math.abs(frame.rect.w / frame.rect.h - 4 / 3) < 0.01, `${frame.id} fits a painting`);
  }
  assert.equal(new Set([...PLOTS.map((p) => p.id), ...FRAMES.map((f) => f.id)]).size, PLOTS.length + FRAMES.length);
});

test('town: building walks to the plot, puts the thing up, and a later build replaces it', async () => {
  const t = setup();
  assert.equal((await t.decide({ kind: 'build', plot: 'nowhere' })).status, 400);
  assert.equal((await t.decide({ kind: 'build', plot: 'pond' })).status, 200);
  assert.equal(t.sim.engine.agent.walk?.to, 'park', 'the plot by the pond belongs to the park');
  for (let i = 0; i < 100 && t.sim.engine.agent.walk; i++) t.sim.tick(1);
  assert.equal(t.sim.engine.agent.activity?.plot, 'pond');
  const started = (await t.events('activity_started'))[0];
  assert.equal(started?.type === 'activity_started' && started.data.where, 'by the pond');

  const version = t.sim.snapshot().townVersion;
  const first = await t.brain('/api/brain/build', { plot: 'pond', name: 'Lantern', description: 'For late walkers.', svg: LANTERN });
  assert.equal(first.status, 200);
  const { id } = (await first.json()) as { id: number };
  assert.ok(t.sim.snapshot().townVersion > version, 'clients hear that the town changed');
  assert.deepEqual(
    (await t.get<TownState>('/api/town')).builds.map((b) => [b.plot, b.name, b.description]),
    [['pond', 'Lantern', 'For late walkers.']],
  );
  const svg = await t.app.request(`/api/build/${id}.svg`);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(svg.headers.get('content-security-policy') ?? '', /default-src 'none'/);

  // Rejected drawings never go up; held ones are kept but not shown.
  assert.equal((await t.brain('/api/brain/build', { plot: 'pond', name: 'Bad', description: 'x', svg: '<svg onload="alert(1)"></svg>' })).status, 400);
  const held = (await (await t.brain('/api/brain/build', { plot: 'pond', name: 'Rude', description: 'x', svg: LANTERN, held: true })).json()) as { id: number };
  assert.equal((await t.app.request(`/api/build/${held.id}.svg`)).status, 404);
  assert.equal((await t.get<TownState>('/api/town')).builds[0]!.name, 'Lantern', 'the held one changes nothing');

  await t.brain('/api/brain/build', { plot: 'pond', name: 'Lantern, brighter', description: 'Now with a second wick.', svg: LANTERN });
  const town = await t.get<TownState>('/api/town');
  assert.deepEqual(town.builds.map((b) => b.name), ['Lantern, brighter']);
  const built = (await t.events('built')).map((e) => e.type === 'built' && [e.data.name ?? null, e.data.replaced ?? null, !!e.data.held]);
  assert.deepEqual(built, [
    ['Lantern', null, false],
    [null, null, true],
    ['Lantern, brighter', 'Lantern', false],
  ]);

  const context = (await (await t.brain('/api/brain/context')).json()) as BrainContext;
  assert.equal(context.buildsToday, 3, 'every attempt counts towards the daily cap');
  assert.deepEqual(context.town.builds.map((b) => b.plot), ['pond']);
});

test('town: a painting goes up on its frame when Ampli gets there, and the old one comes down', async () => {
  const t = setup();
  const paint = async (title: string) =>
    ((await (await t.brain('/api/brain/art', { title, caption: 'c', svg: PAINTING })).json()) as { id: number }).id;
  const first = await paint('Pond at Noon');
  const second = await paint('Pond at Dusk');

  assert.equal((await t.decide({ kind: 'hang_painting', artId: 999, frame: 'plaza-1' })).status, 400);
  assert.equal((await t.decide({ kind: 'hang_painting', artId: first, frame: 'attic' })).status, 400);
  assert.equal((await t.decide({ kind: 'hang_painting', artId: first, frame: 'plaza-1' })).status, 200);
  assert.deepEqual((await t.get<TownState>('/api/town')).frames, [], 'not before Ampli arrives');
  t.finish();
  assert.deepEqual((await t.get<TownState>('/api/town')).frames.map((f) => [f.frame, f.title]), [['plaza-1', 'Pond at Noon']]);

  assert.equal((await t.decide({ kind: 'hang_painting', artId: second, frame: 'plaza-1' })).status, 200);
  t.finish();
  const hung = (await t.events('painting_hung')).map((e) => e.type === 'painting_hung' && [e.data.title, e.data.where, e.data.replaced ?? null]);
  assert.deepEqual(hung, [
    ['Pond at Noon', 'on the first easel on the plaza', null],
    ['Pond at Dusk', 'on the first easel on the plaza', 'Pond at Noon'],
  ]);

  // A painting the admin hides disappears from the town too.
  t.sim.store.setArtStatus(second, 'hidden');
  assert.deepEqual((await t.get<TownState>('/api/town')).frames, []);
  const context = (await (await t.brain('/api/brain/context')).json()) as BrainContext;
  assert.deepEqual(context.paintings.map((p) => p.title), ['Pond at Noon']);
  assert.equal(context.hangsToday, 2);
});

test('town: a chat goes to the neighbour the brain chose', async () => {
  const t = setup();
  t.sim.engine.simTime = 10 * 60;
  assert.equal((await t.decide({ kind: 'chat', partnerId: 'olli' })).status, 200);
  assert.equal(t.sim.engine.agent.walk?.to, 'library', 'Olli lives at the library, not the café');
});

test('town: an admin can take a build down (the plot stays empty) or put a held one up', async () => {
  const t = setup();
  const build = async (name: string, held = false) =>
    ((await (await t.brain('/api/brain/build', { plot: 'garden', name, description: 'd', svg: LANTERN, held })).json()) as { id: number }).id;
  await build('Old bench');
  const newer = await build('New bench');
  const held = await build('Strange statue', true);

  assert.equal((await t.admin(`/api/admin/builds/${newer}/hide`)).status, 200);
  assert.deepEqual((await t.get<TownState>('/api/town')).builds, [], 'the older one does not come back');
  assert.equal((await t.admin(`/api/admin/builds/${held}/approve`)).status, 200);
  assert.deepEqual((await t.get<TownState>('/api/town')).builds.map((b) => b.name), ['Strange statue']);
  assert.equal((await t.admin('/api/admin/builds/999/hide')).status, 404);
  assert.equal((await t.app.request('/api/admin/builds', { headers: { 'x-admin-token': 'nope' } })).status, 401);
});

test('town: with building switched off, nothing new goes up and nothing built is shown', async () => {
  const t = setup();
  const id = ((await (await t.brain('/api/brain/build', { plot: 'garden', name: 'Bench', description: 'd', svg: LANTERN })).json()) as { id: number }).id;

  // The same town after a restart with the switch off.
  const offApp = createApp(t.sim, { brainToken: TOKEN, webDist: '/nonexistent', building: false });
  assert.deepEqual(((await (await offApp.request('/api/town')).json()) as TownState).builds, []);
  assert.equal((await offApp.request(`/api/build/${id}.svg`)).status, 404);
  const brain = (path: string, body: unknown) =>
    offApp.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-brain-token': TOKEN }, body: JSON.stringify(body) });
  assert.equal((await brain('/api/brain/build', { plot: 'pond', name: 'Sneaky', description: 'd', svg: LANTERN })).status, 403);
  assert.equal((await brain('/api/brain/decision', { plan: { kind: 'build', plot: 'pond' }, thought: { text: 'x', source: 'routine' } })).status, 403);
  assert.equal(t.sim.engine.idle, true, 'nothing was planned');
});
