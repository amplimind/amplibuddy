// Node-only helpers shared by the sim, the brain and the launcher: where things live on
// disk and how settings are loaded. Not exported from index.ts, so the web never sees it.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** What ships with the repo: default persona, neighbours, templates, library. */
export const WORLD_DIR = join(ROOT, 'world');
/** What's yours: your settings and your own characters. Never in git. */
export const DATA_DIR = process.env.AMPLI_DATA_DIR || join(ROOT, 'data');
export const USER_WORLD_DIR = join(DATA_DIR, 'world');
export const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
export const WORLD_LIBRARY_DIR = join(WORLD_DIR, 'library');
export const USER_LIBRARY_DIR = join(DATA_DIR, 'library');

/** Set up in the browser wizard; everything optional. */
export interface Settings {
  setupComplete?: boolean;
  llm?: {
    mode: 'local' | 'cloud';
    /** Local: an OpenAI-compatible server, e.g. Ollama at http://localhost:11434/v1. */
    baseUrl?: string;
    model?: string;
    visionModel?: string;
    /** Cloud: the OpenRouter key. Never sent back to the browser. */
    openrouterKey?: string;
  };
  /** Sim minutes per real second. */
  speed?: number;
  gyros?: { url?: string; uiUrl?: string };
  /** The local Git server (Forgejo) the Code Lab mirrors to; set up by `npm run git:start`. */
  git?: { url: string; user: string; token: string };
  searxngUrl?: string;
}

export function readSettings(): Settings {
  try {
    return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) as Settings;
  } catch {
    return {};
  }
}

export function writeSettings(settings: Settings): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
  // It may hold an API key: readable by you only.
  chmodSync(SETTINGS_FILE, 0o600);
}

/** The settings as environment variables, in the names the rest of the code already reads. */
export function settingsEnv(s: Settings): Record<string, string> {
  const env: Record<string, string> = {};
  if (s.llm?.mode === 'local') {
    env.LLM_BASE_URL = s.llm.baseUrl || 'http://localhost:11434/v1';
    if (s.llm.model) env.BRAIN_MODEL = env.REFLECT_MODEL = s.llm.model;
    env.VISION_MODEL = s.llm.visionModel ?? '';
  } else if (s.llm?.mode === 'cloud') {
    // Empty, not unset: a base URL in .env must not send the cloud setup to a local server.
    env.LLM_BASE_URL = '';
    env.BRAIN_MODEL = env.REFLECT_MODEL = env.VISION_MODEL = '';
    if (s.llm.openrouterKey) env.OPENROUTER_API_KEY = s.llm.openrouterKey;
  }
  if (typeof s.speed === 'number' && s.speed > 0) env.SIM_MINUTES_PER_SECOND = String(s.speed);
  if (s.gyros) {
    env.GYROS_URL = s.gyros.url ?? '';
    env.GYROS_UI_URL = s.gyros.uiUrl ?? '';
  }
  if (s.searxngUrl !== undefined) env.SEARXNG_URL = s.searxngUrl;
  if (s.git) {
    env.GIT_URL = s.git.url;
    env.GIT_USER = s.git.user;
    env.GIT_TOKEN = s.git.token;
  }
  return env;
}

/**
 * Settings first, then .env: process.loadEnvFile never overwrites what's already set, so
 * what you chose in the wizard wins over .env, and real environment variables win over both.
 */
export function loadEnvironment(): void {
  for (const [key, value] of Object.entries(settingsEnv(readSettings()))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const envFile = join(ROOT, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

/** Has someone set this town up, in the wizard or (the old way) with a .env? */
export function setupComplete(): boolean {
  return readSettings().setupComplete === true || existsSync(join(ROOT, '.env'));
}

/** Your persona if you made one, else the one that ships with the repo. */
export function personaFile(): string {
  const own = join(USER_WORLD_DIR, 'persona.md');
  return existsSync(own) ? own : join(WORLD_DIR, 'persona.md');
}

/** Your neighbours once you've edited them (all of them, including removals), else the defaults. */
export function neighborsDir(): string {
  const own = join(USER_WORLD_DIR, 'neighbors');
  return existsSync(own) ? own : join(WORLD_DIR, 'neighbors');
}

/** Your library once you've edited it (the shipped books are copied in first), else the shipped one. */
export function libraryDir(): string {
  return existsSync(USER_LIBRARY_DIR) ? USER_LIBRARY_DIR : WORLD_LIBRARY_DIR;
}

export function writeText(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}
