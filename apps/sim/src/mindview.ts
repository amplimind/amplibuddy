import {
  EVERYDAY_WORDS,
  PLACES,
  TIME_CATEGORIES,
  contentWords,
  dayOf,
  timeCategoryOf,
  type ActivityKind,
  type KnowledgeItem,
  type MindDay,
  type MindView,
  type TimeCategory,
  type WorldEvent,
} from '@ampli-world/shared';
import type { Sim } from './sim.ts';

// The Mind page, computed from what the town already records: events, the diary, every
// night's notebook, the neighbours' notes. Nothing new is stored for it.

const INTEREST_WINDOW_DAYS = 10;
const MAX_INTERESTS = 10;
const MAX_KNOWLEDGE = 150;

const TYPES = [
  'activity_started',
  'activity_finished',
  'thought',
  'reading',
  'browsed',
  'artwork_created',
  'code_committed',
  'note_posted',
  'mail_read',
  'built',
  'painting_hung',
] as const;

const emptyMinutes = (): Record<TimeCategory, number> =>
  Object.fromEntries(TIME_CATEGORIES.map((c) => [c.id, 0])) as Record<TimeCategory, number>;

/** What the character itself wrote or chose, for finding its interests. */
function ownText(e: WorldEvent): string | null {
  switch (e.type) {
    case 'thought':
      return e.data.source === 'llm' ? e.data.text : null;
    case 'browsed':
      return e.data.query;
    case 'reading':
      return e.data.takeaway;
    case 'artwork_created':
      return `${e.data.title}. ${e.data.caption}`;
    case 'code_committed':
      return e.data.message ?? null;
    case 'note_posted':
      return e.data.text ?? null;
    case 'built':
      return e.data.name ? `${e.data.name}. ${e.data.description}` : null;
    default:
      return null;
  }
}

function highlight(e: WorldEvent): { icon: string; text: string } | null {
  switch (e.type) {
    case 'reading':
      return { icon: '📖', text: `Read “${e.data.title}”${e.data.part ? ` (part ${e.data.part} of ${e.data.parts})` : ''}` };
    case 'browsed':
      return { icon: '🔎', text: `Looked up “${e.data.query}”` };
    case 'artwork_created':
      return { icon: '🎨', text: `Painted “${e.data.title}”` };
    case 'code_committed':
      return e.data.message ? { icon: '⌨️', text: `${e.data.name}: ${e.data.message}` } : null;
    case 'note_posted':
      return e.data.text ? { icon: e.data.question ? '❓' : '📌', text: e.data.text } : null;
    case 'mail_read':
      return e.data.from ? { icon: '✉️', text: `Letter from ${e.data.from}` } : { icon: '✉️', text: 'A private letter' };
    case 'activity_started':
      return e.data.with ? { icon: '💬', text: `Chatted with ${e.data.with}` } : null;
    case 'built':
      return e.data.name ? { icon: '🔨', text: `Built “${e.data.name}” ${e.data.where}` } : null;
    case 'painting_hung':
      return { icon: '🖼️', text: `Hung “${e.data.title}” ${e.data.where}` };
    default:
      return null;
  }
}

function knowledge(e: WorldEvent): KnowledgeItem | null {
  const day = dayOf(e.simTime);
  switch (e.type) {
    case 'reading':
      return { kind: 'book', day, title: e.data.part ? `${e.data.title}, part ${e.data.part}` : e.data.title, text: e.data.takeaway };
    case 'browsed':
      return e.data.takeaway ? { kind: 'web', day, title: e.data.query, text: e.data.takeaway, sources: e.data.sources } : null;
    case 'mail_read':
      // Only public letters: private ones never leave the post box.
      return e.data.from && e.data.text ? { kind: 'letter', day, title: `From ${e.data.from}`, text: e.data.text.slice(0, 400) } : null;
    default:
      return null;
  }
}

export function buildMindView(sim: Sim): MindView {
  const events = sim.store.eventsOfTypes([...TYPES]);
  const today = dayOf(sim.engine.simTime);
  const names = new Set(
    [sim.persona.name, sim.persona.town, ...sim.neighbors.map((n) => n.name), ...Object.values(PLACES).map((p) => p.name)].flatMap((n) =>
      [...contentWords(n)],
    ),
  );

  const days = new Map<number, MindDay>();
  const dayEntry = (day: number) => {
    let d = days.get(day);
    if (!d) days.set(day, (d = { day, minutes: emptyMinutes(), highlights: [], diary: null }));
    return d;
  };

  // Interests: in how many of its own texts per day each meaningful word came up.
  const firstDay = Math.max(1, today - INTEREST_WINDOW_DAYS + 1);
  const interestDays = Array.from({ length: today - firstDay + 1 }, (_, i) => firstDay + i);
  const wordDays = new Map<string, number[]>();

  let started: { kind: ActivityKind; simTime: number } | null = null;
  const stats = { booksRead: 0, searches: 0, paintings: 0, websites: sim.projects?.slugs().length ?? 0, builds: 0, letters: 0, chats: 0, notes: 0 };
  const items: KnowledgeItem[] = [];

  for (const e of events) {
    const day = dayOf(e.simTime);
    if (e.type === 'activity_started') {
      started = { kind: e.data.kind, simTime: e.simTime };
      if (e.data.kind === 'chat') stats.chats++;
    } else if (e.type === 'activity_finished' && started) {
      const category = timeCategoryOf(started.kind);
      if (category) dayEntry(dayOf(started.simTime)).minutes[category] += Math.max(0, e.simTime - started.simTime);
      started = null;
    }
    if (e.type === 'reading') stats.booksRead++;
    if (e.type === 'browsed') stats.searches++;
    if (e.type === 'artwork_created') stats.paintings++;
    if (e.type === 'built' && e.data.name) stats.builds++;
    if (e.type === 'mail_read') stats.letters++;
    if (e.type === 'note_posted' && e.data.text) stats.notes++;

    const h = highlight(e);
    if (h) dayEntry(day).highlights.push(h);
    const k = knowledge(e);
    if (k) items.push(k);

    const text = ownText(e);
    if (text && day >= firstDay) {
      for (const word of contentWords(text)) {
        if (word.length < 4 || EVERYDAY_WORDS.has(word) || names.has(word)) continue;
        const perDay = wordDays.get(word) ?? new Array<number>(interestDays.length).fill(0);
        perDay[day - firstDay]!++;
        wordDays.set(word, perDay);
      }
    }
  }

  for (const entry of sim.store.diary(366)) dayEntry(entry.day).diary = entry.text;

  const interests = [...wordDays]
    .map(([word, perDay]) => {
      const total = perDay.reduce((a, b) => a + b, 0);
      const recent = perDay.slice(-3).reduce((a, b) => a + b, 0);
      const before = total - recent;
      const beforeDays = Math.max(1, perDay.length - 3);
      return { word, total, perDay, rising: recent >= 3 && recent / 3 > (before / beforeDays) * 1.5 };
    })
    .filter((i) => i.total >= 3)
    .sort((a, b) => b.total - a.total || b.perDay.at(-1)! - a.perDay.at(-1)!)
    .slice(0, MAX_INTERESTS);

  return {
    today,
    stats,
    interests,
    interestDays,
    // Rewritten at bedtime, often after midnight: that still belongs to the day before.
    memory: sim.store.notebookHistory().map((n) => ({ day: dayOf(n.simTime - 6 * 60), notes: n.notes })),
    knowledge: items.reverse().slice(0, MAX_KNOWLEDGE),
    neighbors: sim.neighbors.map((n) => ({ id: n.id, name: n.name, species: n.species, look: n.look, notes: sim.store.neighborNotes(n.id) })),
    days: [...days.values()].sort((a, b) => b.day - a.day),
  };
}
