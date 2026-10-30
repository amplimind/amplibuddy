import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir, totalmem } from 'node:os';
import { basename, join } from 'node:path';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Hono } from 'hono';
import { stream } from 'hono/streaming';
import {
  LOCAL_CONTEXT,
  LOOK_INFO,
  MAX_PDF_BYTES,
  MAX_PERSONALITY_CHARS,
  MAX_SETUP_NAME_CHARS,
  MAX_SETUP_SPECIES_CHARS,
  RESIDENT_PLACES,
  isLocalUrl,
  isLook,
  localAlias,
  GYROS_DEFAULTS,
  type GitProbe,
  type GyrosProbe,
  type LibraryBookDraft,
  lookOf,
  parseFrontmatter,
  parseHours,
  recommendLocalModel,
  type OllamaStatus,
  type EventBody,
  type PersonaDraft,
  type PersonalityTemplate,
  type PlaceId,
  type ResidentDraft,
  type SetupApply,
  type SetupState,
} from '@ampli-world/shared';
import {
  USER_WORLD_DIR,
  WORLD_DIR,
  neighborsDir,
  personaFile,
  readSettings,
  setupComplete,
  writeSettings,
  writeText,
} from '@ampli-world/shared/node';
import { PdfSupportMissing, deleteBook, extractPdf, libraryEntry, saveBook, type ShelfBook } from './library.ts';
import type { Store } from './store.ts';

// The setup wizard and settings page. Only reachable from this Mac (or with the admin
// token): it writes the characters' files and the settings, and can download models.
// After a change the launcher (or `npm run dev`'s watcher) restarts the sim and the brain.

const OLLAMA = 'http://127.0.0.1:11434';
const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key';
const MODEL_NAME = /^[a-z0-9][\w.\-/]*(:[\w.\-]+)?$/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopback(address: string | undefined): boolean {
  return !!address && (address === '::1' || address.startsWith('127.') || address === '::ffff:127.0.0.1');
}

/**
 * From this Mac: the connection is local and the Host header names this machine (so a
 * web page can't reach it through DNS rebinding). Or anyone with the admin token.
 */
export function canConfigure(c: Context, adminToken?: string): boolean {
  if (adminToken && tokenMatches(c.req.header('x-admin-token'), adminToken)) return true;
  let remote: string | undefined;
  try {
    remote = getConnInfo(c).remote.address;
  } catch {
    // Tests call the app without a socket.
    remote = '127.0.0.1';
  }
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  const host = (c.req.header('host') ?? '').replace(/:\d+$/, '').toLowerCase();
  return isLoopback(remote) && (!forwarded || isLoopback(forwarded)) && LOCAL_HOSTS.has(host);
}

/**
 * The page that sent the request is this site, or another page on this machine (the dev
 * server on :5173 proxies to the sim on :4300). Pages from anywhere else are refused.
 */
export function sameMachineOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    const from = new URL(origin);
    const to = (host ?? '').replace(/:\d+$/, '').toLowerCase();
    return from.host === host || (LOCAL_HOSTS.has(from.hostname) && LOCAL_HOSTS.has(to));
  } catch {
    return false;
  }
}

/** One line, no frontmatter breakers. */
function line(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').replace(/---/g, '-').trim().slice(0, max) : '';
}

function personality(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, MAX_PERSONALITY_CHARS) : '';
}

function hoursText(hours: ResidentDraft['hours']): string | null {
  return hours ? `${hours.from}-${hours.to}` : null;
}

function readMd(file: string) {
  return parseFrontmatter(readFileSync(file, 'utf8'));
}

function mdFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
}

function readPersona(): PersonaDraft {
  const { meta, body } = readMd(personaFile());
  return {
    name: meta.name ?? 'Ampli',
    species: meta.species ?? 'small fox',
    look: lookOf(meta.species, meta.look),
    town: meta.town ?? 'Mindhaven',
    personality: body,
  };
}

function readResidents(): ResidentDraft[] {
  const dir = neighborsDir();
  return mdFiles(dir).map((file) => {
    const { meta, body } = readMd(join(dir, file));
    const place = (meta.place && RESIDENT_PLACES.includes(meta.place as PlaceId) ? meta.place : 'cafe') as PlaceId;
    return {
      id: basename(file, '.md'),
      name: meta.name ?? basename(file, '.md'),
      species: meta.species ?? 'animal',
      look: lookOf(meta.species, meta.look),
      place,
      hours: parseHours(meta.hours) ?? null,
      personality: body,
      active: meta.active !== 'false',
    };
  });
}

function readTemplates(kind: 'characters' | 'residents'): PersonalityTemplate[] {
  const dir = join(WORLD_DIR, 'templates', kind);
  const templates = mdFiles(dir).map((file) => {
    const { meta, body } = readMd(join(dir, file));
    const place = meta.place && RESIDENT_PLACES.includes(meta.place as PlaceId) ? (meta.place as PlaceId) : undefined;
    return {
      id: basename(file, '.md'),
      title: meta.title ?? basename(file, '.md'),
      description: meta.description ?? '',
      personality: body,
      ...(meta.name ? { name: meta.name } : {}),
      ...(meta.species ? { species: meta.species } : {}),
      ...(isLook(meta.look) ? { look: meta.look } : {}),
      ...(place ? { place } : {}),
      ...(kind === 'residents' ? { hours: parseHours(meta.hours) ?? null } : {}),
    };
  });
  if (kind === 'characters') {
    // The persona that ships with the repo is a template too.
    const { meta, body } = readMd(join(WORLD_DIR, 'persona.md'));
    templates.unshift({
      id: 'original',
      title: `${meta.name ?? 'Ampli'} (original)`,
      description: 'The personality the town started with: autonomous, curious, finding out what it cares about.',
      personality: body,
    });
  }
  return templates;
}

export function setupState(): SetupState {
  const env = process.env;
  const settings = readSettings();
  return {
    complete: setupComplete(),
    persona: readPersona(),
    residents: readResidents(),
    brain: {
      mode: env.LLM_BASE_URL ? 'local' : env.OPENROUTER_API_KEY ? 'cloud' : null,
      model: env.BRAIN_MODEL ?? '',
      visionModel: env.VISION_MODEL ?? '',
      hasKey: !!(env.OPENROUTER_API_KEY || settings.llm?.openrouterKey),
    },
    speed: Number(env.SIM_MINUTES_PER_SECOND ?? 0.1),
    gyros: { url: env.GYROS_URL ?? '', uiUrl: env.GYROS_UI_URL ?? '' },
    building: env.BUILD !== 'off',
    templates: { characters: readTemplates('characters'), residents: readTemplates('residents') },
    machine: { ramGb: Math.round(totalmem() / 1024 ** 3) },
  };
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .slice(0, 24) || 'neighbour'
  );
}

function personaFileText(p: PersonaDraft): string {
  const name = line(p.name, MAX_SETUP_NAME_CHARS) || 'Ampli';
  const species = line(p.species, MAX_SETUP_SPECIES_CHARS) || LOOK_INFO[isLook(p.look) ? p.look : 'fox'].species;
  const look = isLook(p.look) ? p.look : lookOf(species);
  const town = line(p.town, MAX_SETUP_NAME_CHARS) || 'Mindhaven';
  return `---\nname: ${name}\nspecies: ${species}\nlook: ${look}\ntown: ${town}\n---\n${personality(p.personality)}\n`;
}

function residentFileText(r: ResidentDraft): string {
  const name = line(r.name, MAX_SETUP_NAME_CHARS) || 'Neighbour';
  const species = line(r.species, MAX_SETUP_SPECIES_CHARS) || 'animal';
  const look = isLook(r.look) ? r.look : lookOf(species);
  const place = RESIDENT_PLACES.includes(r.place) ? r.place : 'cafe';
  const hours = r.hours && Number.isInteger(r.hours.from) && Number.isInteger(r.hours.to) ? hoursText(r.hours) : null;
  const valid = hours && parseHours(hours) ? `hours: ${hours}\n` : '';
  return `---\nname: ${name}\nspecies: ${species}\nlook: ${look}\nplace: ${place}\nactive: ${r.active !== false}\n${valid}---\n${personality(r.personality)}\n`;
}

/** Writes the full resident list into your own folder; the ones left out are gone (with their notes). */
function saveResidents(residents: ResidentDraft[], store: Store): void {
  const dir = join(USER_WORLD_DIR, 'neighbors');
  const before = readResidents().map((r) => r.id!);
  const ids = new Set<string>();
  for (const r of residents.slice(0, 12)) {
    let id = r.id && /^[a-z0-9-]{1,40}$/.test(r.id) ? r.id : slug(r.name);
    for (let n = 2; ids.has(id); n++) id = `${slug(r.name)}-${n}`;
    ids.add(id);
    writeText(join(dir, `${id}.md`), residentFileText(r));
  }
  for (const file of mdFiles(dir)) {
    if (!ids.has(basename(file, '.md'))) unlinkSync(join(dir, file));
  }
  for (const id of before) if (!ids.has(id)) store.setNeighborNotes(id, []);
}

export function applySetup(body: SetupApply, store: Store, log: (event: EventBody) => void = () => {}): void {
  if (body.persona) {
    const before = readPersona();
    const text = personaFileText(body.persona);
    writeText(join(USER_WORLD_DIR, 'persona.md'), text);
    const after = parseFrontmatter(text).meta;
    // A new name reaches what's remembered right now, and the character is told, so it
    // isn't left wondering why the town it remembers has another name.
    for (const [what, from, to] of [
      ['town', before.town, after.town],
      ['character', before.name, after.name],
    ] as const) {
      if (!from || !to || from === to || from.length < 2) continue;
      store.renameInMemory(from, to);
      log({ type: 'renamed', data: { what, from, to } });
    }
  }
  if (body.residents) saveResidents(body.residents, store);

  const settings = readSettings();
  if (body.brain) {
    const { mode } = body.brain;
    const key = line(body.brain.openrouterKey, 200) || settings.llm?.openrouterKey;
    settings.llm =
      mode === 'local'
        ? {
            mode,
            model: line(body.brain.model, 80) || localAlias('gemma4:12b'),
            visionModel: line(body.brain.visionModel, 80),
            ...(key ? { openrouterKey: key } : {}),
          }
        : { mode: 'cloud', ...(key ? { openrouterKey: key } : {}) };
  }
  if (typeof body.speed === 'number' && body.speed > 0 && body.speed <= 60) settings.speed = body.speed;
  if (body.gyros) {
    // GyrOS must run on this machine: the sim only ever reads from a local one.
    const local = (value: unknown) => {
      const url = line(value, 200).replace(/\/+$/, '');
      return isLocalUrl(url) ? url : '';
    };
    settings.gyros = { url: local(body.gyros.url), uiUrl: local(body.gyros.uiUrl) };
  }
  const building = typeof body.building === 'boolean' && body.building !== (process.env.BUILD !== 'off');
  if (building) settings.building = body.building;
  if (body.complete) settings.setupComplete = true;
  if (body.brain || body.speed !== undefined || body.gyros || building || body.complete) writeSettings(settings);
}

async function ollamaStatus(): Promise<OllamaStatus> {
  const recommended = recommendLocalModel(totalmem() / 1024 ** 3);
  const installed =
    existsSync('/Applications/Ollama.app') || existsSync(join(homedir(), 'Applications/Ollama.app')) || existsSync('/usr/local/bin/ollama') || existsSync('/opt/homebrew/bin/ollama');
  try {
    const [version, tags] = await Promise.all([
      fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json() as Promise<{ version?: string }>),
      fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json() as Promise<{ models?: { name: string }[] }>),
    ]);
    return { installed: true, running: true, version: version.version ?? null, models: (tags.models ?? []).map((m) => m.name), recommended };
  } catch {
    return { installed, running: false, version: null, models: [], recommended };
  }
}

/** Our alias of a model, with a context that fits the prompts (Ollama's default can be 256k). */
async function createAlias(model: string): Promise<string> {
  const alias = localAlias(model);
  const res = await fetch(`${OLLAMA}/api/create`, {
    method: 'POST',
    body: JSON.stringify({ name: alias, model: alias, from: model, parameters: { num_ctx: LOCAL_CONTEXT }, stream: false }),
  });
  if (!res.ok) throw new Error(`could not prepare ${model}: ${(await res.text()).slice(0, 200)}`);
  return alias;
}

export function registerSetup(
  app: Hono,
  opts: { adminToken?: string; store: Store; books?: Map<string, ShelfBook>; log?: (event: EventBody) => void },
): void {
  const books = opts.books ?? new Map<string, ShelfBook>();
  /** Public: whether to show the wizard, and whether this viewer may change things. */
  app.get('/api/setup/status', (c) => c.json({ complete: setupComplete(), canConfigure: canConfigure(c, opts.adminToken) }));

  app.use('/api/setup/*', async (c, next) => {
    if (c.req.path === '/api/setup/status') return next();
    if (!canConfigure(c, opts.adminToken)) return c.json({ error: 'settings can only be changed on this Mac' }, 403);
    if (c.req.method !== 'GET') {
      // JSON only (a plain form can't send it) and from this site, so other web pages can't change settings.
      // PDFs come as application/pdf, which a web page can't send across sites without permission either.
      const type = c.req.header('content-type') ?? '';
      const pdf = c.req.path === '/api/setup/library/pdf' && type === 'application/pdf';
      if (!pdf && !type.includes('application/json')) return c.json({ error: 'JSON only' }, 415);
      if (!sameMachineOrigin(c.req.header('origin'), c.req.header('host'))) return c.json({ error: 'wrong origin' }, 403);
    }
    await next();
  });

  app.get('/api/setup', (c) => c.json(setupState()));

  app.post('/api/setup/apply', async (c) => {
    const body = (await c.req.json().catch(() => null)) as SetupApply | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'bad request' }, 400);
    if (body.residents && !Array.isArray(body.residents)) return c.json({ error: 'residents must be a list' }, 400);
    applySetup(body, opts.store, opts.log);
    return c.json({ ok: true, restarting: true });
  });

  // --- Library: books take effect at once, no restart ---

  app.get('/api/setup/library', (c) =>
    c.json([...books.values()].map(libraryEntry).sort((a, b) => a.title.localeCompare(b.title))),
  );

  app.get('/api/setup/library/:id', (c) => {
    const book = books.get(c.req.param('id'));
    if (!book) return c.json({ error: 'no such book' }, 404);
    const draft: LibraryBookDraft = { id: book.id, title: book.title, author: book.author, blurb: book.blurb, text: book.text };
    return c.json(draft);
  });

  app.post('/api/setup/library', async (c) => {
    const body = (await c.req.json().catch(() => null)) as LibraryBookDraft | null;
    const book = body && typeof body === 'object' ? saveBook(body, books) : null;
    return book ? c.json(libraryEntry(book)) : c.json({ error: 'a book needs a title and some text' }, 400);
  });

  app.delete('/api/setup/library/:id', (c) =>
    deleteBook(c.req.param('id'), books) ? c.json({ ok: true }) : c.json({ error: 'no such book' }, 404),
  );

  /** Reads the text out of an uploaded PDF, to check and complete before it goes on the shelf. */
  app.post('/api/setup/library/pdf', async (c) => {
    const length = Number(c.req.header('content-length') ?? 0);
    if (length > MAX_PDF_BYTES) return c.json({ error: `PDFs up to ${MAX_PDF_BYTES / 1024 / 1024} MB` }, 413);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > MAX_PDF_BYTES) return c.json({ error: `PDFs up to ${MAX_PDF_BYTES / 1024 / 1024} MB` }, 413);
    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') return c.json({ error: "that's not a PDF" }, 400);
    const name = decodeURIComponent(c.req.header('x-file-name') ?? 'document.pdf');
    try {
      const extract = await extractPdf(bytes, name);
      if (!extract.text) {
        return c.json({ error: 'No text found in this PDF. Scanned pages are images; they would need text recognition first.' }, 422);
      }
      return c.json(extract);
    } catch (err) {
      if (err instanceof PdfSupportMissing) return c.json({ error: err.message }, 501);
      return c.json({ error: `Couldn't read this PDF: ${(err as Error).message}` }, 422);
    }
  });

  app.get('/api/setup/ollama', async (c) => c.json(await ollamaStatus()));

  /** Is the Code Lab's Git server running, and is the town connected to it? */
  app.get('/api/setup/git', async (c) => {
    const url = (process.env.GIT_URL || 'http://localhost:3300').replace(/\/+$/, '');
    const probe: GitProbe = { running: false, url, version: null, connected: !!(process.env.GIT_URL && process.env.GIT_TOKEN) };
    if (!isLocalUrl(url)) return c.json(probe);
    try {
      const res = await fetch(`${url}/api/v1/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) Object.assign(probe, { running: true, version: ((await res.json()) as { version?: string }).version ?? null });
    } catch {
      // Not running.
    }
    return c.json(probe);
  });

  /** Is GyrOS running on this machine? Only local addresses are tried, and only its run list is read. */
  app.get('/api/setup/gyros', async (c) => {
    const url = (c.req.query('url') || process.env.GYROS_URL || GYROS_DEFAULTS.url).replace(/\/+$/, '');
    const probe: GyrosProbe = { running: false, url, runs: 0 };
    if (!isLocalUrl(url)) return c.json(probe);
    try {
      const res = await fetch(`${url}/runs`, { signal: AbortSignal.timeout(2000) });
      const runs = res.ok ? ((await res.json()) as unknown) : null;
      if (Array.isArray(runs)) Object.assign(probe, { running: true, runs: runs.length });
    } catch {
      // Not running.
    }
    return c.json(probe);
  });

  app.post('/api/setup/ollama/start', (c) => {
    // macOS: opens the Ollama app, which starts its server.
    execFile('open', ['-a', 'Ollama'], () => {});
    return c.json({ ok: true });
  });

  /** Downloads a model with Ollama, streaming its progress as JSON lines, then prepares our alias. */
  app.post('/api/setup/ollama/pull', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { model?: unknown } | null;
    const model = typeof body?.model === 'string' ? body.model.trim() : '';
    if (!MODEL_NAME.test(model)) return c.json({ error: 'not a model name' }, 400);
    c.header('content-type', 'application/x-ndjson');
    return stream(c, async (out) => {
      const send = (data: object) => out.write(`${JSON.stringify(data)}\n`);
      try {
        const res = await fetch(`${OLLAMA}/api/pull`, { method: 'POST', body: JSON.stringify({ model, stream: true }) });
        if (!res.ok || !res.body) throw new Error(`Ollama said ${res.status}`);
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk as Uint8Array, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const l of lines) {
            if (!l.trim()) continue;
            const p = JSON.parse(l) as { status?: string; completed?: number; total?: number; error?: string };
            if (p.error) throw new Error(p.error);
            await send({ status: p.status ?? '', completed: p.completed ?? 0, total: p.total ?? 0 });
          }
        }
        await send({ status: 'ready', alias: await createAlias(model) });
      } catch (err) {
        await send({ status: 'error', error: (err as Error).message });
      }
    });
  });

  /** Checks an OpenRouter key with OpenRouter itself; the key goes nowhere else. */
  app.post('/api/setup/openrouter/check', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null;
    const key = typeof body?.key === 'string' ? body.key.trim() : '';
    if (!key) return c.json({ ok: false, error: 'no key' });
    try {
      const res = await fetch(OPENROUTER_KEY_URL, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return c.json({ ok: false, error: res.status === 401 ? 'OpenRouter doesn\'t know this key' : `OpenRouter said ${res.status}` });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ ok: false, error: (err as Error).message });
    }
  });
}
