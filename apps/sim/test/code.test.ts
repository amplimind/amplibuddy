import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeProject, WorldEvent } from '@ampli-world/shared';
import { createApp } from '../src/http.ts';
import { checkProject } from '../src/check.ts';
import { CommitError, GitServer, Projects } from '../src/projects.ts';
import { SITE_CSP, createSitesApp } from '../src/sites.ts';
import { Sim } from '../src/sim.ts';
import { Store } from '../src/store.ts';

const html = '<!doctype html><title>Pond</title><script src="app.js"></script><h1>Pond clock</h1>';

function projects(git: GitServer | null = null) {
  return new Projects(mkdtempSync(join(tmpdir(), 'ampli-code-')), 'http://localhost:4380', git);
}

test('code: a new project is saved, an old one changed, and bad sessions refused before touching the disk', async () => {
  const p = projects();
  const first = await p.commit({ project: 'Pond Clock', description: 'A clock for the pond.', files: [{ path: 'index.html', content: html }, { path: 'app.js', content: 'tick()' }], message: 'Start the pond clock' }, 10);
  assert.equal(first.project.slug, 'pond-clock');
  assert.equal(first.project.siteUrl, 'http://localhost:4380/pond-clock/');
  assert.deepEqual(first.written, ['index.html', 'app.js']);

  const second = await p.commit({ project: 'pond-clock', files: [{ path: 'app.js', content: 'tick(); tock()' }, { path: 'index.html', content: html }], deleted: [], message: 'Make it tock' }, 20);
  assert.deepEqual(second.written, ['app.js'], 'unchanged files are no change');
  assert.deepEqual(p.project('pond-clock')!.commits.map((c) => c.message), ['Make it tock', 'Start the pond clock']);

  const refused = async (files: { path: string; content: string }[], why: RegExp, extra = {}) =>
    assert.rejects(p.commit({ project: 'pond-clock', files, message: 'x', ...extra }, 30), (err: Error) => err instanceof CommitError && why.test(err.message));
  await refused([{ path: '../../etc/passwd.txt', content: 'x' }], /not allowed as a file/);
  await refused([{ path: 'run.sh', content: 'rm -rf /' }], /not allowed as a file/);
  await refused([{ path: 'big.js', content: 'x'.repeat(40_001) }], /too long/);
  await refused(Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.js`, content: 'x' })), /at most 12 files/);
  await refused([{ path: 'app.js', content: 'tick(); tock()' }], /nothing changed/);
  await refused([{ path: 'a.js', content: 'x' }], /needs a message/, { message: '  ' });
  assert.deepEqual(p.files('pond-clock').map((f) => f.path).sort(), ['app.js', 'index.html'], 'nothing half-written');

  const removed = await p.commit({ project: 'pond-clock', files: [], deleted: ['app.js', '../index.html'], message: 'Drop the script' }, 40);
  assert.deepEqual(removed.deleted, ['app.js']);
});

/** A tiny stand-in for Forgejo's API, recording what the town sends. */
async function fakeForgejo() {
  const calls: { method: string; url: string; auth?: string; body: any }[] = [];
  const repos = new Set<string>();
  const blobs = new Map<string, string>();
  const read = (req: IncomingMessage) => new Promise<string>((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
  const server = createServer(async (req, res) => {
    const body = await read(req);
    const json = body ? JSON.parse(body) : null;
    calls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: json });
    const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.method === 'GET' && req.url === '/api/v1/repos/ampli/pond-clock') return send(repos.has('pond-clock') ? 200 : 404, {});
    if (req.method === 'POST' && req.url === '/api/v1/user/repos') { repos.add(json.name); return send(201, {}); }
    if (req.method === 'GET' && req.url!.startsWith('/api/v1/repos/ampli/pond-clock/git/trees/main')) {
      return blobs.size === 0 ? send(404, {}) : send(200, { tree: [...blobs].map(([path, sha]) => ({ path, sha, type: 'blob' })) });
    }
    if (req.method === 'POST' && req.url === '/api/v1/repos/ampli/pond-clock/contents') {
      for (const f of json.files) f.operation === 'delete' ? blobs.delete(f.path) : blobs.set(f.path, `blob-${f.path}-${calls.length}`);
      return send(201, { commit: { sha: `c0ffee${calls.length}` } });
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, calls, close: () => server.close() };
}

test('code: every change becomes a real commit on the Git server', async () => {
  const forgejo = await fakeForgejo();
  try {
    const git = new GitServer(forgejo.url, 'ampli', 'tok-123', { name: 'Ampli', email: 'ampli@ampli.local' });
    const p = projects(git);
    const first = await p.commit({ project: 'Pond Clock', files: [{ path: 'index.html', content: html }], message: 'Start' }, 1);
    assert.match(first.sha!, /^c0ffee/);
    assert.equal(first.project.repoUrl, `${forgejo.url}/ampli/pond-clock`);
    const created = forgejo.calls.find((c) => c.url === '/api/v1/user/repos')!;
    assert.deepEqual([created.body.name, created.body.private, created.auth], ['pond-clock', false, 'token tok-123']);
    const commit = forgejo.calls.find((c) => c.url.endsWith('/contents'))!;
    assert.deepEqual(commit.body.files, [{ operation: 'create', path: 'index.html', content: Buffer.from(html).toString('base64') }]);
    assert.deepEqual([commit.body.branch, commit.body.message, commit.body.author.name], ['main', 'Start', 'Ampli']);

    await p.commit({ project: 'pond-clock', files: [{ path: 'index.html', content: 'v2' }], message: 'Update' }, 2);
    const update = forgejo.calls.filter((c) => c.url.endsWith('/contents'))[1]!;
    assert.equal(update.body.files[0].operation, 'update');
    assert.match(update.body.files[0].sha, /^blob-index.html/, 'updates name the blob they replace');
    assert.equal(p.project('pond-clock')!.commits[0]!.sha?.startsWith('c0ffee'), true);
  } finally {
    forgejo.close();
  }

  // An unreachable server doesn't lose the change.
  const offline = projects(new GitServer('http://127.0.0.1:1', 'ampli', 't', { name: 'A', email: 'a@x' }));
  const kept = await offline.commit({ project: 'Kept', files: [{ path: 'index.html', content: html }], message: 'Still saved' }, 1);
  assert.equal(kept.sha, undefined);
  assert.equal(offline.files('kept')[0]!.content, html);
});

test('code: sites are served in a sandbox, and only files that belong to them', async () => {
  const p = projects();
  await p.commit({ project: 'Pond Clock', files: [{ path: 'index.html', content: html }, { path: 'js/app.js', content: 'tick()' }], message: 'Start' }, 1);
  const sites = createSitesApp(p, () => 'Ampli');
  const page = await sites.request('/pond-clock/');
  assert.equal(page.status, 200);
  assert.equal(await page.text(), html);
  assert.equal(page.headers.get('content-security-policy'), SITE_CSP);
  assert.match(SITE_CSP, /sandbox allow-scripts;/);
  assert.match(SITE_CSP, /connect-src 'none'/);
  assert.match(SITE_CSP, /form-action 'none'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('cross-origin-resource-policy'), null, 'it would block the page\'s own files in the sandbox');
  assert.equal((await sites.request('/favicon.ico')).status, 204);
  assert.equal((await sites.request('/pond-clock/js/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await sites.request('/pond-clock')).status, 301);
  for (const path of ['/pond-clock/../pond-clock.json', '/pond-clock/%2e%2e/pond-clock.json', '/pond-clock.json/', '/nope/index.html', '/pond-clock/missing.html', '/..%2F..%2Fetc/passwd.txt', '/%2e%2e/x.html']) {
    assert.equal((await sites.request(path)).status, 404, path);
  }
  assert.match(await (await sites.request('/')).text(), /<a href="\/pond-clock\/">Pond Clock<\/a>/);
});

test('code: the brain commits through the sim; refusals are logged so the character knows', async () => {
  const sim = new Sim(new Store(':memory:'), new Map(), { name: 'Ampli', species: 'fox', look: 'fox', town: 'X' }, 1);
  sim.projects = projects();
  const app = createApp(sim, { brainToken: 'tok', webDist: '/nonexistent' });
  const brain = (path: string, body?: unknown) =>
    app.request(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', 'x-brain-token': 'tok' }, ...(body ? { body: JSON.stringify(body) } : {}) });

  assert.equal((await brain('/api/brain/code', { project: 'Pond Clock', files: [{ path: 'index.html', content: html }], message: 'Start' })).status, 200);
  assert.equal((await brain('/api/brain/code', { project: 'pond-clock', files: [{ path: '../x.html', content: 'x' }], message: 'Sneak' })).status, 400);
  assert.equal((await brain('/api/brain/code', { project: 'Evil', files: [{ path: 'index.html', content: 'x' }], message: 'm', held: true })).status, 200);
  const events = ((await (await app.request('/api/events')).json()) as WorldEvent[]).filter((e) => e.type === 'code_committed');
  assert.deepEqual(
    events.map((e) => e.type === 'code_committed' && [e.data.name, e.data.message ?? null, !!e.data.error, !!e.data.held]),
    [['Pond Clock', 'Start', false, false], ['pond-clock', null, true, false], ['Evil', null, false, true]],
  );
  assert.equal(sim.projects.slugs().includes('evil'), false, 'held code is never saved');
  const first = events[0]!;
  assert.equal(first.type === 'code_committed' && first.data.url, 'http://localhost:4380/pond-clock/', 'the feed can link to the site');

  const listed = (await (await app.request('/api/projects')).json()) as CodeProject[];
  assert.deepEqual(listed.map((p) => p.slug), ['pond-clock']);
  const files = (await (await brain('/api/brain/projects/pond-clock/files')).json()) as { path: string }[];
  assert.deepEqual(files.map((f) => f.path), ['index.html']);
  const context = (await (await brain('/api/brain/context')).json()) as { projects: { slug: string; lastCommit: string }[] };
  assert.deepEqual(context.projects, [{ slug: 'pond-clock', name: 'Pond Clock', description: '', files: ['index.html'], lastCommit: 'Start', problems: ['index.html links to app.js, which isn\'t in the project'] }]);
});

test('code: after each commit the Code Lab says what is wrong, without running anything', () => {
  const ok = [
    { path: 'index.html', content: '<!doctype html><link rel="stylesheet" href="style.css"><script src="js/app.js" defer></script><script>const x = 1;</script><canvas></canvas>' },
    { path: 'style.css', content: 'body{}' },
    { path: 'js/app.js', content: 'const ctx = document.querySelector("canvas").getContext("2d");' },
  ];
  assert.deepEqual(checkProject(ok), []);

  const problems = checkProject([
    { path: 'index.html', content: '<script type="module" src="app.js"></script>\n<link href="https://fonts.example.com/x.css" rel="stylesheet">\n<img src="/pond.svg">\n<form><input></form>\n<script>\nlet a = ;\n</script>' },
    { path: 'app.js', content: 'function go( {\n  fetch("/api");\n}' },
    { path: 'game.js', content: 'localStorage.setItem("s", 1); alert("hi");' },
    { path: 'data.json', content: '{ broken' },
  ]);
  const has = (re: RegExp) => assert.ok(problems.some((p) => re.test(p)), `${re} in ${JSON.stringify(problems, null, 1)}`);
  has(/^app\.js, line 2: /);
  has(/index\.html \(inline script\), line 6: Unexpected token/);
  has(/type="module"/);
  has(/loads https:\/\/fonts\.example\.com\/x\.css from the internet/);
  has(/leading slash/);
  has(/<form>/);
  has(/game\.js stores data in the browser/);
  assert.equal(problems.length, 8, 'kept short: the first eight');
  const more = checkProject([
    { path: 'index.html', content: '<p>hi</p>' },
    { path: 'game.js', content: 'alert("hi");' },
    { path: 'data.json', content: '{ broken' },
  ]);
  assert.ok(more.some((p) => /alert\/confirm\/prompt/.test(p)) && more.some((p) => /^data\.json: /.test(p)), JSON.stringify(more));
  assert.deepEqual(checkProject([{ path: 'app.js', content: '1' }]), ['there is no index.html, so the site has no start page']);
});
