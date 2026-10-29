import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '@ampli-world/shared';
import { parseReasoning } from './llm.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const envFile = `${ROOT}.env`;
if (existsSync(envFile)) process.loadEnvFile(envFile);

export const config = {
  simUrl: (process.env.SIM_URL ?? 'http://localhost:4300').replace(/\/$/, ''),
  brainToken: process.env.BRAIN_TOKEN ?? '',
  apiKey: process.env.OPENROUTER_API_KEY ?? '',
  brainModel: process.env.BRAIN_MODEL || 'anthropic/claude-haiku-5.5',
  reflectModel: process.env.REFLECT_MODEL || 'anthropic/claude-sonnet-5.5',
  dailyBudgetUsd: Number(process.env.LLM_DAILY_BUDGET_USD ?? 2),
  maxCallsPerHour: Number(process.env.LLM_MAX_CALLS_PER_HOUR ?? 120),
  reasoning: parseReasoning(process.env.LLM_REASONING),
  webSearch: process.env.WEB_SEARCH !== 'off',
  searchesPerDay: Number(process.env.WEB_SEARCHES_PER_DAY ?? 20),
  artPerDay: Number(process.env.ART_PER_DAY ?? 10),
  webExcludeDomains: (process.env.WEB_EXCLUDE_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean),
  pollMs: 2000,
};

/** The persona file's body is the character's system prompt. */
export function loadPersonaPrompt(): string {
  return parseFrontmatter(readFileSync(`${ROOT}world/persona.md`, 'utf8')).body;
}
