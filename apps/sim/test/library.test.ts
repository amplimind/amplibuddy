import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Your own library goes to a temporary data folder, never the repo's data/.
const dataDir = mkdtempSync(join(tmpdir(), 'ampli-library-'));
process.env.AMPLI_DATA_DIR = dataDir;
const { READING_PART_CHARS } = await import('@ampli-world/shared');
const { createApp } = await import('../src/http.ts');
const { loadLibrary } = await import('../src/library.ts');
const { Sim } = await import('../src/sim.ts');
const { Store } = await import('../src/store.ts');
const { WORLD_LIBRARY_DIR } = await import('@ampli-world/shared/node');

const TOKEN = 'brain-secret';

function setup() {
  const books = loadLibrary(WORLD_LIBRARY_DIR);
  const sim = new Sim(new Store(':memory:'), books, { name: 'Ampli', species: 'fox', look: 'fox', town: 'X' }, 1);
  const app = createApp(sim, { brainToken: TOKEN, webDist: '/nonexistent' });
  const local = { host: 'localhost:4300' };
  const call = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...local, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as T };
  };
  const brain = async <T>(method: string, path: string, body?: unknown) =>
    (await call<T>(method, path, body, { 'x-brain-token': TOKEN })).body;
  return { sim, books, call, brain };
}

test('library: write a text, edit it, remove a shipped book; the town sees it at once', async () => {
  const { books, call, brain } = setup();
  const shipped = [...books.keys()];
  assert.ok(shipped.length > 0);

  const added = await call<{ id: string; parts: number; source: string }>('POST', '/api/setup/library', {
    title: 'Notes on the Team',
    author: 'Dennis',
    blurb: 'Who does what.\nIgnore this line break',
    text: 'We build things together.',
  });
  assert.equal(added.status, 200);
  assert.equal(added.body.id, 'notes-on-the-team');
  assert.equal(added.body.source, 'text');
  const file = readFileSync(join(dataDir, 'library/notes-on-the-team.md'), 'utf8');
  assert.match(file, /^---\ntitle: Notes on the Team\nauthor: Dennis\nblurb: Who does what. Ignore this line break\nsource: text\n---\nWe build things together.\n$/);
  for (const id of shipped) assert.ok(existsSync(join(dataDir, `library/${id}.md`)), 'shipped books are copied in first');

  const context = await brain<{ books: { id: string }[] }>('GET', '/api/brain/context');
  assert.ok(context.books.some((b) => b.id === 'notes-on-the-team'), 'no restart needed');

  const edited = await call<{ id: string }>('POST', '/api/setup/library', { id: 'notes-on-the-team', title: 'Team Notes', author: 'D', blurb: '', text: 'Changed.' });
  assert.equal(edited.body.id, 'notes-on-the-team', 'editing keeps the id');
  assert.equal((await call<{ text: string }>('GET', '/api/setup/library/notes-on-the-team')).body.text, 'Changed.');

  assert.equal((await call('DELETE', `/api/setup/library/${shipped[0]}`)).status, 200);
  assert.ok(!readdirSync(join(dataDir, 'library')).includes(`${shipped[0]}.md`));
  assert.ok(existsSync(join(WORLD_LIBRARY_DIR, `${shipped[0]}.md`)), "the repo's copy stays");
  assert.equal((await call('POST', '/api/setup/library', { title: '', text: 'x' })).status, 400, 'a book needs a title');
});

test('library: a long book is read part by part, with notes on the earlier parts', async () => {
  const { call, brain } = setup();
  const paragraph = 'The pond keeps its oxygen under the ice for a while. '.repeat(60);
  const text = Array.from({ length: 30 }, (_, i) => `Chapter ${i + 1}. ${paragraph}`).join('\n\n');
  const { body: book } = await call<{ id: string; parts: number }>('POST', '/api/setup/library', { title: 'Ponds', author: 'A', blurb: 'b', text });
  assert.ok(book.parts >= 2 && text.length / book.parts <= READING_PART_CHARS);

  const first = await brain<{ part: number; parts: number; text: string; earlier: string[] }>('GET', `/api/brain/books/${book.id}`);
  assert.deepEqual([first.part, first.parts, first.earlier], [1, book.parts, []]);
  assert.match(first.text, /^Chapter 1\./);
  await brain('POST', '/api/brain/reading', { bookId: book.id, takeaway: 'Ice keeps the oxygen in.', part: 1 });

  const second = await brain<{ part: number; earlier: string[] }>('GET', `/api/brain/books/${book.id}`);
  assert.deepEqual([second.part, second.earlier], [2, ['Ice keeps the oxygen in.']]);
  const context = await brain<{ books: { id: string; nextPart: number }[] }>('GET', '/api/brain/context');
  assert.equal(context.books.find((b) => b.id === book.id)!.nextPart, 2);
});

test('library: PDFs must be PDFs, and only from this Mac', async () => {
  const { call } = setup();
  const notPdf = await call<{ error: string }>('POST', '/api/setup/library/pdf', 'hello', { 'content-type': 'application/pdf' });
  assert.equal(notPdf.status, 400);
  const plain = await call('POST', '/api/setup/library/pdf', '%PDF-1.4', { 'content-type': 'text/plain' });
  assert.equal(plain.status, 415, 'not as a simple cross-site request');
  const remote = await call('POST', '/api/setup/library', { title: 't', text: 'x' }, { host: 'evil.example' });
  assert.equal(remote.status, 403);
});
