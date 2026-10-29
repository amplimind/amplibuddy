import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import {
  LETTERS_PER_CHECK,
  MAX_ART_TITLE_CHARS,
  MAX_CAPTION_CHARS,
  MAX_DOODLE_BYTES,
  REPORTS_TO_HOLD,
  cleanSvg,
  MAX_MEMORY_CHARS,
  MAX_QUERY_CHARS,
  MAX_REPLY_CHARS,
  cleanName,
  cleanText,
  dayOf,
  isActivityKind,
  type AdminOverview,
  type BrainContext,
  type Letter,
  type LlmMeta,
  type Plan,
  type Thought,
  type WebSource,
} from '@ampli-world/shared';
import { withoutText } from './library.ts';
import type { Sim, SseMessage } from './sim.ts';

const MAX_THOUGHT_CHARS = 600;
const MAX_DIARY_CHARS = 4000;
const MAX_NOTES = 15;
const MAX_NOTE_CHARS = 300;
const MAX_CHAT_LINE_CHARS = 400;
const MAX_BOARD_NOTE_CHARS = 400;
const MAX_NEIGHBOR_NOTES = 8;
/** If the brain dies mid-thought, stop showing the thought bubble after this long. */
const THINKING_TIMEOUT_MS = 60_000;

const VISITOR_COOKIE = 'aw_visitor';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LETTERS_PER_HOUR = 3;
const LETTERS_PER_DAY = 10;
/** Catches visitors who clear cookies to get around the per-visitor limits. */
const LETTERS_PER_IP_PER_DAY = 20;
const POST_BOX_CAPACITY = 50;

function visitorId(c: Context): string | null {
  const id = getCookie(c, VISITOR_COOKIE);
  return id && UUID_RE.test(id) ? id : null;
}

/** Returns the visitor's id, issuing a new random one (httpOnly cookie) on first contact. */
function ensureVisitorId(c: Context): string {
  const existing = visitorId(c);
  if (existing) return existing;
  const id = randomUUID();
  const secure = new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
  setCookie(c, VISITOR_COOKIE, id, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: 365 * 86_400, secure });
  return id;
}

export interface AppOptions {
  brainToken: string;
  webDist: string;
  /** Enables /api/admin/* when set. */
  adminToken?: string;
  /** When set, the whole site (except brain endpoints) asks for this password. */
  sitePassword?: string;
  /** Salt for hashing IPs; random per process so hashes can't be linked across restarts. */
  ipSalt?: string;
}

/** The client IP, hashed: only ever used to count letters per sender. */
function ipHash(c: Context, salt: string): string {
  let ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  if (!ip) {
    try {
      ip = getConnInfo(c).remote.address;
    } catch {
      ip = 'unknown';
    }
  }
  return createHash('sha256').update(`${salt}:${ip ?? 'unknown'}`).digest('hex').slice(0, 32);
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

// --- Request validation (hand-rolled: the brain is our own code, but keep the sim honest) ---

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function shortString(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, max) : null;
}

function parseLlm(v: unknown): LlmMeta | undefined {
  if (!isRecord(v) || typeof v.model !== 'string') return undefined;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  return {
    model: v.model.slice(0, 120),
    promptTokens: num(v.promptTokens),
    completionTokens: num(v.completionTokens),
    costUsd: num(v.costUsd),
    latencyMs: num(v.latencyMs),
  };
}

function parseThought(v: unknown): Thought | null {
  if (!isRecord(v)) return null;
  const text = shortString(v.text, MAX_THOUGHT_CHARS);
  const source = v.source;
  if (!text || (source !== 'llm' && source !== 'routine' && source !== 'offline')) return null;
  const llm = parseLlm(v.llm);
  return { text, source, ...(llm ? { llm } : {}) };
}

const DOODLE_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_DOODLE_SIDE = 512;

/** A real, small PNG as a data URL, or null. Width/height come from the IHDR chunk. */
export function parseDoodle(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(DOODLE_PREFIX)) return null;
  const b64 = value.slice(DOODLE_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > MAX_DOODLE_BYTES || bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0 || width > MAX_DOODLE_SIDE || height > MAX_DOODLE_SIDE) return null;
  return value;
}

function pngResponse(dataUrl: string, cacheable: boolean): Response {
  return new Response(Buffer.from(dataUrl.slice(DOODLE_PREFIX.length), 'base64'), {
    headers: {
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'cache-control': cacheable ? 'public, max-age=86400' : 'private, no-store',
    },
  });
}

/** SVGs never run code here: strict CSP even if someone opens the URL directly. */
function svgResponse(svg: string): Response {
  return new Response(svg, {
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'public, max-age=86400',
    },
  });
}

const MAX_SOURCES = 5;

/** Only plain http(s) links from search results ever reach the page. */
function parseSources(v: unknown): WebSource[] {
  if (!Array.isArray(v)) return [];
  const sources: WebSource[] = [];
  for (const item of v) {
    if (!isRecord(item) || typeof item.url !== 'string') continue;
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    const title = shortString(item.title, 200) ?? url.hostname;
    sources.push({ title, url: url.toString() });
    if (sources.length === MAX_SOURCES) break;
  }
  return sources;
}

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createApp(sim: Sim, opts: AppOptions): Hono {
  const app = new Hono();
  const { engine, store, books } = sim;
  const salt = opts.ipSalt ?? randomUUID();

  // --- Optional site password. Brain endpoints have their own token and stay reachable. ---
  if (opts.sitePassword) {
    const password = opts.sitePassword;
    const gate = basicAuth({
      verifyUser: (_username, given) => tokenMatches(given, password),
      realm: 'Ampli World',
    });
    app.use('*', async (c, next) => (c.req.path.startsWith('/api/brain/') ? next() : gate(c, next)));
  }

  // --- Public, read-only ---

  app.get('/api/state', (c) => c.json(sim.snapshot()));

  app.get('/api/events', (c) => {
    const limit = Math.min(200, Number(c.req.query('limit') ?? 80) || 80);
    const before = Number(c.req.query('before')) || undefined;
    return c.json(store.recentEvents(limit, before));
  });

  app.get('/api/diary', (c) => c.json(store.diary()));
  app.get('/api/notebook', (c) => c.json(store.notebook()));
  app.get('/api/usage', (c) => c.json(store.usageToday()));

  app.get('/api/library', (c) => {
    const counts = store.readCounts();
    return c.json([...books.values()].map((b) => ({ ...withoutText(b), timesRead: counts.get(b.id) ?? 0 })));
  });

  // --- Mailbox (public) ---

  app.post('/api/mail', async (c) => {
    // JSON only: plain HTML forms from other sites can't send this content type.
    if (!c.req.header('content-type')?.includes('application/json')) return c.json({ error: 'json only' }, 415);
    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: 'bad request' }, 400);
    const name = cleanName(body.name);
    const doodle = body.doodle === undefined || body.doodle === null ? null : parseDoodle(body.doodle);
    if (body.doodle && !doodle) return c.json({ error: 'That doodle could not be read. Try a smaller one.' }, 400);
    const text = cleanText(body.text) ?? (doodle ? '' : null);
    if (!name) return c.json({ error: 'Please tell Ampli your name.' }, 400);
    if (text === null) return c.json({ error: 'The letter is empty.' }, 400);

    if (store.isMailboxPaused()) return c.json({ error: "Ampli's post box is closed for now." }, 503);
    const visitor = ensureVisitorId(c);
    const ip = ipHash(c, salt);
    if (store.countLettersByIpSince(ip, isoAgo(86_400_000)) >= LETTERS_PER_IP_PER_DAY) {
      return c.json({ error: 'Lots of letters from here today. Try again tomorrow.' }, 429);
    }
    if (store.countLettersSince(visitor, isoAgo(3_600_000)) >= LETTERS_PER_HOUR) {
      return c.json({ error: `That's ${LETTERS_PER_HOUR} letters this hour. Give Ampli a moment to catch up.` }, 429);
    }
    if (store.countLettersSince(visitor, isoAgo(86_400_000)) >= LETTERS_PER_DAY) {
      return c.json({ error: `That's ${LETTERS_PER_DAY} letters today. Try again tomorrow.` }, 429);
    }
    if (store.countOpenLetters() >= POST_BOX_CAPACITY) {
      return c.json({ error: 'The post box is full. Try again a bit later.' }, 429);
    }

    store.touchVisitor(visitor, name);
    const letter = store.createLetter({
      visitorId: visitor,
      name,
      text,
      visibility: body.private === true ? 'private' : 'public',
      simTime: engine.simTime,
      ipHash: ip,
      ...(doodle ? { doodle } : {}),
    });
    return c.json(letter, 201);
  });

  app.get('/api/mail/mine', (c) => {
    const visitor = visitorId(c);
    if (!visitor) return c.json([]);
    store.seeVisitor(visitor);
    return c.json(store.lettersByVisitor(visitor));
  });

  /** Everything Ampli knows about you (right of access). */
  app.get('/api/me', (c) => {
    const visitor = visitorId(c);
    return c.json(visitor ? store.visitorProfile(visitor) : null);
  });

  /** Right to erasure: letters, replies, memory, and your name in diary/notebook/thoughts. */
  app.post('/api/forget-me', (c) => {
    if (!c.req.header('content-type')?.includes('application/json')) return c.json({ error: 'json only' }, 415);
    const visitor = visitorId(c);
    if (!visitor) return c.json({ letters: 0 });
    const result = store.forgetVisitor(visitor);
    deleteCookie(c, VISITOR_COOKIE, { path: '/' });
    return c.json(result);
  });

  app.get('/api/board', (c) => c.json(store.board()));

  app.get('/api/mail/status', (c) => c.json({ open: !store.isMailboxPaused() }));

  /** Same visibility as the letter: on the board for everyone, otherwise only for its sender. */
  app.get('/api/mail/:id/doodle', (c) => {
    const found = store.letterDoodle(Number(c.req.param('id')));
    if (!found) return c.json({ error: 'not found' }, 404);
    const { letter, visitorId: owner, doodle } = found;
    const onBoard = letter.visibility === 'public' && (letter.status === 'replied' || letter.status === 'skipped');
    if (onBoard) return pngResponse(doodle, true);
    if (visitorId(c) === owner) return pngResponse(doodle, false);
    return c.json({ error: 'not found' }, 404);
  });

  /** Ampli's notes on the notice board, newest first. */
  app.get('/api/notes', (c) => {
    const notes = store
      .recentEvents(200)
      .filter((e) => e.type === 'note_posted' && !e.data.held)
      .reverse()
      .slice(0, 5);
    return c.json(notes);
  });

  // --- Art studio (public) ---

  app.get('/api/art', (c) => c.json(store.gallery(Math.min(100, Number(c.req.query('limit')) || 60))));

  app.get('/api/art/:file', (c) => {
    const match = /^(\d+)\.svg$/.exec(c.req.param('file'));
    const art = match ? store.artworkSvg(Number(match[1])) : null;
    if (!art || art.status !== 'shown') return c.json({ error: 'not found' }, 404);
    return svgResponse(art.svg);
  });

  /** Anyone can report a public letter once; enough reports take it off the board until an admin decides. */
  app.post('/api/mail/:id/report', (c) => {
    if (!c.req.header('content-type')?.includes('application/json')) return c.json({ error: 'json only' }, 415);
    const id = Number(c.req.param('id'));
    const letter = store.letter(id);
    if (!letter || letter.visibility !== 'public' || (letter.status !== 'replied' && letter.status !== 'skipped')) {
      return c.json({ error: 'not on the board' }, 404);
    }
    const reporter = visitorId(c) ?? `ip:${ipHash(c, salt)}`;
    if (store.addReport(id, reporter) >= REPORTS_TO_HOLD) {
      store.setLetterStatus(id, 'held', `taken down after ${REPORTS_TO_HOLD} reports`);
      store.deleteMailEvent(id);
    }
    return c.json({ ok: true });
  });

  app.get('/api/stream', (c) =>
    streamSSE(c, async (stream) => {
      const send = (msg: SseMessage) => {
        stream.writeSSE(msg).catch(() => {});
      };
      sim.hub.add(send);
      send({ event: 'state', data: JSON.stringify(sim.snapshot()) });
      await new Promise<void>((resolve) =>
        stream.onAbort(() => {
          sim.hub.delete(send);
          resolve();
        }),
      );
    }),
  );

  // --- Brain only ---

  app.use('/api/brain/*', async (c, next) => {
    if (opts.brainToken && !tokenMatches(c.req.header('x-brain-token'), opts.brainToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    await next();
  });

  app.get('/api/brain/context', (c) => {
    const counts = store.readCounts();
    const context: BrainContext = {
      snapshot: sim.snapshot(),
      idle: engine.idle,
      recentEvents: store.recentEvents(30),
      notebook: store.notebook(),
      lastDiary: store.lastDiary(),
      books: [...books.values()].map((b) => ({ ...withoutText(b), timesRead: counts.get(b.id) ?? 0 })),
      usageToday: store.usageToday(),
      mail: store.mailStats(),
      browsesToday: store.countEventsToday('browsed'),
      artToday: store.countArtToday(),
      chatsToday: store.countActivityToday('chat'),
      notesToday: store.countEventsToday('note_posted'),
      neighborNotes: Object.fromEntries(sim.neighbors.map((n) => [n.id, store.neighborNotes(n.id)])),
    };
    return c.json(context);
  });

  // A paused mailbox hands the brain nothing to check or answer.
  app.get('/api/brain/mail/checks', (c) => c.json(store.isMailboxPaused() ? [] : store.lettersForCheck(10)));

  app.post('/api/brain/mail/:id/verdict', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body) || (body.verdict !== 'ok' && body.verdict !== 'hold')) return c.json({ error: 'bad verdict' }, 400);
    const llm = parseLlm(body.llm);
    if (llm) store.recordLlmCall('moderation', llm);
    const note = shortString(body.reason, MAX_NOTE_CHARS) ?? undefined;
    const moved = store.transitionLetter(Number(c.req.param('id')), 'checking', body.verdict === 'ok' ? 'waiting' : 'held', {
      ...(note ? { note } : {}),
    });
    return moved ? c.json({ ok: true }) : c.json({ error: 'not being checked' }, 409);
  });

  app.get('/api/brain/mail/waiting', (c) => {
    const limit = Math.min(LETTERS_PER_CHECK, Number(c.req.query('limit')) || LETTERS_PER_CHECK);
    return c.json(store.isMailboxPaused() ? [] : store.waitingForBrain(limit));
  });

  app.post('/api/brain/mail/:id/reply', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body) || (body.decision !== 'reply' && body.decision !== 'skip')) {
      return c.json({ error: 'bad reply' }, 400);
    }
    for (const meta of Array.isArray(body.llm) ? body.llm : []) {
      const llm = parseLlm(meta);
      if (llm) store.recordLlmCall('mail', llm);
    }
    const id = Number(c.req.param('id'));
    const letter = store.letter(id);
    if (!letter || letter.status !== 'waiting') return c.json({ error: 'not in the post box' }, 409);

    const reply = body.decision === 'reply' ? cleanText(body.reply, MAX_REPLY_CHARS) : null;
    if (body.decision === 'reply' && !reply) return c.json({ error: 'empty reply' }, 400);
    const note = shortString(body.note, MAX_NOTE_CHARS) ?? undefined;
    const held = reply !== null && body.held === true;

    // Memory is scoped by the letter's visibility, so public replies never see private memories.
    const doodleCaption = letter.hasDoodle ? (cleanText(body.doodleCaption, MAX_CAPTION_CHARS) ?? undefined) : undefined;
    const memory = cleanText(body.memory, MAX_MEMORY_CHARS);
    const visitor = store.visitorOfLetter(id);
    if (memory && visitor) store.setVisitorMemory(visitor, letter.visibility, memory);
    const status = held ? 'held' : reply ? 'replied' : 'skipped';
    store.transitionLetter(id, 'waiting', status, {
      ...(reply ? { reply, repliedSim: engine.simTime } : {}),
      ...(note ? { note } : {}),
      ...(doodleCaption ? { doodleCaption } : {}),
    });

    // Only public, published content reaches the event log (and so the diary and decisions).
    if (letter.visibility === 'public' && !held) logMailRead(store.letter(id)!);
    else sim.log({ type: 'mail_read', data: { letterId: id } });
    return c.json({ ok: true, status });
  });

  app.get('/api/brain/events-since', (c) => {
    const since = Number(c.req.query('simTime')) || 0;
    return c.json(store.eventsSince(since));
  });

  app.get('/api/brain/books/:id', (c) => {
    const book = books.get(c.req.param('id'));
    return book ? c.json(book) : c.json({ error: 'no such book' }, 404);
  });

  app.post('/api/brain/thinking', (c) => {
    if (!engine.idle) return c.json({ error: 'busy' }, 409);
    engine.agent.thinking = true;
    setTimeout(() => {
      if (engine.idle) engine.agent.thinking = false;
    }, THINKING_TIMEOUT_MS);
    return c.json({ ok: true });
  });

  app.post('/api/brain/decision', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body) || !isRecord(body.plan)) return c.json({ error: 'bad request' }, 400);

    const thought = parseThought(body.thought);
    if (!thought) return c.json({ error: 'bad thought' }, 400);
    // Paid for regardless of whether the decision is accepted.
    if (thought.llm) store.recordLlmCall('decide', thought.llm);

    const { kind, bookId } = body.plan;
    if (!isActivityKind(kind)) return c.json({ error: `unknown activity ${String(kind)}` }, 400);
    if (kind === 'read' && (typeof bookId !== 'string' || !books.has(bookId))) {
      return c.json({ error: 'unknown book' }, 400);
    }
    const query = kind === 'browse' ? cleanText(body.plan.query, MAX_QUERY_CHARS) : null;
    if (kind === 'browse' && !query) return c.json({ error: 'browse needs a query' }, 400);
    const plan: Plan =
      kind === 'read' ? { kind, bookId: bookId as string } : query ? { kind, query } : { kind };

    if (!engine.idle) return c.json({ error: 'busy' }, 409);
    sim.log({ type: 'thought', data: thought });
    const result = engine.plan(plan);
    return result.ok ? c.json({ ok: true }) : c.json({ error: result.error }, 409);
  });

  app.post('/api/brain/reading', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: 'bad request' }, 400);
    const book = typeof body.bookId === 'string' ? books.get(body.bookId) : undefined;
    const takeaway = shortString(body.takeaway, MAX_THOUGHT_CHARS);
    if (!book || !takeaway) return c.json({ error: 'bad reading' }, 400);
    const llm = parseLlm(body.llm);
    if (llm) store.recordLlmCall('reading', llm);
    sim.log({ type: 'reading', data: { bookId: book.id, title: book.title, takeaway, ...(llm ? { llm } : {}) } });
    return c.json({ ok: true });
  });

  app.post('/api/brain/browse', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: 'bad request' }, 400);
    const query = cleanText(body.query, MAX_QUERY_CHARS);
    if (!query) return c.json({ error: 'missing query' }, 400);
    const metas = (Array.isArray(body.llm) ? body.llm : []).map(parseLlm).filter((m): m is LlmMeta => !!m);
    for (const meta of metas) store.recordLlmCall('browse', meta);

    const takeaway = body.held === true ? null : shortString(body.takeaway, MAX_THOUGHT_CHARS);
    sim.log({
      type: 'browsed',
      data: {
        query,
        ...(takeaway ? { takeaway } : {}),
        sources: parseSources(body.sources),
        ...(metas[0] ? { llm: metas[0] } : {}),
      },
    });
    return c.json({ ok: true });
  });

  app.post('/api/brain/note', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: 'bad request' }, 400);
    const metas = (Array.isArray(body.llm) ? body.llm : []).map(parseLlm).filter((m): m is LlmMeta => !!m);
    for (const meta of metas) store.recordLlmCall('note', meta);
    const text = shortString(body.text, MAX_BOARD_NOTE_CHARS);
    if (!text) return c.json({ error: 'empty note' }, 400);
    if (body.held === true) {
      // Logged without the text: the public sees that it happened, Ampli learns it didn't get pinned.
      sim.log({ type: 'note_posted', data: { held: true } });
      return c.json({ ok: true, pinned: false });
    }
    sim.log({ type: 'note_posted', data: { text, ...(metas[0] ? { llm: metas[0] } : {}) } });
    return c.json({ ok: true, pinned: true });
  });

  app.post('/api/brain/chat-line', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body) || typeof body.chatId !== 'number' || typeof body.speaker !== 'string') {
      return c.json({ error: 'bad request' }, 400);
    }
    const name = body.speaker === 'ampli' ? sim.persona.name : sim.neighbors.find((n) => n.id === body.speaker)?.name;
    const text = shortString(body.text, MAX_CHAT_LINE_CHARS);
    if (!name || !text) return c.json({ error: 'unknown speaker or empty line' }, 400);
    const llm = parseLlm(body.llm);
    if (llm) store.recordLlmCall('chat', llm);
    sim.log({
      type: 'chat_line',
      data: { chatId: body.chatId, speaker: body.speaker, name, text, ...(llm ? { llm } : {}) },
    });
    return c.json({ ok: true });
  });

  app.post('/api/brain/neighbor-notes', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body) || !sim.neighbors.some((n) => n.id === body.neighborId) || !Array.isArray(body.notes)) {
      return c.json({ error: 'bad request' }, 400);
    }
    const llm = parseLlm(body.llm);
    if (llm) store.recordLlmCall('chat', llm);
    const notes = body.notes
      .map((n) => shortString(n, MAX_NOTE_CHARS))
      .filter((n): n is string => n !== null)
      .slice(0, MAX_NEIGHBOR_NOTES);
    store.setNeighborNotes(String(body.neighborId), notes);
    return c.json({ ok: true });
  });

  app.post('/api/brain/art', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: 'bad request' }, 400);
    const metas = (Array.isArray(body.llm) ? body.llm : []).map(parseLlm).filter((m): m is LlmMeta => !!m);
    for (const meta of metas) store.recordLlmCall('art', meta);
    const title = cleanText(body.title, MAX_ART_TITLE_CHARS);
    const caption = shortString(body.caption, MAX_THOUGHT_CHARS);
    const svg = cleanSvg(body.svg);
    if (!title || !caption || !svg) return c.json({ error: 'unusable artwork' }, 400);

    const held = body.held === true;
    const art = store.createArtwork({
      simTime: engine.simTime,
      title,
      caption,
      svg,
      status: held ? 'held' : 'shown',
      ...(held ? { note: shortString(body.note, MAX_NOTE_CHARS) ?? 'held by the check' } : {}),
      ...(metas[0] ? { llm: metas[0] } : {}),
    });
    if (!held) {
      sim.log({
        type: 'artwork_created',
        data: { artworkId: art.id, title, caption, ...(metas[0] ? { llm: metas[0] } : {}) },
      });
    }
    return c.json(art);
  });

  app.post('/api/brain/diary', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body)) return c.json({ error: 'bad request' }, 400);
    const text = shortString(body.text, MAX_DIARY_CHARS);
    const day = typeof body.day === 'number' ? body.day : dayOf(engine.simTime);
    if (!text) return c.json({ error: 'empty diary' }, 400);
    const llm = parseLlm(body.llm);
    if (llm) store.recordLlmCall('diary', llm);

    store.saveDiary({ day, simTime: engine.simTime, text, ...(llm ? { llm } : {}) });
    if (Array.isArray(body.notebook)) {
      const notes = body.notebook
        .map((n) => shortString(n, MAX_NOTE_CHARS))
        .filter((n): n is string => n !== null)
        .slice(0, MAX_NOTES);
      if (notes.length > 0) store.saveNotebook(engine.simTime, notes);
    }
    sim.log({ type: 'diary_written', data: { day } });
    return c.json({ ok: true });
  });

  // --- Admin ---

  app.use('/api/admin/*', async (c, next) => {
    if (!opts.adminToken) return c.json({ error: 'admin is disabled: set ADMIN_TOKEN' }, 403);
    if (!tokenMatches(c.req.header('x-admin-token'), opts.adminToken)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.get('/api/admin/overview', (c) => {
    const overview: AdminOverview = {
      paused: store.isMailboxPaused(),
      counts: store.letterCounts(),
      reported: store.reportedCount(),
      usageToday: store.usageToday(),
    };
    return c.json(overview);
  });

  app.get('/api/admin/letters', (c) => {
    const view = c.req.query('view');
    return c.json(store.adminList(view === 'held' || view === 'reported' ? view : 'recent'));
  });

  /** Puts the letter where it would be if the check had said ok, and dismisses reports. */
  app.post('/api/admin/letters/:id/approve', (c) => {
    const id = Number(c.req.param('id'));
    const letter = store.adminLetter(id);
    if (!letter) return c.json({ error: 'no such letter' }, 404);
    store.clearReports(id);
    if (letter.status === 'held' || letter.status === 'hidden') {
      if (letter.draftReply) {
        store.setLetterStatus(id, 'replied');
        logMailRead(store.letter(id)!);
      } else {
        store.setLetterStatus(id, 'waiting');
      }
    }
    return c.json(store.adminLetter(id));
  });

  app.post('/api/admin/letters/:id/hide', (c) => {
    const id = Number(c.req.param('id'));
    if (!store.adminLetter(id)) return c.json({ error: 'no such letter' }, 404);
    store.setLetterStatus(id, 'hidden', 'hidden by an admin');
    store.deleteMailEvent(id);
    return c.json(store.adminLetter(id));
  });

  app.get('/api/admin/letters/:id/doodle', (c) => {
    const found = store.letterDoodle(Number(c.req.param('id')));
    return found ? pngResponse(found.doodle, false) : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/admin/art', (c) => c.json(store.adminArt(c.req.query('view') === 'held' ? 'held' : 'recent')));

  app.get('/api/admin/art/:file', (c) => {
    const match = /^(\d+)\.svg$/.exec(c.req.param('file'));
    const art = match ? store.artworkSvg(Number(match[1])) : null;
    return art ? svgResponse(art.svg) : c.json({ error: 'not found' }, 404);
  });

  app.post('/api/admin/art/:id/:action', (c) => {
    const id = Number(c.req.param('id'));
    const action = c.req.param('action');
    const art = store.artwork(id);
    if (!art || (action !== 'approve' && action !== 'hide')) return c.json({ error: 'not found' }, 404);
    store.setArtStatus(id, action === 'approve' ? 'shown' : 'hidden');
    if (action === 'approve' && art.status === 'held') {
      sim.log({ type: 'artwork_created', data: { artworkId: id, title: art.title, caption: art.caption } });
    }
    return c.json(store.artwork(id));
  });

  app.post('/api/admin/mailbox', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (!isRecord(body) || typeof body.paused !== 'boolean') return c.json({ error: 'expected { paused }' }, 400);
    store.setMailboxPaused(body.paused);
    return c.json({ paused: body.paused });
  });

  /** Same privacy rule as the brain path: only public letters carry content into the event log. */
  function logMailRead(letter: Letter): void {
    sim.log({
      type: 'mail_read',
      data:
        letter.visibility === 'public'
          ? {
              letterId: letter.id,
              from: letter.name,
              text: letter.text,
              ...(letter.reply ? { reply: letter.reply } : {}),
              ...(letter.hasDoodle ? { doodle: true } : {}),
              ...(letter.doodleCaption ? { doodleCaption: letter.doodleCaption } : {}),
            }
          : { letterId: letter.id },
    });
  }

  // --- Built web client (production). In dev, Vite serves it and proxies /api here. ---

  if (existsSync(opts.webDist)) {
    const root = relative(process.cwd(), opts.webDist);
    app.use('/*', serveStatic({ root }));
    app.get('*', serveStatic({ path: join(root, 'index.html') }));
  }

  return app;
}
