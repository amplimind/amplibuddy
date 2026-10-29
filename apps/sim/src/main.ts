import { serve } from '@hono/node-server';
import { VISITOR_RETENTION_DAYS, formatClock } from '@ampli-world/shared';
import { config, loadPersona } from './config.ts';
import { createApp } from './http.ts';
import { loadLibrary } from './library.ts';
import { Sim } from './sim.ts';
import { Store } from './store.ts';

const TICK_MS = 1000;
const SAVE_EVERY_TICKS = 10;
const RETENTION_SWEEP_MS = 3_600_000;

const store = new Store(config.dbFile);
const books = loadLibrary(config.libraryDir);
const persona = loadPersona();
const sim = new Sim(store, books, persona, config.minutesPerSecond);

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
});
if (!config.sitePassword) console.warn('[sim] SITE_PASSWORD is empty: only run this on a trusted network (VPN/office).');
const server = serve({ fetch: app.fetch, port: config.port }, ({ port }) => {
  console.log(
    `[sim] ${persona.name} lives at http://localhost:${port} · ${formatClock(sim.engine.simTime)} · ` +
      `${books.size} books · ${config.minutesPerSecond} sim min/s`,
  );
});

function shutdown() {
  clearInterval(timer);
  clearInterval(sweeper);
  sim.save();
  store.close();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
