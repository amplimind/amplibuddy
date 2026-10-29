import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '@ampli-world/shared';
import { OPENROUTER_URL, parseReasoning, type LlmEndpoint } from './llm.ts';
import { buildPersonaPrompt } from './prompts.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const envFile = `${ROOT}.env`;
if (existsSync(envFile)) process.loadEnvFile(envFile);

const baseUrl = (process.env.LLM_BASE_URL || OPENROUTER_URL).replace(/\/+$/, '');
const openRouter = baseUrl === OPENROUTER_URL;

/**
 * Limits that only exist because calls cost money. They apply to OpenRouter only: a local
 * model costs nothing, so they're ignored there even if set. Behavioural limits (like
 * notes per day) don't use this.
 */
function costLimit(name: string, cloudDefault: number): number {
  if (!openRouter) return Infinity;
  const value = process.env[name];
  return value !== undefined && value !== '' ? Number(value) : cloudDefault;
}

export const config = {
  /** OpenRouter by default; set LLM_BASE_URL for a local OpenAI-compatible server (e.g. Ollama). */
  llm: {
    baseUrl,
    openRouter,
    // The OpenRouter key never goes to other servers; they get LLM_API_KEY if they need one.
    apiKey: (openRouter ? process.env.OPENROUTER_API_KEY : process.env.LLM_API_KEY) ?? '',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? (openRouter ? 60_000 : 240_000)),
  } satisfies LlmEndpoint,
  /** Model for calls that include an image (doodles). Empty = whatever model the call uses. */
  visionModel: process.env.VISION_MODEL ?? '',
  simUrl: (process.env.SIM_URL ?? 'http://localhost:4300').replace(/\/$/, ''),
  brainToken: process.env.BRAIN_TOKEN ?? '',
  // In the cloud a cheap model decides and a stronger one reflects. Locally there's no
  // cost to save: one model does everything (one download, one model in memory).
  brainModel: process.env.BRAIN_MODEL || (openRouter ? 'anthropic/claude-haiku-5.5' : 'gemma4:12b'),
  reflectModel:
    process.env.REFLECT_MODEL || (openRouter ? 'anthropic/claude-sonnet-5.5' : process.env.BRAIN_MODEL || 'gemma4:12b'),
  dailyBudgetUsd: costLimit('LLM_DAILY_BUDGET_USD', 2),
  maxCallsPerHour: costLimit('LLM_MAX_CALLS_PER_HOUR', 120),
  reasoning: parseReasoning(process.env.LLM_REASONING),
  // The internet café uses OpenRouter's web plugin, so it's closed with a local model.
  webSearch: openRouter && process.env.WEB_SEARCH !== 'off',
  searchesPerDay: costLimit('WEB_SEARCHES_PER_DAY', 20),
  artPerDay: costLimit('ART_PER_DAY', 10),
  chatsPerDay: costLimit('CHATS_PER_DAY', 12),
  notesPerDay: Number(process.env.NOTES_PER_DAY ?? 4),
  webExcludeDomains: (process.env.WEB_EXCLUDE_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean),
  pollMs: 2000,
};

/** The persona file's body is the character's system prompt. */
export function loadPersonaPrompt(): string {
  return buildPersonaPrompt(readFileSync(`${ROOT}world/persona.md`, 'utf8'));
}


/** A neighbour's persona: frontmatter (name/species/place) plus the body as its system prompt. */
export interface NeighborPersona {
  id: string;
  name: string;
  species: string;
  place: string;
  prompt: string;
}

export function loadNeighborPersonas(): NeighborPersona[] {
  const dir = `${ROOT}world/neighbors`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => ({ file, ...parseFrontmatter(readFileSync(`${dir}/${file}`, 'utf8')) }))
    .filter(({ meta }) => meta.active !== 'false')
    .map(({ file, meta, body }) => {
      const id = basename(file, '.md');
      return { id, name: meta.name ?? id, species: meta.species ?? 'animal', place: meta.place ?? 'cafe', prompt: body };
    });
}
