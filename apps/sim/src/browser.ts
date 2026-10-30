import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectFile } from '@ampli-world/shared';
import type { SitePreviews } from './sites.ts';

// The Code Lab tries each website in a real browser before and after a commit, so the
// character hears about errors that only show when the page runs. The browser already on
// the Mac does it, headless, with a throwaway profile: the page runs in the same sandbox
// as for anyone who opens it, and nothing of it ever runs in the town's own process.

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

/** A Chromium-based browser to check with: the setting (a path, or "off"), or the first one installed. */
export function findBrowser(setting?: string): string | null {
  if (setting === 'off') return null;
  if (setting) return existsSync(setting) ? setting : null;
  return CANDIDATES.find((path) => existsSync(path)) ?? null;
}

const FLAGS = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-component-update',
  '--mute-audio',
  // Never touch the keychain or the user's own profile.
  '--use-mock-keychain',
  '--password-store=basic',
];

/**
 * Opens a page headless, lets it run for a few seconds of (fast-forwarded) time, and closes
 * it. Never fails: a page that hangs is killed after `timeoutMs`.
 */
export function openHeadless(browser: string, url: string, { runMs = 3000, timeoutMs = 20_000 } = {}): Promise<void> {
  const profile = mkdtempSync(join(tmpdir(), 'ampli-check-'));
  return new Promise((resolve) => {
    let finished = false;
    const child = spawn(browser, [...FLAGS, `--user-data-dir=${profile}`, `--virtual-time-budget=${runMs}`, '--dump-dom', url], {
      stdio: 'ignore',
      // None of the town's secrets: only what a browser needs to start.
      env: { HOME: process.env.HOME ?? '', PATH: process.env.PATH ?? '', TMPDIR: tmpdir(), LANG: process.env.LANG ?? 'en_US.UTF-8' },
    });
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      rmSync(profile, { recursive: true, force: true });
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done();
    }, timeoutMs);
    child.once('exit', done);
    child.once('error', done);
  });
}

/** Tries a set of files as a website (committed or not) and returns what broke, one check at a time. */
export class BrowserCheck {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly browser: string,
    private readonly previews: SitePreviews,
    /** Where the sites server answers, e.g. http://127.0.0.1:4380. */
    private readonly origin: string,
  ) {}

  run(files: ProjectFile[]): Promise<string[]> {
    if (!files.some((f) => f.path === 'index.html')) return Promise.resolve([]);
    const next = this.queue.then(async () => {
      const id = this.previews.add(files);
      await openHeadless(this.browser, `${this.origin}/__preview/${id}/`);
      // The last report may still be on its way.
      await new Promise((r) => setTimeout(r, 200));
      return this.previews.close(id);
    });
    this.queue = next.catch(() => {});
    return next;
  }
}
