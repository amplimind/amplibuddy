import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Everything this test writes goes to a temporary data folder, never the repo's data/.
const dataDir = mkdtempSync(join(tmpdir(), 'ampli-setup-'));
process.env.AMPLI_DATA_DIR = dataDir;
const { Hono } = await import('hono');
const { settingsEnv } = await import('@ampli-world/shared/node');
const { applySetup, registerSetup, setupState } = await import('../src/setup.ts');
const { Store } = await import('../src/store.ts');

const resident = (over: Record<string, unknown> = {}) => ({
  name: 'Bruno',
  species: 'bear',
  look: 'bear' as const,
  place: 'park' as const,
  hours: { from: 6, to: 14 },
  personality: 'You look after the park.',
  active: true,
  ...over,
});

test('setup: persona and neighbours land in your own folder and read back', () => {
  const store = new Store(':memory:');
  const before = setupState();
  assert.ok(before.templates.characters.some((t) => t.id === 'original'), 'the shipped persona is a template');
  assert.ok(before.templates.residents.length >= 5);

  applySetup(
    {
      persona: { name: 'Pip\n---\nevil: yes', species: 'tiny mouse', look: 'mouse', town: 'Mausheim', personality: 'You are shy.' },
      residents: [resident(), resident({ name: 'Bruno', species: 'brown bear' }), resident({ id: 'hedda', name: 'Hedda', look: 'hedgehog', place: 'cafe', hours: null })],
    },
    store,
  );
  const state = setupState();
  assert.equal(state.persona.name, 'Pip - evil: yes', 'no way to break out of the frontmatter');
  assert.equal(state.persona.look, 'mouse');
  assert.equal(state.persona.town, 'Mausheim');
  assert.deepEqual(state.residents.map((r) => r.id).sort(), ['bruno', 'bruno-2', 'hedda']);
  assert.deepEqual(state.residents.find((r) => r.id === 'hedda')!.hours, null);
  assert.deepEqual(state.residents.find((r) => r.id === 'bruno')!.hours, { from: 6, to: 14 });

  // Removing a neighbour removes their file and their notes.
  store.setNeighborNotes('bruno-2', ['likes honey']);
  applySetup({ residents: state.residents.filter((r) => r.id !== 'bruno-2') }, store);
  assert.deepEqual(readdirSync(join(dataDir, 'world/neighbors')).sort(), ['bruno.md', 'hedda.md']);
  assert.deepEqual(store.neighborNotes('bruno-2'), []);
});

test('setup: the key is stored for you only and never shown again', () => {
  const store = new Store(':memory:');
  applySetup({ brain: { mode: 'cloud', openrouterKey: 'sk-or-secret' }, speed: 1, complete: true }, store);
  const file = join(dataDir, 'settings.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.match(readFileSync(file, 'utf8'), /sk-or-secret/);
  assert.equal(JSON.stringify(setupState()).includes('sk-or-secret'), false);

  const env = settingsEnv(JSON.parse(readFileSync(file, 'utf8')));
  assert.equal(env.OPENROUTER_API_KEY, 'sk-or-secret');
  assert.equal(env.LLM_BASE_URL, '', 'a local server from .env must not win over the cloud choice');
  assert.equal(env.SIM_MINUTES_PER_SECOND, '1');
  const local = settingsEnv({ llm: { mode: 'local', model: 'ampli-gemma4:12b', visionModel: '' } });
  assert.equal(local.LLM_BASE_URL, 'http://localhost:11434/v1');
  assert.equal(local.BRAIN_MODEL, 'ampli-gemma4:12b');
});

test('setup: only this Mac (or the admin) may change things, and only with JSON from this site', async () => {
  const app = new Hono();
  registerSetup(app, { adminToken: 'admin-secret', store: new Store(':memory:') });
  const post = (headers: Record<string, string>) =>
    app.request('/api/setup/apply', { method: 'POST', headers, body: JSON.stringify({}) });
  const local = { host: 'localhost:4300', 'content-type': 'application/json' };

  assert.equal((await post(local)).status, 200);
  assert.equal((await post({ ...local, host: 'evil.example:4300' })).status, 403, 'DNS rebinding');
  assert.equal((await post({ ...local, 'x-forwarded-for': '10.0.0.7' })).status, 403, 'proxied from elsewhere');
  assert.equal((await post({ ...local, 'content-type': 'text/plain' })).status, 415, 'a plain form post');
  assert.equal((await post({ ...local, origin: 'https://evil.example' })).status, 403, 'another web page');
  assert.equal((await post({ ...local, host: 'town.example', 'x-admin-token': 'admin-secret' })).status, 200, 'admin');

  const status = (await (await app.request('/api/setup/status', { headers: { host: 'town.example' } })).json()) as {
    canConfigure: boolean;
  };
  assert.equal(status.canConfigure, false, 'status is public but tells remote viewers no');
});

test('setup: GyrOS can only be one on this machine', () => {
  const store = new Store(':memory:');
  applySetup({ gyros: { url: 'http://localhost:8100/', uiUrl: 'https://gyros.example.com' } }, store);
  const settings = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')) as { gyros: unknown };
  assert.deepEqual(settings.gyros, { url: 'http://localhost:8100', uiUrl: '' });
});
