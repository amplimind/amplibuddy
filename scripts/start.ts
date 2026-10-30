// Starts AmpliBuddy for everyday use: the sim (which also serves the web page) and the
// brain, restarted whenever the setup wizard saves something, and the browser opened once
// the town is up. `AmpliBuddy.command` runs this after installing and building.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { DATA_DIR, ROOT, USER_WORLD_DIR } from '../packages/shared/src/node.ts';

// Only the port is read here. Everything else each process loads itself on every
// (re)start, so changes from the wizard take effect.
const dotenv = existsSync(join(ROOT, '.env')) ? parseEnv(readFileSync(join(ROOT, '.env'), 'utf8')) : {};
const port = Number(process.env.SIM_PORT || dotenv.SIM_PORT || 4300);
const url = `http://localhost:${port}`;

const env = {
  ...process.env,
  // A fresh secret per start: only our own brain may drive the sim.
  BRAIN_TOKEN: process.env.BRAIN_TOKEN || dotenv.BRAIN_TOKEN || randomBytes(24).toString('hex'),
  SIM_URL: `http://127.0.0.1:${port}`,
};

const APPS = { sim: 'apps/sim/src/main.ts', brain: 'apps/brain/src/main.ts' } as const;
type Name = keyof typeof APPS;
const children = new Map<Name, ChildProcess>();
let stopping = false;
let restarting = false;

function start(name: Name): void {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', APPS[name]], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
  children.set(name, child);
  child.on('exit', (code) => {
    if (children.get(name) !== child || stopping || restarting) return;
    console.log(`[start] ${name} stopped (${code ?? 'signal'}), starting it again in 3 s`);
    setTimeout(() => !stopping && start(name), 3000);
  });
}

function stopAll(): Promise<void> {
  const exits = [...children.values()].map(
    (child) =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }),
  );
  return Promise.all(exits).then(() => children.clear());
}

async function restart(why: string): Promise<void> {
  if (restarting || stopping) return;
  restarting = true;
  console.log(`[start] ${why}: restarting the town`);
  await stopAll();
  restarting = false;
  start('sim');
  start('brain');
}

async function openWhenReady(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/setup/status`);
      if (res.ok) {
        console.log(`\n  AmpliBuddy is running at ${url}\n  Close this window (or press Ctrl+C) to stop it.\n`);
        if (!process.env.AMPLI_NO_BROWSER) spawn('open', [url], { stdio: 'ignore' });
        return;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(`[start] the town didn't come up; see the messages above. Address: ${url}`);
}

// The wizard writes settings and characters; any change restarts both processes.
mkdirSync(USER_WORLD_DIR, { recursive: true });
let debounce: NodeJS.Timeout | undefined;
const changed = (what: string) => {
  clearTimeout(debounce);
  debounce = setTimeout(() => void restart(`${what} changed`), 800);
};
watch(DATA_DIR, (_, file) => file === 'settings.json' && changed('settings'));
watch(USER_WORLD_DIR, { recursive: true }, (_, file) => file?.endsWith('.md') && changed('characters'));

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    stopping = true;
    void stopAll().then(() => process.exit(0));
  });
}

start('sim');
start('brain');
void openWhenReady();
