import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { NudgeMemory } from './gyros.ts';
import type {
  AdminLetter,
  ArtStatus,
  AdminBuild,
  BuildStatus,
  TownBuild,
  TownFrame,
  Artwork,
  CheckLetter,
  BrainLetter,
  DiaryEntry,
  EventBody,
  Letter,
  LetterStatus,
  LetterVisibility,
  LlmMeta,
  MailStats,
  UsageToday,
  VisitorProfile,
  WorldEvent,
} from '@ampli-world/shared';
import type { EngineState } from './engine.ts';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sim_time REAL NOT NULL,
    real_time TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_sim_time ON events (sim_time);
  CREATE INDEX IF NOT EXISTS events_type ON events (type);

  CREATE TABLE IF NOT EXISTS diary (
    day INTEGER PRIMARY KEY,
    sim_time REAL NOT NULL,
    text TEXT NOT NULL,
    llm TEXT
  );

  CREATE TABLE IF NOT EXISTS notebook (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sim_time REAL NOT NULL,
    notes TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    real_time TEXT NOT NULL,
    purpose TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS visitors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    name TEXT NOT NULL,
    text TEXT NOT NULL,
    visibility TEXT NOT NULL,
    status TEXT NOT NULL,
    created_real TEXT NOT NULL,
    created_sim REAL NOT NULL,
    reply TEXT,
    replied_sim REAL,
    -- Moderation or skip reason. Admin-only.
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS letters_status ON letters (status);

  CREATE TABLE IF NOT EXISTS artworks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sim_time REAL NOT NULL,
    real_time TEXT NOT NULL,
    title TEXT NOT NULL,
    caption TEXT NOT NULL,
    svg TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    llm TEXT
  );

  -- What the character built on the plots: every version stays, the newest shown one per plot stands.
  CREATE TABLE IF NOT EXISTS builds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plot TEXT NOT NULL,
    sim_time REAL NOT NULL,
    real_time TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    svg TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT,
    llm TEXT
  );
  CREATE INDEX IF NOT EXISTS builds_plot ON builds (plot, status);

  -- Which painting hangs on which frame.
  CREATE TABLE IF NOT EXISTS frames (
    frame TEXT PRIMARY KEY,
    art_id INTEGER NOT NULL,
    sim_time REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reports (
    letter_id INTEGER NOT NULL,
    reporter TEXT NOT NULL,
    created TEXT NOT NULL,
    PRIMARY KEY (letter_id, reporter)
  );
  CREATE INDEX IF NOT EXISTS letters_visitor ON letters (visitor_id);
`;

type Row = Record<string, unknown>;

function toEvent(row: Row): WorldEvent {
  return {
    id: Number(row.id),
    simTime: Number(row.sim_time),
    realTime: String(row.real_time),
    type: row.type,
    data: JSON.parse(String(row.data)),
  } as WorldEvent;
}

/** What a sender (or everyone, for public letters) may see. Held replies stay hidden. */
function toLetter(row: Row): Letter {
  const replied = row.status === 'replied' && row.reply;
  return {
    id: Number(row.id),
    name: String(row.name),
    text: String(row.text),
    visibility: row.visibility as LetterVisibility,
    status: row.status as LetterStatus,
    createdAt: String(row.created_real),
    createdSimTime: Number(row.created_sim),
    hasDoodle: row.doodle !== null && row.doodle !== undefined,
    ...(row.question ? { question: String(row.question) } : {}),
    ...(row.doodle_caption ? { doodleCaption: String(row.doodle_caption) } : {}),
    ...(replied ? { reply: String(row.reply), repliedSimTime: Number(row.replied_sim) } : {}),
  };
}

function toAdminBuild(row: Row): AdminBuild {
  return {
    id: Number(row.id),
    plot: String(row.plot),
    name: String(row.name),
    description: String(row.description),
    simTime: Number(row.sim_time),
    status: row.status as BuildStatus,
    createdAt: String(row.real_time),
    ...(row.note ? { note: String(row.note) } : {}),
  };
}

function toArtwork(row: Row): Artwork {
  return {
    id: Number(row.id),
    title: String(row.title),
    caption: String(row.caption),
    createdAt: String(row.real_time),
    simTime: Number(row.sim_time),
    status: row.status as ArtStatus,
    ...(row.llm ? { llm: JSON.parse(String(row.llm)) as LlmMeta } : {}),
  };
}

/**
 * Case-sensitive whole-word match for a name (names are written capitalised;
 * this keeps "Ben" from eating "bench"). Single letters are too risky to scrub.
 */
export function namePattern(name: string): RegExp | null {
  if (name.length < 2) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu');
}

function scrubStrings(value: unknown, pattern: RegExp): unknown {
  if (typeof value === 'string') return value.replace(pattern, 'a visitor');
  if (Array.isArray(value)) return value.map((v) => scrubStrings(v, pattern));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubStrings(v, pattern)]));
  }
  return value;
}

function toDiary(row: Row): DiaryEntry {
  return {
    day: Number(row.day),
    simTime: Number(row.sim_time),
    text: String(row.text),
    ...(row.llm ? { llm: JSON.parse(String(row.llm)) as LlmMeta } : {}),
  };
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.addColumn('visitors', 'memory_public', "TEXT NOT NULL DEFAULT ''");
    this.addColumn('visitors', 'memory_private', "TEXT NOT NULL DEFAULT ''");
    // Salted hash of the sender's IP, only for the per-IP rate limit. Deleted with the letter.
    this.addColumn('letters', 'ip_hash', 'TEXT');
    // data:image/png;base64,… and Ampli's description of it.
    this.addColumn('letters', 'doodle', 'TEXT');
    this.addColumn('letters', 'doodle_caption', 'TEXT');
    // Answers to Ampli's questions: the question's event id and its text (kept even if the event goes).
    this.addColumn('letters', 'in_reply_to', 'INTEGER');
    this.addColumn('letters', 'question', 'TEXT');
  }

  appendEvent(simTime: number, body: EventBody): WorldEvent {
    const realTime = new Date().toISOString();
    const res = this.db
      .prepare('INSERT INTO events (sim_time, real_time, type, data) VALUES (?, ?, ?, ?)')
      .run(simTime, realTime, body.type, JSON.stringify(body.data));
    return { ...body, id: Number(res.lastInsertRowid), simTime, realTime };
  }

  /** Newest `limit` events, returned oldest-first. */
  recentEvents(limit: number, beforeId?: number): WorldEvent[] {
    const rows = beforeId
      ? this.db.prepare('SELECT * FROM events WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId, limit)
      : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
    return (rows as Row[]).map(toEvent).reverse();
  }

  eventsSince(simTime: number, limit = 400): WorldEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE sim_time >= ? ORDER BY id ASC LIMIT ?')
      .all(simTime, limit);
    return (rows as Row[]).map(toEvent);
  }

  readCounts(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT json_extract(data, '$.bookId') AS book_id, COUNT(*) AS n
         FROM events WHERE type = 'reading' GROUP BY book_id`,
      )
      .all() as Row[];
    return new Map(rows.map((r) => [String(r.book_id), Number(r.n)]));
  }

  saveDiary(entry: DiaryEntry): void {
    this.db
      .prepare('INSERT OR REPLACE INTO diary (day, sim_time, text, llm) VALUES (?, ?, ?, ?)')
      .run(entry.day, entry.simTime, entry.text, entry.llm ? JSON.stringify(entry.llm) : null);
  }

  diary(limit = 30): DiaryEntry[] {
    const rows = this.db.prepare('SELECT * FROM diary ORDER BY day DESC LIMIT ?').all(limit) as Row[];
    return rows.map(toDiary);
  }

  lastDiary(): DiaryEntry | null {
    return this.diary(1)[0] ?? null;
  }

  /**
   * After a rename: the old name becomes the new one in what the character and its
   * neighbours remember right now (the latest notebook, the neighbours' notes). The diary
   * and past events stay as they were: that's history.
   */
  renameInMemory(from: string, to: string): number {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu');
    let changed = 0;
    const swap = (notes: string[]) =>
      notes.map((n) => {
        const next = n.replace(pattern, to);
        if (next !== n) changed++;
        return next;
      });
    const latest = this.db.prepare('SELECT id, notes FROM notebook ORDER BY id DESC LIMIT 1').get() as Row | undefined;
    if (latest) {
      this.db.prepare('UPDATE notebook SET notes = ? WHERE id = ?').run(JSON.stringify(swap(JSON.parse(String(latest.notes)) as string[])), Number(latest.id));
    }
    for (const row of this.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'neighbor_notes:%'").all() as Row[]) {
      this.db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(JSON.stringify(swap(JSON.parse(String(row.value)) as string[])), String(row.key));
    }
    return changed;
  }

  saveNotebook(simTime: number, notes: string[]): void {
    this.db.prepare('INSERT INTO notebook (sim_time, notes) VALUES (?, ?)').run(simTime, JSON.stringify(notes));
  }

  notebook(): string[] {
    const row = this.db.prepare('SELECT notes FROM notebook ORDER BY id DESC LIMIT 1').get() as Row | undefined;
    return row ? (JSON.parse(String(row.notes)) as string[]) : [];
  }

  recordLlmCall(purpose: string, meta: LlmMeta): void {
    this.db
      .prepare(
        `INSERT INTO llm_calls (real_time, purpose, model, prompt_tokens, completion_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(new Date().toISOString(), purpose, meta.model, meta.promptTokens, meta.completionTokens, meta.costUsd);
  }

  /** Events of one type since 00:00 UTC today. */
  countEventsToday(type: string): number {
    const since = `${new Date().toISOString().slice(0, 10)}T00:00:00`;
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE type = ? AND real_time >= ?')
      .get(type, since) as Row;
    return Number(row.n);
  }

  /** Events of one type since a sim time (e.g. the start of the current sim day). */
  countEventsSinceSim(type: string, simTime: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM events WHERE type = ? AND sim_time >= ?')
      .get(type, simTime) as Row;
    return Number(row.n);
  }

  /** How often an activity was started since 00:00 UTC today. */
  countActivityToday(kind: string): number {
    const since = `${new Date().toISOString().slice(0, 10)}T00:00:00`;
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE type = 'activity_started' AND json_extract(data, '$.kind') = ? AND real_time >= ?",
      )
      .get(kind, since) as Row;
    return Number(row.n);
  }

  /** What the character itself said lately, oldest first: to notice when one topic takes over. */
  recentOwnTexts(limit = 20): string[] {
    const rows = this.db
      .prepare(
        `SELECT type, data FROM events
         WHERE (type = 'thought' AND json_extract(data, '$.source') = 'llm')
            OR (type = 'note_posted' AND json_extract(data, '$.text') IS NOT NULL)
            OR type IN ('browsed', 'artwork_created')
            OR (type = 'chat_line' AND json_extract(data, '$.speaker') = 'ampli')
         ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.reverse().map((r) => {
      const d = JSON.parse(String(r.data)) as { text?: string; query?: string; title?: string; caption?: string };
      return r.type === 'browsed' ? (d.query ?? '') : r.type === 'artwork_created' ? `${d.title}. ${d.caption}` : (d.text ?? '');
    });
  }

  /** All events of these types, oldest first (for the Mind page). */
  eventsOfTypes(types: string[]): WorldEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE type IN (${types.map(() => '?').join(', ')}) ORDER BY id`)
      .all(...types) as Row[];
    return rows.map(toEvent);
  }

  /** Every night's notebook, oldest first. */
  notebookHistory(): { simTime: number; notes: string[] }[] {
    return (this.db.prepare('SELECT sim_time, notes FROM notebook ORDER BY id').all() as Row[]).map((r) => ({
      simTime: Number(r.sim_time),
      notes: JSON.parse(String(r.notes)) as string[],
    }));
  }

  /** The latest web searches, oldest first. */
  recentSearches(limit = 8): { query: string; takeaway?: string; simTime: number }[] {
    const rows = this.db
      .prepare("SELECT sim_time, data FROM events WHERE type = 'browsed' ORDER BY id DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.reverse().map((r) => {
      const data = JSON.parse(String(r.data)) as { query: string; takeaway?: string };
      return { query: data.query, ...(data.takeaway ? { takeaway: data.takeaway } : {}), simTime: Number(r.sim_time) };
    });
  }

  /** A book's latest readings, newest first: where reading continues. */
  readingsOf(bookId: string, limit = 12): { part?: number; parts?: number; takeaway: string }[] {
    const rows = this.db
      .prepare("SELECT data FROM events WHERE type = 'reading' AND json_extract(data, '$.bookId') = ? ORDER BY id DESC LIMIT ?")
      .all(bookId, limit) as Row[];
    return rows.map((r) => JSON.parse(String(r.data)) as { part?: number; parts?: number; takeaway: string });
  }

  neighborNotes(id: string): string[] {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(`neighbor_notes:${id}`) as Row | undefined;
    return row ? (JSON.parse(String(row.value)) as string[]) : [];
  }

  setNeighborNotes(id: string, notes: string[]): void {
    this.db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(`neighbor_notes:${id}`, JSON.stringify(notes));
  }

  /** Calls and spend since 00:00 UTC today. */
  usageToday(): UsageToday {
    const since = `${new Date().toISOString().slice(0, 10)}T00:00:00`;
    const row = this.db
      .prepare('SELECT COUNT(*) AS calls, COALESCE(SUM(cost_usd), 0) AS cost FROM llm_calls WHERE real_time >= ?')
      .get(since) as Row;
    return { calls: Number(row.calls), costUsd: Number(row.cost) };
  }

  // --- Mailbox ---

  touchVisitor(id: string, name: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO visitors (id, name, first_seen, last_seen) VALUES (?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
      )
      .run(id, name, now, now);
  }

  /** Records a visit without changing anything else. No-op for unknown visitors. */
  seeVisitor(id: string): void {
    this.db.prepare('UPDATE visitors SET last_seen = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  visitorProfile(id: string): VisitorProfile | null {
    const row = this.db.prepare('SELECT * FROM visitors WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    return {
      name: String(row.name),
      firstSeen: String(row.first_seen),
      lastSeen: String(row.last_seen),
      memory: { public: String(row.memory_public), private: String(row.memory_private) },
    };
  }

  visitorOfLetter(letterId: number): string | null {
    const row = this.db.prepare('SELECT visitor_id FROM letters WHERE id = ?').get(letterId) as Row | undefined;
    return row ? String(row.visitor_id) : null;
  }

  setVisitorMemory(id: string, scope: LetterVisibility, memory: string): void {
    const column = scope === 'public' ? 'memory_public' : 'memory_private';
    this.db.prepare(`UPDATE visitors SET ${column} = ? WHERE id = ?`).run(memory, id);
  }

  /** Waiting letters, each with only its own sender's memory attached. */
  waitingForBrain(limit: number): BrainLetter[] {
    const rows = this.db
      .prepare(
        `SELECT l.*, COALESCE(v.memory_public, '') AS mem_pub, COALESCE(v.memory_private, '') AS mem_priv,
           (SELECT COUNT(*) FROM letters p WHERE p.visitor_id = l.visitor_id AND p.status IN ('replied', 'skipped')) AS before
         FROM letters l LEFT JOIN visitors v ON v.id = l.visitor_id
         WHERE l.status = 'waiting' ORDER BY l.id ASC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((row) => ({
      ...toLetter(row),
      ...(row.doodle ? { doodle: String(row.doodle) } : {}),
      memory: { public: String(row.mem_pub), private: String(row.mem_priv) },
      lettersBefore: Number(row.before),
    }));
  }

  /** Letters waiting for the moderation check, with their doodles. */
  lettersForCheck(limit: number): CheckLetter[] {
    const rows = this.db
      .prepare("SELECT * FROM letters WHERE status = 'checking' ORDER BY id ASC LIMIT ?")
      .all(limit) as Row[];
    return rows.map((row) => ({ ...toLetter(row), ...(row.doodle ? { doodle: String(row.doodle) } : {}) }));
  }

  /** The doodle plus what's needed to decide who may see it. */
  letterDoodle(id: number): { visitorId: string; letter: Letter; doodle: string } | null {
    const row = this.db.prepare('SELECT * FROM letters WHERE id = ? AND doodle IS NOT NULL').get(id) as Row | undefined;
    return row ? { visitorId: String(row.visitor_id), letter: toLetter(row), doodle: String(row.doodle) } : null;
  }

  // --- Art studio ---

  createArtwork(a: { simTime: number; title: string; caption: string; svg: string; status: ArtStatus; note?: string; llm?: LlmMeta }): Artwork {
    const res = this.db
      .prepare(
        'INSERT INTO artworks (sim_time, real_time, title, caption, svg, status, note, llm) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(a.simTime, new Date().toISOString(), a.title, a.caption, a.svg, a.status, a.note ?? null, a.llm ? JSON.stringify(a.llm) : null);
    return this.artwork(Number(res.lastInsertRowid))!;
  }

  artwork(id: number): Artwork | null {
    const row = this.db.prepare('SELECT * FROM artworks WHERE id = ?').get(id) as Row | undefined;
    return row ? toArtwork(row) : null;
  }

  artworkSvg(id: number): { status: ArtStatus; svg: string } | null {
    const row = this.db.prepare('SELECT status, svg FROM artworks WHERE id = ?').get(id) as Row | undefined;
    return row ? { status: row.status as ArtStatus, svg: String(row.svg) } : null;
  }

  gallery(limit = 60): Artwork[] {
    const rows = this.db
      .prepare("SELECT * FROM artworks WHERE status = 'shown' ORDER BY id DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map(toArtwork);
  }

  adminArt(view: 'held' | 'recent', limit = 60): (Artwork & { note?: string })[] {
    const rows = this.db
      .prepare(
        view === 'held'
          ? "SELECT * FROM artworks WHERE status = 'held' ORDER BY id ASC LIMIT ?"
          : 'SELECT * FROM artworks ORDER BY id DESC LIMIT ?',
      )
      .all(limit) as Row[];
    return rows.map((row) => ({ ...toArtwork(row), ...(row.note ? { note: String(row.note) } : {}) }));
  }

  setArtStatus(id: number, status: ArtStatus): void {
    this.db.prepare('UPDATE artworks SET status = ? WHERE id = ?').run(status, id);
    // It may hang somewhere in town.
    this.bumpTownVersion();
  }

  latestArtId(): number | null {
    const row = this.db.prepare("SELECT MAX(id) AS id FROM artworks WHERE status = 'shown'").get() as Row;
    return row.id === null ? null : Number(row.id);
  }

  /** Artworks made since 00:00 UTC (any status), for the daily cap. */
  countArtToday(): number {
    const since = `${new Date().toISOString().slice(0, 10)}T00:00:00`;
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM artworks WHERE real_time >= ?').get(since) as Row;
    return Number(row.n);
  }

  // --- Things built and hung in town ---

  createBuild(b: { plot: string; simTime: number; name: string; description: string; svg: string; status: ArtStatus; note?: string; llm?: LlmMeta }): number {
    if (b.status === 'shown') this.replaceOnPlot(b.plot);
    const res = this.db
      .prepare('INSERT INTO builds (plot, sim_time, real_time, name, description, svg, status, note, llm) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(b.plot, b.simTime, new Date().toISOString(), b.name, b.description, b.svg, b.status, b.note ?? null, b.llm ? JSON.stringify(b.llm) : null);
    if (b.status === 'shown') this.bumpTownVersion();
    return Number(res.lastInsertRowid);
  }

  /** Whatever stood on the plot is replaced, so hiding the new one later leaves the plot empty. */
  private replaceOnPlot(plot: string): void {
    this.db.prepare("UPDATE builds SET status = 'replaced' WHERE plot = ? AND status = 'shown'").run(plot);
  }

  adminBuilds(limit = 60): AdminBuild[] {
    return (this.db.prepare('SELECT * FROM builds ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(toAdminBuild);
  }

  /** Shows a build (it replaces what stands on its plot) or takes it down (the plot is empty then). */
  setBuildStatus(id: number, status: 'shown' | 'hidden'): void {
    const row = this.db.prepare('SELECT plot FROM builds WHERE id = ?').get(id) as Row | undefined;
    if (!row) return;
    if (status === 'shown') this.replaceOnPlot(String(row.plot));
    this.db.prepare('UPDATE builds SET status = ? WHERE id = ?').run(status, id);
    this.bumpTownVersion();
  }

  build(id: number): AdminBuild | null {
    const row = this.db.prepare('SELECT * FROM builds WHERE id = ?').get(id) as Row | undefined;
    return row ? toAdminBuild(row) : null;
  }

  /** What stands on each plot now: its newest shown build. */
  currentBuilds(): TownBuild[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM builds b WHERE status = 'shown' AND id = (SELECT MAX(id) FROM builds WHERE plot = b.plot AND status = 'shown') ORDER BY id",
      )
      .all() as Row[];
    return rows.map((row) => ({
      id: Number(row.id),
      plot: String(row.plot),
      name: String(row.name),
      description: String(row.description),
      simTime: Number(row.sim_time),
    }));
  }

  buildSvg(id: number): { status: BuildStatus; svg: string } | null {
    const row = this.db.prepare('SELECT status, svg FROM builds WHERE id = ?').get(id) as Row | undefined;
    return row ? { status: row.status as BuildStatus, svg: String(row.svg) } : null;
  }

  /** Builds since 00:00 UTC (any status), for the daily cap. */
  countBuildsToday(): number {
    const since = `${new Date().toISOString().slice(0, 10)}T00:00:00`;
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM builds WHERE real_time >= ?').get(since) as Row).n);
  }

  /** Hangs a painting on a frame; returns the id of the one it replaced, if any. */
  hangPainting(frame: string, artId: number, simTime: number): number | null {
    const before = this.db.prepare('SELECT art_id FROM frames WHERE frame = ?').get(frame) as Row | undefined;
    this.db.prepare('INSERT OR REPLACE INTO frames (frame, art_id, sim_time) VALUES (?, ?, ?)').run(frame, artId, simTime);
    this.bumpTownVersion();
    return before ? Number(before.art_id) : null;
  }

  /** Paintings on the frames (only those still shown in the gallery). */
  hungPaintings(): TownFrame[] {
    const rows = this.db
      .prepare("SELECT f.frame, f.art_id, f.sim_time, a.title FROM frames f JOIN artworks a ON a.id = f.art_id WHERE a.status = 'shown' ORDER BY f.frame")
      .all() as Row[];
    return rows.map((row) => ({ frame: String(row.frame), artId: Number(row.art_id), title: String(row.title), simTime: Number(row.sim_time) }));
  }

  townVersion(): number {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = 'town_version'").get() as Row | undefined;
    return row ? Number(row.value) : 0;
  }

  private bumpTownVersion(): void {
    this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('town_version', ?)").run(String(this.townVersion() + 1));
  }

  /** Visitors whose last visit is older than `beforeIso`. */
  expiredVisitors(beforeIso: string): string[] {
    const rows = this.db.prepare('SELECT id FROM visitors WHERE last_seen < ?').all(beforeIso) as Row[];
    return rows.map((r) => String(r.id));
  }

  /**
   * Deletes a visitor with all their letters and the events about them, and
   * replaces their name with "a visitor" in the diary, the notebook and thoughts.
   */
  forgetVisitor(id: string): { letters: number } {
    const letterRows = this.db.prepare('SELECT id, name FROM letters WHERE visitor_id = ?').all(id) as Row[];
    const visitor = this.db.prepare('SELECT name FROM visitors WHERE id = ?').get(id) as Row | undefined;
    const names = new Set([...letterRows.map((r) => String(r.name)), ...(visitor ? [String(visitor.name)] : [])]);
    const letterIds = letterRows.map((r) => Number(r.id));

    this.db.exec('BEGIN');
    try {
      const dropEvent = this.db.prepare(
        "DELETE FROM events WHERE type = 'mail_read' AND json_extract(data, '$.letterId') = ?",
      );
      for (const letterId of letterIds) dropEvent.run(letterId);
      this.db
        .prepare('DELETE FROM reports WHERE letter_id IN (SELECT id FROM letters WHERE visitor_id = ?)')
        .run(id);
      this.db.prepare('DELETE FROM letters WHERE visitor_id = ?').run(id);
      this.db.prepare('DELETE FROM visitors WHERE id = ?').run(id);
      for (const name of names) this.scrubName(name);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { letters: letterIds.length };
  }

  private scrubName(name: string): void {
    const pattern = namePattern(name);
    if (!pattern) return;
    const like = `%${name}%`;

    const events = this.db
      .prepare("SELECT id, data FROM events WHERE type IN ('thought', 'reading', 'mail_read') AND data LIKE ?")
      .all(like) as Row[];
    const updateEvent = this.db.prepare('UPDATE events SET data = ? WHERE id = ?');
    for (const row of events) {
      const data = scrubStrings(JSON.parse(String(row.data)), pattern);
      updateEvent.run(JSON.stringify(data), Number(row.id));
    }

    const diary = this.db.prepare('SELECT day, text FROM diary WHERE text LIKE ?').all(like) as Row[];
    const updateDiary = this.db.prepare('UPDATE diary SET text = ? WHERE day = ?');
    for (const row of diary) updateDiary.run(String(row.text).replace(pattern, 'a visitor'), Number(row.day));

    const notebooks = this.db.prepare('SELECT id, notes FROM notebook WHERE notes LIKE ?').all(like) as Row[];
    const updateNotebook = this.db.prepare('UPDATE notebook SET notes = ? WHERE id = ?');
    for (const row of notebooks) {
      updateNotebook.run(JSON.stringify(scrubStrings(JSON.parse(String(row.notes)), pattern)), Number(row.id));
    }
  }

  createLetter(l: {
    visitorId: string;
    name: string;
    text: string;
    visibility: LetterVisibility;
    simTime: number;
    ipHash?: string;
    doodle?: string;
    inReplyTo?: { id: number; question: string };
  }): Letter {
    const res = this.db
      .prepare(
        `INSERT INTO letters (visitor_id, name, text, visibility, status, created_real, created_sim, ip_hash, doodle,
           in_reply_to, question)
         VALUES (?, ?, ?, ?, 'checking', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        l.visitorId,
        l.name,
        l.text,
        l.visibility,
        new Date().toISOString(),
        l.simTime,
        l.ipHash ?? null,
        l.doodle ?? null,
        l.inReplyTo?.id ?? null,
        l.inReplyTo?.question ?? null,
      );
    return this.letter(Number(res.lastInsertRowid))!;
  }

  letter(id: number): Letter | null {
    const row = this.db.prepare('SELECT * FROM letters WHERE id = ?').get(id) as Row | undefined;
    return row ? toLetter(row) : null;
  }

  lettersByVisitor(visitorId: string, limit = 30): Letter[] {
    const rows = this.db
      .prepare('SELECT * FROM letters WHERE visitor_id = ? ORDER BY id DESC LIMIT ?')
      .all(visitorId, limit) as Row[];
    return rows.map(toLetter);
  }

  lettersByStatus(status: LetterStatus, limit: number): Letter[] {
    const rows = this.db
      .prepare('SELECT * FROM letters WHERE status = ? ORDER BY id ASC LIMIT ?')
      .all(status, limit) as Row[];
    return rows.map(toLetter);
  }

  /** Public letters Ampli has read, newest first. */
  board(limit = 50): Letter[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM letters WHERE visibility = 'public' AND status IN ('replied', 'skipped')
         ORDER BY replied_sim DESC, id DESC LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map(toLetter);
  }

  countLettersSince(visitorId: string, sinceIso: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM letters WHERE visitor_id = ? AND created_real >= ?')
      .get(visitorId, sinceIso) as Row;
    return Number(row.n);
  }

  countLettersByIpSince(ipHash: string, sinceIso: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM letters WHERE ip_hash = ? AND created_real >= ?')
      .get(ipHash, sinceIso) as Row;
    return Number(row.n);
  }

  // --- GyrOS workshop bell ---

  loadGyrosNudges(): NudgeMemory | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = 'gyros_nudges'").get() as Row | undefined;
    if (!row) return null;
    try {
      return JSON.parse(String(row.value)) as NudgeMemory;
    } catch {
      return null;
    }
  }

  saveGyrosNudges(memory: NudgeMemory): void {
    this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('gyros_nudges', ?)").run(JSON.stringify(memory));
  }

  // --- Moderation & admin ---

  isMailboxPaused(): boolean {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = 'mailbox_paused'").get() as Row | undefined;
    return row?.value === 'true';
  }

  setMailboxPaused(paused: boolean): void {
    this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('mailbox_paused', ?)").run(String(paused));
  }

  /** Records a report once per reporter; returns how many distinct reporters this letter has. */
  addReport(letterId: number, reporter: string): number {
    this.db
      .prepare('INSERT OR IGNORE INTO reports (letter_id, reporter, created) VALUES (?, ?, ?)')
      .run(letterId, reporter, new Date().toISOString());
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE letter_id = ?').get(letterId) as Row;
    return Number(row.n);
  }

  clearReports(letterId: number): void {
    this.db.prepare('DELETE FROM reports WHERE letter_id = ?').run(letterId);
  }

  adminLetter(id: number): AdminLetter | null {
    return this.adminLetters('SELECT * FROM letters WHERE id = ?', id)[0] ?? null;
  }

  adminList(view: 'held' | 'reported' | 'recent', limit = 100): AdminLetter[] {
    if (view === 'held') return this.adminLetters("SELECT * FROM letters WHERE status = 'held' ORDER BY id ASC LIMIT ?", limit);
    if (view === 'reported') {
      return this.adminLetters(
        `SELECT * FROM letters WHERE id IN (SELECT letter_id FROM reports) AND status != 'hidden'
         ORDER BY id DESC LIMIT ?`,
        limit,
      );
    }
    return this.adminLetters('SELECT * FROM letters ORDER BY id DESC LIMIT ?', limit);
  }

  private adminLetters(sql: string, ...params: (string | number)[]): AdminLetter[] {
    const rows = this.db.prepare(sql).all(...params) as Row[];
    const reports = this.db.prepare('SELECT COUNT(*) AS n FROM reports WHERE letter_id = ?');
    return rows.map((row) => ({
      ...toLetter(row),
      visitorId: String(row.visitor_id),
      ...(row.reply ? { draftReply: String(row.reply) } : {}),
      ...(row.note ? { note: String(row.note) } : {}),
      reports: Number((reports.get(Number(row.id)) as Row).n),
    }));
  }

  /** Admin override: any status to any status. */
  setLetterStatus(id: number, status: LetterStatus, note?: string): void {
    this.db
      .prepare('UPDATE letters SET status = ?, note = COALESCE(?, note) WHERE id = ?')
      .run(status, note ?? null, id);
  }

  /** Removes a letter from the public event log (feed, diary and decision context). */
  deleteMailEvent(letterId: number): void {
    this.db.prepare("DELETE FROM events WHERE type = 'mail_read' AND json_extract(data, '$.letterId') = ?").run(letterId);
  }

  letterCounts(): Record<LetterStatus, number> {
    const counts: Record<LetterStatus, number> = { checking: 0, held: 0, waiting: 0, replied: 0, skipped: 0, hidden: 0 };
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM letters GROUP BY status').all() as Row[];
    for (const r of rows) counts[r.status as LetterStatus] = Number(r.n);
    return counts;
  }

  reportedCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(DISTINCT letter_id) AS n FROM reports r JOIN letters l ON l.id = r.letter_id WHERE l.status != 'hidden'")
      .get() as Row;
    return Number(row.n);
  }

  /** Letters not yet read: being checked or in the post box. */
  countOpenLetters(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM letters WHERE status IN ('checking', 'waiting')")
      .get() as Row;
    return Number(row.n);
  }

  /** What the brain and map see. A paused mailbox looks empty, so Ampli doesn't go to the post box. */
  mailStats(): MailStats {
    if (this.isMailboxPaused()) return { waiting: 0, oldestSimTime: null, answers: 0, oldestAnswerSimTime: null };
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(created_sim) AS oldest,
           SUM(in_reply_to IS NOT NULL) AS answers, MIN(CASE WHEN in_reply_to IS NOT NULL THEN created_sim END) AS oldest_answer
         FROM letters WHERE status = 'waiting'`,
      )
      .get() as Row;
    return {
      waiting: Number(row.n),
      oldestSimTime: row.oldest === null ? null : Number(row.oldest),
      answers: Number(row.answers ?? 0),
      oldestAnswerSimTime: row.oldest_answer === null ? null : Number(row.oldest_answer),
    };
  }

  /** A pinned question (not held), if it is one. */
  question(eventId: number): { id: number; text: string; simTime: number } | null {
    const row = this.db.prepare("SELECT * FROM events WHERE id = ? AND type = 'note_posted'").get(eventId) as
      | Row
      | undefined;
    if (!row) return null;
    const data = JSON.parse(String(row.data)) as { text?: string; question?: boolean; held?: boolean };
    return data.question && data.text && !data.held ? { id: eventId, text: data.text, simTime: Number(row.sim_time) } : null;
  }

  /** Ampli's newest question, as long as no letter answers it yet. */
  openQuestion(): { id: number; text: string; simTime: number } | null {
    const row = this.db
      .prepare(
        `SELECT id FROM events WHERE type = 'note_posted' AND json_extract(data, '$.question') = 1
         AND json_extract(data, '$.held') IS NULL ORDER BY id DESC LIMIT 1`,
      )
      .get() as Row | undefined;
    if (!row) return null;
    const answered = this.db.prepare('SELECT 1 FROM letters WHERE in_reply_to = ? LIMIT 1').get(Number(row.id));
    return answered ? null : this.question(Number(row.id));
  }

  /** Moves a letter from `from` to `to`. Returns false if it wasn't in `from` (already handled). */
  transitionLetter(
    id: number,
    from: LetterStatus,
    to: LetterStatus,
    fields: { reply?: string; repliedSim?: number; note?: string; doodleCaption?: string } = {},
  ): boolean {
    const res = this.db
      .prepare(
        `UPDATE letters SET status = ?, reply = COALESCE(?, reply), replied_sim = COALESCE(?, replied_sim),
         note = COALESCE(?, note), doodle_caption = COALESCE(?, doodle_caption) WHERE id = ? AND status = ?`,
      )
      .run(to, fields.reply ?? null, fields.repliedSim ?? null, fields.note ?? null, fields.doodleCaption ?? null, id, from);
    return Number(res.changes) === 1;
  }

  loadState(): EngineState | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = 'state'").get() as Row | undefined;
    return row ? (JSON.parse(String(row.value)) as EngineState) : null;
  }

  saveState(state: EngineState): void {
    this.db
      .prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('state', ?)")
      .run(JSON.stringify(state));
  }

  /** Tiny migration helper: CREATE TABLE IF NOT EXISTS doesn't add columns to existing tables. */
  private addColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
    if (!columns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  close(): void {
    this.db.close();
  }
}
