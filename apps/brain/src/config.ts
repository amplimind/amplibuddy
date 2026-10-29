import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { PLACES, parseFrontmatter, parseHours, type PlaceId } from '@ampli-world/shared';
import { loadEnvironment, neighborsDir, personaFile } from '@ampli-world/shared/node';
import { OPENROUTER_URL, parseReasoning, type LlmEndpoint } from './llm.ts';
import { buildNeighborPrompt, buildPersonaPrompt } from './prompts.ts';
import type { SearchProvider } from './search.ts';

loadEnvironment();

const baseUrl = (process.env.LLM_BASE_URL || OPENROUTER_URL).replace(/\/+$/, '');
const openRouter = baseUrl === OPENROUTER_URL;

/**
 * Which search the internet café uses. On OpenRouter its web plugin. Locally: Ollama's
 * web search with a (free) ollama.com key, else OpenRouter's search if there's a key for
 * it (paid per search), else Wikipedia. WEB_SEARCH_PROVIDER forces one.
 */
function searchProviders(): SearchProvider[] {
  const forced = process.env.WEB_SEARCH_PROVIDER;
  if (forced === 'openrouter' || forced === 'ollama' || forced === 'wikipedia') return [forced];
  if (forced === 'searxng') return ['searxng'];
  // A local SearXNG means "search for free": never fall back to a paid search silently.
  if (process.env.SEARXNG_URL && !openRouter) return ['searxng', 'wikipedia'];
  const order: SearchProvider[] = [];
  if (openRouter) order.push('openrouter');
  if (process.env.SEARXNG_URL) order.push('searxng');
  if (process.env.OLLAMA_API_KEY) order.push('ollama');
  if (!openRouter && process.env.OPENROUTER_API_KEY) order.push('openrouter');
  order.push('wikipedia');
  return order;
}
/** Tried in order: if one fails (e.g. no credits), the next one takes over. */
const searchProviderOrder = searchProviders();
const searchProvider = searchProviderOrder[0]!;

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
  webSearch: process.env.WEB_SEARCH !== 'off',
  // OpenRouter searches with its web plugin; elsewhere Ollama's web search (free ollama.com key)
  // or, with no key at all, Wikipedia.
  searchProvider,
  searchProviderOrder,
  ollamaApiKey: process.env.OLLAMA_API_KEY ?? '',
  searxngUrl: process.env.SEARXNG_URL ?? '',
  /** OpenRouter search, also usable while everything else runs locally. */
  searchEndpoint: {
    baseUrl: OPENROUTER_URL,
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    timeoutMs: 60_000,
    openRouter: true,
  } satisfies LlmEndpoint,
  /** Model that searches and writes the note when the search goes through OpenRouter. */
  searchModel:
    process.env.WEB_SEARCH_MODEL || (openRouter ? process.env.BRAIN_MODEL || 'anthropic/claude-haiku-5.5' : 'deepseek/deepseek-v4.1-flash'),
  // Paid searches stay capped even when the rest runs locally; a free first choice
  // (SearXNG, Ollama credits aside) isn't capped, the paid one is only a rare fallback.
  searchesPerDay:
    searchProvider === 'openrouter'
      ? Number(process.env.WEB_SEARCHES_PER_DAY || 20)
      : costLimit('WEB_SEARCHES_PER_DAY', 20),
  artPerDay: costLimit('ART_PER_DAY', 10),
  chatsPerDay: costLimit('CHATS_PER_DAY', 12),
  // No limit by default: notes are Ampli's way to reach people. Set NOTES_PER_DAY to cap them.
  notesPerDay: process.env.NOTES_PER_DAY ? Number(process.env.NOTES_PER_DAY) : Infinity,
  webExcludeDomains: (process.env.WEB_EXCLUDE_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean),
  pollMs: 2000,
};

/** The persona file's body is the character's system prompt. */
export function loadPersonaPrompt(): string {
  return buildPersonaPrompt(readFileSync(personaFile(), 'utf8'));
}


/** A neighbour's persona: frontmatter (name/species/place) plus the body as its system prompt. */
export interface NeighborPersona {
  id: string;
  name: string;
  species: string;
  place: string;
  hours?: { from: number; to: number };
  prompt: string;
}

export function loadNeighborPersonas(): NeighborPersona[] {
  const dir = neighborsDir();
  const town = parseFrontmatter(readFileSync(personaFile(), 'utf8')).meta.town ?? 'Ampliville';
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => ({ file, ...parseFrontmatter(readFileSync(`${dir}/${file}`, 'utf8')) }))
    .filter(({ meta }) => meta.active !== 'false')
    .map(({ file, meta, body }) => {
      const id = basename(file, '.md');
      const hours = parseHours(meta.hours);
      const name = meta.name ?? id;
      const species = meta.species ?? 'animal';
      const place = (meta.place && meta.place in PLACES ? meta.place : 'cafe') as PlaceId;
      return {
        id,
        name,
        species,
        place,
        ...(hours ? { hours } : {}),
        prompt: buildNeighborPrompt(body, { name, species, place: PLACES[place].name, town, hours }),
      };
    });
}
