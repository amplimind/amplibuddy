import type { Mood, Needs } from './types.ts';

export const LOW_NEED = 20;

export function clampNeed(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** Mood follows needs, nudged by recent events (moodBoost). The lowest need dominates. */
export function moodFrom(needs: Needs, moodBoost: number): Mood {
  const avg = (needs.energy + needs.satiety + needs.fun) / 300;
  const valence = Math.min(1, Math.max(0, avg + moodBoost));

  let label: string;
  if (needs.energy < LOW_NEED) label = 'sleepy';
  else if (needs.satiety < LOW_NEED) label = 'hungry and a bit grumpy';
  else if (needs.fun < LOW_NEED) label = 'bored';
  else if (valence > 0.8) label = 'cheerful';
  else if (valence > 0.6) label = 'content';
  else if (valence > 0.4) label = 'so-so';
  else label = 'low';

  return { label, valence: Math.round(valence * 100) / 100 };
}

/** Human words for a need value, used in prompts so the model doesn't over-index on numbers. */
export function describeNeed(value: number): string {
  if (value < 10) return 'desperate';
  if (value < 25) return 'low';
  if (value < 50) return 'getting low';
  if (value < 75) return 'fine';
  return 'great';
}
