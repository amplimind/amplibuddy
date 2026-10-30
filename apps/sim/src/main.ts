import { serve } from '@hono/node-server';
import { VISITOR_RETENTION_DAYS, formatClock, isLocalUrl } from '@ampli-world/shared';
import { config, loadNeighbors, loadPersona } from './config.ts';
import { GyrosBridge } from './gyros.ts';
import { createApp } from './http.ts';
import { libraryDir } from '@ampli-world/shared/node';
import { loadLibrary } from './library.ts';
import { GitServer, Projects } from './projects.ts';
import { SitePreviews, createSitesApp } from './sites.ts';
import { BrowserCheck, findBrowser } from './browser.ts';
import { Sim } from './sim.ts';
import { Store } from './store.ts';

const TICK_MS = 1000;
const SAVE_EVERY_TICKS = 10;
const RETENTION_SWEEP_MS = 3_600_000;

const store = new Store(config.dbFile);
const books = loadLibrary(libraryDir());
const persona = loadPersona();
const sim = new Sim(store, books, persona, config.minutesPerSecond, loadNeighbors());

if (!config.brainToken) {
  console.warn('[sim] BRAIN_TOKEN is empty: anyone who can reach this port can steer the character.');
}

let last = performance.now();
let ticks = 0;
const timer = setInterval(() => {
  const now = performance.now();
  sim.tick((now - last) / 1000);
  last = now;
  if (++ticks % SAVE_EVERY_TICKS === 0) sim.save();
}, TICK_MS);

let sitesServer: ReturnType<typeof serve> | null = null;
if (config.code) {
  const git =
    config.gitUrl && config.gitUser && config.gitToken && isLocalUrl(config.gitUrl)
      ? new GitServer(config.gitUrl, config.gitUser, config.gitToken, { name: persona.name, email: `${config.gitUser}@ampli.local` })
      : null;
  sim.projects = new Projects(config.projectsDir, `http://localhost:${config.sitesPort}`, git);
  const previews = new SitePreviews();
  const browser = findBrowser(process.env.CODE_BROWSER);
  if (browser) {
    const check = new BrowserCheck(browser, previews, `http://127.0.0.1:${config.sitesPort}`);
    sim.projects.browserCheck = (files) => check.run(files);
  }
  // Its own port and origin: the sites never share cookies or storage with the town's page.
  sitesServer = serve(
    {
      fetch: createSitesApp(
        sim.projects,
        () => persona.name,
        ({ slug, name }, problem) => sim.log({ type: 'site_error', data: { project: slug, name, problem } }),
        previews,
      ).fetch,
      port: config.sitesPort,
      hostname: '127.0.0.1',
    },
    ({ port }) =>
      console.log(
        `[sim] Code Lab sites at http://localhost:${port}${git ? ` · Git at ${git.url}` : ' · no Git server'}` +
          (browser ? ` · pages tried in ${browser.split('/').pop()}` : ' · no browser to try pages in'),
      ),
  );
}

if (config.gyrosUrl) {
  sim.gyros = new GyrosBridge(config.gyrosUrl, config.gyrosUiUrl || null, (body) => sim.log(body), {
    nudgeAfterMs: Math.max(0, config.gyrosNudgeAfterMin) * 60_000,
    memory: { load: () => store.loadGyrosNudges(), save: (m) => store.saveGyrosNudges(m) },
  });
  sim.gyros.start();
}

/** Deletes visitors (and everything about them) whose last visit is too long ago. */
function retentionSweep() {
  const cutoff = new Date(Date.now() - VISITOR_RETENTION_DAYS * 86_400_000).toISOString();
  for (const id of store.expiredVisitors(cutoff)) {
    const { letters } = store.forgetVisitor(id);
    console.log(`[sim] retention: forgot a visitor and ${letters} letters (no visit for ${VISITOR_RETENTION_DAYS} days)`);
  }
}
retentionSweep();
const sweeper = setInterval(retentionSweep, RETENTION_SWEEP_MS);

const app = createApp(sim, {
  brainToken: config.brainToken,
  webDist: config.webDist,
  adminToken: config.adminToken,
  sitePassword: config.sitePassword,
  letterLimits: config.letterLimits,
  building: config.build,
});
if (!config.sitePassword) console.warn('[sim] SITE_PASSWORD is empty: only run this on a trusted network (VPN/office).');
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, ({ port }) => {
  console.log(
    `[sim] ${persona.name} lives at http://localhost:${port} · ${formatClock(sim.engine.simTime)} · ` +
      `${books.size} books · ${config.minutesPerSecond} sim min/s`,
  );
});

function shutdown() {
  clearInterval(timer);
  clearInterval(sweeper);
  sim.gyros?.stop();
  sim.save();
  store.close();
  server.close();
  sitesServer?.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
