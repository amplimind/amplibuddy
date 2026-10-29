import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AdminLetter, Artwork, BrainLetter, Letter, VisitorProfile, WorldEvent } from '@ampli-world/shared';
import { createApp, parseDoodle, type AppOptions } from '../src/http.ts';
import { Sim } from '../src/sim.ts';
import { namePattern, Store } from '../src/store.ts';

const TOKEN = 'brain-secret';

const ADMIN = 'admin-secret';

function setup(extra: Partial<AppOptions> = {}) {
  const sim = new Sim(new Store(':memory:'), new Map(), { name: 'Ampli', species: 'fox', town: 'X' }, 1);
  const app = createApp(sim, { brainToken: TOKEN, webDist: '/nonexistent', adminToken: ADMIN, ...extra });

  const send = (body: unknown, cookie?: string) =>
    app.request('/api/mail', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const brain = (path: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-brain-token': TOKEN },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const get = async <T>(path: string, cookie?: string) =>
    (await (await app.request(path, cookie ? { headers: { cookie } } : {})).json()) as T;

  return { sim, app, send, brain, get };
}

function cookieOf(res: Response): string {
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

test('sending a letter issues a visitor cookie and starts in "checking"', async () => {
  const { send, get } = setup();
  const res = await send({ name: ' Anna <script> ', text: 'Hi Ampli!', private: false });
  assert.equal(res.status, 201);
  const letter = (await res.json()) as Letter;
  assert.equal(letter.name, 'Anna script');
  assert.equal(letter.status, 'checking');
  assert.match(res.headers.get('set-cookie')!, /aw_visitor=[0-9a-f-]{36}; .*HttpOnly/);

  const cookie = cookieOf(res);
  assert.equal((await get<Letter[]>('/api/mail/mine', cookie)).length, 1);
  assert.equal((await get<Letter[]>('/api/mail/mine')).length, 0, 'no cookie, no letters');
});

test('validation and rate limits', async () => {
  const { send } = setup();
  assert.equal((await send({ name: '', text: 'x' })).status, 400);
  assert.equal((await send({ name: 'A', text: '   ' })).status, 400);

  const first = await send({ name: 'A', text: '1' });
  const cookie = cookieOf(first);
  await send({ name: 'A', text: '2' }, cookie);
  await send({ name: 'A', text: '3' }, cookie);
  const fourth = await send({ name: 'A', text: '4' }, cookie);
  assert.equal(fourth.status, 429);
  assert.equal((await send({ name: 'B', text: 'other visitor' })).status, 201, 'limit is per visitor');
});

test('non-JSON posts are rejected', async () => {
  const { app } = setup();
  const res = await app.request('/api/mail', { method: 'POST', body: 'name=A&text=hi' });
  assert.equal(res.status, 415);
});

test('full flow: check -> post box -> reply -> board and event', async () => {
  const { send, brain, get, sim } = setup();
  const cookie = cookieOf(await send({ name: 'Anna', text: 'Do you like trains?' }));

  const checks = (await (await brain('/api/brain/mail/checks')).json()) as Letter[];
  assert.equal(checks.length, 1);
  assert.equal((await brain(`/api/brain/mail/${checks[0]!.id}/verdict`, { verdict: 'ok', reason: 'fine' })).status, 200);
  assert.equal(sim.snapshot().mailWaiting, 1);

  const waiting = (await (await brain('/api/brain/mail/waiting')).json()) as Letter[];
  const res = await brain(`/api/brain/mail/${waiting[0]!.id}/reply`, { decision: 'reply', reply: 'I love trains!' });
  assert.equal(res.status, 200);
  assert.equal(sim.snapshot().mailWaiting, 0);

  const board = await get<Letter[]>('/api/board');
  assert.equal(board[0]!.reply, 'I love trains!');
  assert.equal((await get<Letter[]>('/api/mail/mine', cookie))[0]!.status, 'replied');

  const events = await get<WorldEvent[]>('/api/events');
  const read = events.find((e) => e.type === 'mail_read')!;
  assert.deepEqual(read.data, { letterId: waiting[0]!.id, from: 'Anna', text: 'Do you like trains?', reply: 'I love trains!' });

  assert.equal((await brain(`/api/brain/mail/${waiting[0]!.id}/reply`, { decision: 'skip' })).status, 409, 'only once');
});

test('private letters: reply visible to sender only, event carries no content', async () => {
  const { send, brain, get } = setup();
  const cookie = cookieOf(await send({ name: 'Ben', text: 'secret worry', private: true }));
  const [letter] = (await (await brain('/api/brain/mail/checks')).json()) as Letter[];
  await brain(`/api/brain/mail/${letter!.id}/verdict`, { verdict: 'ok', reason: '' });
  await brain(`/api/brain/mail/${letter!.id}/reply`, { decision: 'reply', reply: 'I hear you.' });

  assert.equal((await get<Letter[]>('/api/board')).length, 0);
  assert.equal((await get<Letter[]>('/api/mail/mine', cookie))[0]!.reply, 'I hear you.');
  const read = (await get<WorldEvent[]>('/api/events')).find((e) => e.type === 'mail_read')!;
  assert.deepEqual(read.data, { letterId: letter!.id });
});

test('held letters and held replies never show up publicly', async () => {
  const { send, brain, get } = setup();
  const c1 = cookieOf(await send({ name: 'Troll', text: 'something nasty' }));
  await send({ name: 'Cara', text: 'trick question' });
  const [nasty, trick] = (await (await brain('/api/brain/mail/checks')).json()) as Letter[];

  await brain(`/api/brain/mail/${nasty!.id}/verdict`, { verdict: 'hold', reason: 'insult' });
  assert.equal((await get<Letter[]>('/api/mail/mine', c1))[0]!.status, 'held');

  await brain(`/api/brain/mail/${trick!.id}/verdict`, { verdict: 'ok', reason: '' });
  await brain(`/api/brain/mail/${trick!.id}/reply`, { decision: 'reply', reply: 'bad words', held: true, note: 'rude' });
  assert.equal((await get<Letter[]>('/api/board')).length, 0);
  const read = (await get<WorldEvent[]>('/api/events')).find((e) => e.type === 'mail_read')!;
  assert.deepEqual(read.data, { letterId: trick!.id });
});

test('brain mail endpoints need the token', async () => {
  const { app } = setup();
  assert.equal((await app.request('/api/brain/mail/checks')).status, 401);
});

// --- Visitor memory, forget-me, retention -------------------------------------------

async function deliver(t: ReturnType<typeof setup>, body: object, cookie?: string) {
  const res = await t.send(body, cookie);
  const letter = (await res.json()) as Letter;
  await t.brain(`/api/brain/mail/${letter.id}/verdict`, { verdict: 'ok', reason: '' });
  return { letter, cookie: cookie ?? cookieOf(res) };
}

test('memory is stored per scope and only the matching scope reaches the brain', async () => {
  const t = setup();
  const { letter: pub, cookie } = await deliver(t, { name: 'Ben', text: 'I like trains' });
  await t.brain(`/api/brain/mail/${pub.id}/reply`, { decision: 'reply', reply: 'Me too!', memory: 'Ben likes trains.' });
  const { letter: priv } = await deliver(t, { name: 'Ben', text: 'I fear for my job', private: true }, cookie);
  await t.brain(`/api/brain/mail/${priv.id}/reply`, { decision: 'reply', reply: 'I hear you.', memory: 'Ben worries about his job.' });

  const me = await t.get<VisitorProfile>('/api/me', cookie);
  assert.deepEqual(me.memory, { public: 'Ben likes trains.', private: 'Ben worries about his job.' });

  await deliver(t, { name: 'Ben', text: 'Hello again' }, cookie);
  const [waiting] = (await (await t.brain('/api/brain/mail/waiting')).json()) as BrainLetter[];
  assert.equal(waiting!.lettersBefore, 2);
  assert.deepEqual(waiting!.memory, me.memory, 'the brain gets both scopes; the prompt decides which one to show');
});

test('forget-me deletes letters and events, scrubs the name, and drops the cookie', async () => {
  const t = setup();
  const { letter, cookie } = await deliver(t, { name: 'Anna', text: 'Hi from Anna' });
  await t.brain(`/api/brain/mail/${letter.id}/reply`, { decision: 'reply', reply: 'Hi Anna!', memory: 'Anna says hi.' });
  t.sim.log({ type: 'thought', data: { text: "Anna's letter made me smile.", source: 'llm' } });
  t.sim.store.saveDiary({ day: 1, simTime: 0, text: 'Anna wrote to me. Annabel did not. I sat on the bench.' });
  t.sim.store.saveNotebook(0, ['Anna likes hello letters.']);

  const res = await t.app.request('/api/forget-me', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.deepEqual(await res.json(), { letters: 1 });
  assert.match(res.headers.get('set-cookie')!, /aw_visitor=;.*Max-Age=0/);

  assert.equal(await t.get('/api/me', cookie), null);
  assert.equal((await t.get<Letter[]>('/api/mail/mine', cookie)).length, 0);
  assert.equal((await t.get<Letter[]>('/api/board')).length, 0);
  const events = await t.get<WorldEvent[]>('/api/events');
  assert.ok(!events.some((e) => e.type === 'mail_read'));
  assert.ok(events.some((e) => e.type === 'thought' && e.data.text === "a visitor's letter made me smile."));
  assert.equal(t.sim.store.diary()[0]!.text, 'a visitor wrote to me. Annabel did not. I sat on the bench.');
  assert.deepEqual(t.sim.store.notebook(), ['a visitor likes hello letters.']);
});

test('names match whole words only, case-sensitively', () => {
  const p = namePattern('Ben')!;
  assert.equal('Ben, Ben’s bench, Benjamin, ben'.replace(p, 'X'), 'X, X’s bench, Benjamin, ben');
  assert.equal(namePattern('A'), null, 'single letters are not scrubbed');
  assert.equal('Dr. (Who)'.replace(namePattern('(Who)')!, 'X'), 'Dr. X', 'regex characters are escaped');
});

test('retention: expired visitors can be found and forgotten', async () => {
  const t = setup();
  const { cookie } = await deliver(t, { name: 'Old', text: 'long ago' });
  assert.deepEqual(t.sim.store.expiredVisitors(new Date(Date.now() - 86_400_000).toISOString()), []);
  const [id] = t.sim.store.expiredVisitors(new Date(Date.now() + 1000).toISOString());
  assert.equal(cookie.split('=')[1], id);
  t.sim.store.forgetVisitor(id!);
  assert.equal(t.sim.store.visitorProfile(id!), null);
});

test('opening an older database adds the memory columns', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'aw-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE visitors (id TEXT PRIMARY KEY, name TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL)');
  old.exec("INSERT INTO visitors VALUES ('v1', 'Ann', '2026-01-01', '2026-01-01')");
  old.close();
  const store = new Store(file);
  assert.deepEqual(store.visitorProfile('v1')!.memory, { public: '', private: '' });
  store.close();
  rmSync(file, { force: true });
});

// --- Internet café ---------------------------------------------------------------------

test('browse results: only http(s) sources, held notes stay out of the log', async () => {
  const t = setup();
  await t.brain('/api/brain/browse', {
    query: 'how do foxes sleep',
    takeaway: 'Mostly in the open, curled up.',
    sources: [
      { title: 'Fox facts', url: 'https://example.org/fox' },
      { title: 'evil', url: 'javascript:alert(1)' },
      { url: 'http://plain.example/' },
      'nonsense',
    ],
  });
  await t.brain('/api/brain/browse', { query: 'second', takeaway: 'something bad', sources: [], held: true });

  const events = (await t.get<WorldEvent[]>('/api/events')).filter((e) => e.type === 'browsed');
  assert.deepEqual(events[0]!.data, {
    query: 'how do foxes sleep',
    takeaway: 'Mostly in the open, curled up.',
    sources: [
      { title: 'Fox facts', url: 'https://example.org/fox' },
      { title: 'plain.example', url: 'http://plain.example/' },
    ],
  });
  assert.deepEqual(events[1]!.data, { query: 'second', sources: [] });

  const ctx = (await (await t.brain('/api/brain/context')).json()) as { browsesToday: number };
  assert.equal(ctx.browsesToday, 2);
});

test('browse decisions need a query', async () => {
  const t = setup();
  const res = await t.brain('/api/brain/decision', { plan: { kind: 'browse' }, thought: { text: 'hm', source: 'llm' } });
  assert.equal(res.status, 400);
  const ok = await t.brain('/api/brain/decision', {
    plan: { kind: 'browse', query: 'fox dens' },
    thought: { text: 'curious', source: 'llm' },
  });
  assert.equal(ok.status, 200);
  assert.equal(t.sim.engine.agent.next?.query, 'fox dens');
});

// --- Admin, reports, pause, site password, IP limit ---------------------------------------

function admin(t: ReturnType<typeof setup>, path: string, body?: unknown, token = ADMIN) {
  return t.app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function publish(t: ReturnType<typeof setup>, name: string, text: string) {
  const { letter, cookie } = await deliver(t, { name, text });
  await t.brain(`/api/brain/mail/${letter.id}/reply`, { decision: 'reply', reply: `Hi ${name}!` });
  return { id: letter.id, cookie };
}

test('admin endpoints need the admin token, and are off without one', async () => {
  const t = setup();
  assert.equal((await admin(t, '/api/admin/overview', undefined, 'wrong')).status, 401);
  assert.equal((await admin(t, '/api/admin/overview')).status, 200);
  const off = setup({ adminToken: '' });
  assert.equal((await admin(off, '/api/admin/overview')).status, 403);
});

test('three reports take a letter off the board; admin approve puts it back', async () => {
  const t = setup();
  const { id } = await publish(t, 'Dora', 'hello board');
  const report = (cookie?: string) =>
    t.app.request(`/api/mail/${id}/report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: '{}',
    });
  const r1 = cookieOf(await t.send({ name: 'R1', text: 'x' }));
  const r2 = cookieOf(await t.send({ name: 'R2', text: 'x' }));
  const r3 = cookieOf(await t.send({ name: 'R3', text: 'x' }));
  await report(r1);
  await report(r1); // same reporter twice counts once
  await report(r2);
  assert.equal((await t.get<Letter[]>('/api/board')).length, 1);
  await report(r3);
  assert.equal((await t.get<Letter[]>('/api/board')).length, 0);
  assert.ok(!(await t.get<WorldEvent[]>('/api/events')).some((e) => e.type === 'mail_read'));

  const held = (await (await admin(t, '/api/admin/letters?view=held')).json()) as AdminLetter[];
  assert.equal(held[0]!.reports, 3);
  assert.equal(held[0]!.draftReply, 'Hi Dora!');

  await admin(t, `/api/admin/letters/${id}/approve`, {});
  assert.equal((await t.get<Letter[]>('/api/board')).length, 1);
  assert.equal((await t.get<WorldEvent[]>('/api/events')).filter((e) => e.type === 'mail_read').length, 1);
});

test('admin approves held letters into the post box and hides published ones', async () => {
  const t = setup();
  const res = await t.send({ name: 'Eli', text: 'borderline' });
  const { id } = (await res.json()) as Letter;
  await t.brain(`/api/brain/mail/${id}/verdict`, { verdict: 'hold', reason: 'unsure' });
  const approved = (await (await admin(t, `/api/admin/letters/${id}/approve`, {})).json()) as AdminLetter;
  assert.equal(approved.status, 'waiting');

  const pub = await publish(t, 'Fay', 'nice letter');
  await admin(t, `/api/admin/letters/${pub.id}/hide`, {});
  assert.equal((await t.get<Letter[]>('/api/board')).length, 0);
  assert.equal((await t.get<Letter[]>('/api/mail/mine', pub.cookie))[0]!.status, 'hidden');
});

test('the kill switch closes the post box for senders and the brain', async () => {
  const t = setup();
  await deliver(t, { name: 'Gus', text: 'before the pause' });
  await admin(t, '/api/admin/mailbox', { paused: true });
  assert.equal((await t.send({ name: 'Gus', text: 'during' })).status, 503);
  assert.deepEqual(await (await t.brain('/api/brain/mail/waiting')).json(), []);
  assert.equal(t.sim.snapshot().mailWaiting, 0);
  assert.deepEqual(await t.get('/api/mail/status'), { open: false });
  await admin(t, '/api/admin/mailbox', { paused: false });
  assert.equal(t.sim.snapshot().mailWaiting, 1);
});

test('site password guards everything except the brain endpoints', async () => {
  const t = setup({ sitePassword: 'letmein' });
  assert.equal((await t.app.request('/api/state')).status, 401);
  const auth = { authorization: `Basic ${Buffer.from('anyone:letmein').toString('base64')}` };
  assert.equal((await t.app.request('/api/state', { headers: auth })).status, 200);
  assert.equal((await t.brain('/api/brain/context')).status, 200);
});

test('per-IP limit catches cookie clearing', async () => {
  const t = setup();
  const fromSameIp = () =>
    t.app.request('/api/mail', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.7' },
      body: JSON.stringify({ name: 'Hal', text: 'again' }),
    });
  for (let i = 0; i < 20; i++) assert.equal((await fromSameIp()).status, 201);
  assert.equal((await fromSameIp()).status, 429);
});

// --- Doodles ------------------------------------------------------------------------------

/** A real 1x1 PNG. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('doodles must be small real PNGs', () => {
  assert.equal(parseDoodle(PNG), PNG);
  assert.equal(parseDoodle('data:image/png;base64,' + Buffer.from('not a png at all, sorry!!').toString('base64')), null);
  assert.equal(parseDoodle('data:image/svg+xml;base64,PHN2Zz4='), null);
  const huge = Buffer.from(PNG.split(',')[1]!, 'base64');
  huge.writeUInt32BE(5000, 16); // claims 5000px wide
  assert.equal(parseDoodle('data:image/png;base64,' + huge.toString('base64')), null);
});

test('a doodle can be the whole letter and follows the letter\'s visibility', async () => {
  const t = setup();
  const res = await t.send({ name: 'Ivy', text: '', doodle: PNG });
  assert.equal(res.status, 201);
  const letter = (await res.json()) as Letter;
  const cookie = cookieOf(res);
  assert.equal(letter.hasDoodle, true);
  assert.equal((await t.send({ name: 'Ivy', text: 'x', doodle: 'data:image/png;base64,AAAA' }, cookie)).status, 400);

  // Before Ampli has read it: only the sender sees the doodle.
  assert.equal((await t.app.request(`/api/mail/${letter.id}/doodle`)).status, 404);
  const own = await t.app.request(`/api/mail/${letter.id}/doodle`, { headers: { cookie } });
  assert.equal(own.headers.get('content-type'), 'image/png');

  const [check] = (await (await t.brain('/api/brain/mail/checks')).json()) as (Letter & { doodle?: string })[];
  assert.equal(check!.doodle, PNG, 'the brain gets the image for the check');
  await t.brain(`/api/brain/mail/${letter.id}/verdict`, { verdict: 'ok', reason: '' });
  const [waiting] = (await (await t.brain('/api/brain/mail/waiting')).json()) as BrainLetter[];
  assert.equal(waiting!.doodle, PNG, 'and for the reply');
  await t.brain(`/api/brain/mail/${letter.id}/reply`, { decision: 'reply', reply: 'Lovely cat!', doodleCaption: 'a cat' });

  assert.equal((await t.app.request(`/api/mail/${letter.id}/doodle`)).status, 200, 'on the board now');
  const read = (await t.get<WorldEvent[]>('/api/events')).find((e) => e.type === 'mail_read')!;
  assert.deepEqual(read.data, { letterId: letter.id, from: 'Ivy', text: '', reply: 'Lovely cat!', doodle: true, doodleCaption: 'a cat' });
});

test('private doodles stay with their sender', async () => {
  const t = setup();
  const res = await t.send({ name: 'Jo', text: 'for you', doodle: PNG, private: true });
  const { id } = (await res.json()) as Letter;
  await t.brain(`/api/brain/mail/${id}/verdict`, { verdict: 'ok', reason: '' });
  await t.brain(`/api/brain/mail/${id}/reply`, { decision: 'reply', reply: 'Thanks!', doodleCaption: 'a heart' });
  assert.equal((await t.app.request(`/api/mail/${id}/doodle`)).status, 404);
  assert.equal((await t.app.request(`/api/mail/${id}/doodle`, { headers: { cookie: cookieOf(res) } })).status, 200);
});

// --- Art studio --------------------------------------------------------------------------

const SVG = '<svg viewBox="0 0 400 300"><rect width="400" height="300" fill="#ffe"/><circle cx="200" cy="150" r="60" fill="#e07a3a"/></svg>';

test('artworks: unsafe SVG rejected, shown art served with a strict CSP', async () => {
  const t = setup();
  const bad = await t.brain('/api/brain/art', { title: 'x', caption: 'y', svg: '<svg onload="alert(1)"></svg>' });
  assert.equal(bad.status, 400);

  const art = (await (await t.brain('/api/brain/art', { title: 'Sunset fox', caption: 'Orange, mostly.', svg: SVG })).json()) as Artwork;
  assert.equal(art.status, 'shown');
  assert.deepEqual((await t.get<Artwork[]>('/api/art')).map((a) => a.title), ['Sunset fox']);
  assert.equal(t.sim.snapshot().latestArtId, art.id);

  const svg = await t.app.request(`/api/art/${art.id}.svg`);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml; charset=utf-8');
  assert.match(svg.headers.get('content-security-policy')!, /default-src 'none'/);
  assert.match(await svg.text(), /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  assert.ok((await t.get<WorldEvent[]>('/api/events')).some((e) => e.type === 'artwork_created'));
});

test('held artworks stay hidden until an admin approves them', async () => {
  const t = setup();
  const art = (await (
    await t.brain('/api/brain/art', { title: 'Odd one', caption: 'Hmm.', svg: SVG, held: true, note: 'unsure' })
  ).json()) as Artwork;
  assert.equal((await t.get<Artwork[]>('/api/art')).length, 0);
  assert.equal((await t.app.request(`/api/art/${art.id}.svg`)).status, 404);
  assert.equal(t.sim.snapshot().latestArtId, null);

  const held = (await (await admin(t, '/api/admin/art?view=held')).json()) as Artwork[];
  assert.equal(held.length, 1);
  await admin(t, `/api/admin/art/${art.id}/approve`, {});
  assert.equal((await t.get<Artwork[]>('/api/art')).length, 1);
  assert.equal((await t.app.request(`/api/art/${art.id}.svg`)).status, 200);
});

// --- Neighbours -----------------------------------------------------------------------------

test('chat lines resolve speaker names; neighbour notes are stored per neighbour', async () => {
  const sim = new Sim(new Store(':memory:'), new Map(), { name: 'Ampli', species: 'fox', town: 'X' }, 1, [
    { id: 'hedda', name: 'Hedda', species: 'hedgehog', place: 'cafe' },
  ]);
  const app = createApp(sim, { brainToken: TOKEN, webDist: '/nonexistent' });
  const brain = (path: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-brain-token': TOKEN },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  assert.equal((await brain('/api/brain/chat-line', { chatId: 1, speaker: 'stranger', text: 'hi' })).status, 400);
  await brain('/api/brain/chat-line', { chatId: 1, speaker: 'ampli', text: 'Morning, Hedda.' });
  await brain('/api/brain/chat-line', { chatId: 1, speaker: 'hedda', text: 'The usual?' });
  const lines = (await (await app.request('/api/events')).json() as WorldEvent[]).filter((e) => e.type === 'chat_line');
  assert.deepEqual(
    lines.map((e) => e.type === 'chat_line' && `${e.data.name}: ${e.data.text}`),
    ['Ampli: Morning, Hedda.', 'Hedda: The usual?'],
  );

  await brain('/api/brain/neighbor-notes', { neighborId: 'hedda', notes: ['Ampli likes strong coffee.'] });
  const ctx = (await (await brain('/api/brain/context')).json()) as { neighborNotes: Record<string, string[]> };
  assert.deepEqual(ctx.neighborNotes, { hedda: ['Ampli likes strong coffee.'] });
  assert.deepEqual(sim.snapshot().neighbors.map((n) => n.name), ['Hedda']);
});

// --- Notice board ----------------------------------------------------------------------------

test('notes: pinned ones are public, held ones never appear', async () => {
  const t = setup();
  await t.brain('/api/brain/note', { text: 'Does anyone want to tell me about their morning?' });
  await t.brain('/api/brain/note', { text: 'something that failed the check', held: true });
  const notes = await t.get<WorldEvent[]>('/api/notes');
  assert.deepEqual(
    notes.map((e) => e.type === 'note_posted' && e.data.text),
    ['Does anyone want to tell me about their morning?'],
  );
  const held = (await t.get<WorldEvent[]>('/api/events')).filter((e) => e.type === 'note_posted' && e.data.held);
  assert.deepEqual(held.map((e) => e.data), [{ held: true }], 'held notes leave a trace without their text');
  const ctx = (await (await t.brain('/api/brain/context')).json()) as { notesToday: number };
  assert.equal(ctx.notesToday, 2, 'held notes count towards the cap too');

  // The note cap is per sim day: a new sim day starts a fresh count.
  t.sim.engine.advance(24 * 60);
  const next = (await (await t.brain('/api/brain/context')).json()) as { notesToday: number };
  assert.equal(next.notesToday, 0);
});

// --- Ampli asks ------------------------------------------------------------------------------

test('questions: open until answered, answers are linked and hurry the brain', async () => {
  const t = setup();
  await t.brain('/api/brain/note', { text: 'What should I paint next?', question: true });
  const open = t.sim.snapshot().openQuestion!;
  assert.equal(open.text, 'What should I paint next?');

  await t.brain('/api/brain/note', { text: 'Just a thought.' });
  assert.equal(t.sim.snapshot().openQuestion?.id, open.id, 'plain notes are not questions');

  assert.equal((await t.send({ name: 'Mo', text: 'x', inReplyTo: 999 })).status, 400);
  const res = await t.send({ name: 'Mo', text: 'Paint the pond at night!', inReplyTo: open.id });
  const letter = (await res.json()) as Letter;
  assert.equal(letter.question, 'What should I paint next?');
  assert.equal(t.sim.snapshot().openQuestion, null, 'answered');

  await t.brain(`/api/brain/mail/${letter.id}/verdict`, { verdict: 'ok', reason: '' });
  const ctx = (await (await t.brain('/api/brain/context')).json()) as { mail: { answers: number } };
  assert.equal(ctx.mail.answers, 1);
  const [waiting] = (await (await t.brain('/api/brain/mail/waiting')).json()) as BrainLetter[];
  assert.equal(waiting!.question, 'What should I paint next?');

  await t.brain(`/api/brain/mail/${letter.id}/reply`, { decision: 'reply', reply: 'I will!' });
  const read = (await t.get<WorldEvent[]>('/api/events')).find((e) => e.type === 'mail_read')!;
  assert.equal(read.type === 'mail_read' && read.data.question, 'What should I paint next?');
});
