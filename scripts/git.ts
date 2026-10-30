// A local Git server for the Code Lab: Forgejo in Docker, only reachable from this Mac.
//   npm run git:start   start it (the first time: create it, the "ampli" user and a token)
//   npm run git:stop    stop it (repositories stay in data/forgejo)

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, readSettings, writeSettings } from '../packages/shared/src/node.ts';

const IMAGE = 'codeberg.org/forgejo/forgejo:16.0.6-rootless';
const CONTAINER = 'ampli-forgejo';
const PORT = Number(process.env.GIT_PORT ?? 3300);
const URL = `http://localhost:${PORT}`;
const USER = 'ampli';
const LOGIN_FILE = join(DATA_DIR, 'git-login.txt');

function docker(args: string[], quiet = false): { ok: boolean; out: string } {
  const r = spawnSync('docker', args, { encoding: 'utf8', stdio: quiet ? 'pipe' : ['ignore', 'pipe', 'inherit'] });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

function forgejo(args: string[]): { ok: boolean; out: string } {
  // Run as the container's own user, with its config.
  return docker(['exec', CONTAINER, 'forgejo', '--config', '/var/lib/gitea/custom/conf/app.ini', ...args], true);
}

async function waitUntilUp(): Promise<void> {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(`${URL}/api/v1/version`)).ok) return;
    } catch {
      // Not yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Forgejo didn't come up at ${URL}; see \`docker logs ${CONTAINER}\``);
}

async function tokenWorks(token: string): Promise<boolean> {
  try {
    return (await fetch(`${URL}/api/v1/user`, { headers: { authorization: `token ${token}` } })).ok;
  } catch {
    return false;
  }
}

async function start(): Promise<void> {
  if (!docker(['info'], true).ok) {
    console.error('Docker is not running. Install Docker Desktop (https://www.docker.com/products/docker-desktop/), start it, and try again.');
    process.exit(1);
  }
  const exists = docker(['container', 'inspect', CONTAINER], true).ok;
  if (exists) {
    docker(['start', CONTAINER], true);
  } else {
    console.log(`Starting Forgejo (${IMAGE}); the first time downloads it (~150 MB)…`);
    // Repositories, database and config all live here (config in custom/conf/app.ini).
    mkdirSync(join(DATA_DIR, 'forgejo'), { recursive: true });
    const env = {
      // Ready to use without the install page; only reachable from this Mac.
      FORGEJO__security__INSTALL_LOCK: 'true',
      FORGEJO__server__ROOT_URL: `${URL}/`,
      FORGEJO__server__HTTP_PORT: '3000',
      FORGEJO__server__DISABLE_SSH: 'true',
      FORGEJO__database__DB_TYPE: 'sqlite3',
      FORGEJO__service__DISABLE_REGISTRATION: 'true',
      FORGEJO__repository__DEFAULT_BRANCH: 'main',
      FORGEJO__repository__DEFAULT_PRIVATE: 'public',
      FORGEJO__ui__DEFAULT_THEME: 'forgejo-light',
      FORGEJO__log__LEVEL: 'Warn',
    };
    const run = docker([
      'run', '-d', '--name', CONTAINER, '--restart', 'unless-stopped',
      '-p', `127.0.0.1:${PORT}:3000`,
      '-v', `${join(DATA_DIR, 'forgejo')}:/var/lib/gitea`,
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      IMAGE,
    ]);
    if (!run.ok) process.exit(1);
  }
  await waitUntilUp();

  const settings = readSettings();
  if (settings.git && (await tokenWorks(settings.git.token))) {
    console.log(`Forgejo runs at ${URL} and the town is connected.`);
    return;
  }

  // The character's own account. Its password is only for you, to look around as it.
  const password = execFileSync('openssl', ['rand', '-base64', '18'], { encoding: 'utf8' }).trim();
  const created = forgejo([
    'admin', 'user', 'create', '--admin', '--username', USER, '--email', `${USER}@ampli.local`,
    '--password', password, '--must-change-password=false',
  ]);
  if (created.ok) {
    writeFileSync(LOGIN_FILE, `Forgejo at ${URL}\nuser: ${USER}\npassword: ${password}\n`);
    chmodSync(LOGIN_FILE, 0o600);
  } else if (!/already exists/i.test(created.out)) {
    console.error(`Couldn't create the "${USER}" user: ${created.out}`);
    process.exit(1);
  }

  const token = forgejo([
    'admin', 'user', 'generate-access-token', '--username', USER,
    '--token-name', `town-${Date.now()}`, '--scopes', 'write:repository,write:user', '--raw',
  ]);
  if (!token.ok || !(await tokenWorks(token.out))) {
    console.error(`Couldn't create an access token: ${token.out}`);
    process.exit(1);
  }
  writeSettings({ ...settings, git: { url: URL, user: USER, token: token.out } });
  console.log(`Forgejo runs at ${URL} and the town is connected (it restarts by itself if it's running).`);
  if (created.ok) console.log(`To look around as ${USER}: the login is in data/git-login.txt.`);
}

function stop(): void {
  docker(['stop', CONTAINER], true);
  console.log('Forgejo stopped. Its repositories stay in data/forgejo.');
}

const command = process.argv[2];
if (command === 'start') await start();
else if (command === 'stop') stop();
else {
  console.log('Usage: npm run git:start | npm run git:stop');
  process.exit(1);
}
