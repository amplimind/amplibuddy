import type { Look } from './species.ts';
import type { ActivityKind, WebSource } from './types.ts';

// The Mind page: how the character develops over the days, what it thinks about, what it
// learns and remembers. Everything is derived from what the town already records.

export type TimeCategory = 'learning' | 'creating' | 'people' | 'outdoors' | 'food';

/** Awake time by what it was for. Order = colour order on the page. Sleep is left out. */
export const TIME_CATEGORIES: { id: TimeCategory; label: string; kinds: ActivityKind[] }[] = [
  { id: 'learning', label: 'Learning', kinds: ['read', 'browse', 'visit_workshop'] },
  { id: 'creating', label: 'Creating', kinds: ['paint', 'code', 'build', 'hang_painting'] },
  { id: 'people', label: 'People', kinds: ['chat', 'check_mail', 'post_note'] },
  { id: 'outdoors', label: 'Out and about', kinds: ['stroll', 'think', 'people_watch'] },
  { id: 'food', label: 'Food and coffee', kinds: ['eat', 'coffee'] },
];

export function timeCategoryOf(kind: ActivityKind): TimeCategory | null {
  return TIME_CATEGORIES.find((c) => c.kinds.includes(kind))?.id ?? null;
}

export interface MindDay {
  day: number;
  /** Sim minutes per category. */
  minutes: Record<TimeCategory, number>;
  highlights: { icon: string; text: string }[];
  diary: string | null;
}

export interface KnowledgeItem {
  kind: 'book' | 'web' | 'letter';
  day: number;
  title: string;
  text: string;
  sources?: WebSource[];
}

export interface Interest {
  word: string;
  /** In how many of its own texts the word came up, over the window. */
  total: number;
  /** Per day over the window (see MindView.interestDays). */
  perDay: number[];
  /** Clearly more in the last three days than before. */
  rising: boolean;
}

export interface MindView {
  today: number;
  stats: { booksRead: number; searches: number; paintings: number; websites: number; builds: number; letters: number; chats: number; notes: number };
  interests: Interest[];
  interestDays: number[];
  /** Every night's notebook, oldest first. */
  memory: { day: number; notes: string[] }[];
  /** Newest first. Letters only when they were public. */
  knowledge: KnowledgeItem[];
  neighbors: { id: string; name: string; species: string; look: Look; notes: string[] }[];
  /** Newest first. */
  days: MindDay[];
}
