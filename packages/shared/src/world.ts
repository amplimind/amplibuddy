import type { ActivityKind, Needs, PlaceId, Point } from './types.ts';

// The town is a 40x24 tile grid. Every place has a door on its own vertical
// lane; all lanes join the main street at y = MAIN_STREET_Y.

export const MAP_WIDTH = 40;
export const MAP_HEIGHT = 24;
export const MAIN_STREET_Y = 12;
/** Sim minutes it takes to walk one tile. */
export const MINUTES_PER_TILE = 1.5;
/** Max length of a web search query. */
export const MAX_QUERY_CHARS = 120;

export interface PlaceDef {
  id: PlaceId;
  name: string;
  /** Footprint in tiles, used by the renderer. */
  area: { x: number; y: number; w: number; h: number };
  door: Point;
  /** Where the character hangs out while there (inside, for buildings). Must share an x or y with the door. */
  spot: Point;
  description: string;
}

export const PLACES: Record<PlaceId, PlaceDef> = {
  home: {
    id: 'home',
    name: 'Home',
    area: { x: 3, y: 3, w: 7, h: 6 },
    door: { x: 6, y: 9 },
    spot: { x: 6, y: 4 }, // the bed
    description: 'A small cottage with a round window and a very soft bed.',
  },
  cafe: {
    id: 'cafe',
    name: 'Café Kiosk',
    area: { x: 30, y: 3, w: 7, h: 6 },
    door: { x: 33, y: 9 },
    spot: { x: 33, y: 6 }, // a table by the window
    description: 'Warm pastries, strong coffee, a table by the window.',
  },
  library: {
    id: 'library',
    name: 'Library',
    area: { x: 3, y: 15, w: 8, h: 6 },
    door: { x: 6, y: 14 },
    spot: { x: 6, y: 18 }, // the reading chair
    description: 'Quiet shelves. The town keeps its books here.',
  },
  park: {
    id: 'park',
    name: 'Park',
    area: { x: 27, y: 14, w: 11, h: 8 },
    door: { x: 32, y: 13 },
    spot: { x: 32, y: 17 },
    description: 'Trees, a pond, and a bench that is perfect for thinking.',
  },
  studio: {
    id: 'studio',
    name: 'Art Studio',
    area: { x: 12, y: 2, w: 9, h: 5 },
    door: { x: 14, y: 7 },
    spot: { x: 14, y: 4 }, // at the easel
    description: 'An easel by the big window, paint pots everywhere, and your own pictures on the walls.',
  },
  netcafe: {
    id: 'netcafe',
    name: 'Internet Café',
    area: { x: 12, y: 18, w: 8, h: 5 },
    door: { x: 14, y: 17 },
    spot: { x: 14, y: 20 }, // a computer desk
    description: 'Three old computers, a humming router and a window onto the whole internet.',
  },
  plaza: {
    id: 'plaza',
    name: 'Plaza',
    area: { x: 16, y: 9, w: 9, h: 7 },
    door: { x: 20, y: MAIN_STREET_Y },
    spot: { x: 20, y: 14 },
    description: 'The middle of town. A fountain, and people passing through.',
  },
};

export const PLACE_IDS = Object.keys(PLACES) as PlaceId[];

/** Need change per sim hour. Activities replace these defaults while they run. */
export type Rates = Needs;

export const IDLE_RATES: Rates = { energy: -4, satiety: -6, fun: -8 };

export interface ActivityDef {
  kind: ActivityKind;
  place: PlaceId;
  /** Shown in the UI: "Ampli is <verb>". */
  verb: string;
  /** Shown to the LLM as an option. */
  description: string;
  /** Sim minutes. Sleep is computed (until morning). */
  minutes: number;
  rates: Rates;
}

export const ACTIVITIES: Record<ActivityKind, ActivityDef> = {
  sleep: {
    kind: 'sleep',
    place: 'home',
    verb: 'sleeping',
    description: 'Go to bed for the night (until about 07:00).',
    minutes: 0,
    rates: { energy: 14, satiety: -2, fun: 0 },
  },
  nap: {
    kind: 'nap',
    place: 'home',
    verb: 'napping',
    description: 'A short nap at home.',
    minutes: 60,
    rates: { energy: 12, satiety: -3, fun: 0 },
  },
  eat: {
    kind: 'eat',
    place: 'cafe',
    verb: 'eating',
    description: 'Have a proper meal at the café.',
    minutes: 30,
    rates: { energy: 0, satiety: 130, fun: 6 },
  },
  coffee: {
    kind: 'coffee',
    place: 'cafe',
    verb: 'having a coffee',
    description: 'A quick coffee. Wakes you up a bit.',
    minutes: 20,
    rates: { energy: 30, satiety: 0, fun: 8 },
  },
  stroll: {
    kind: 'stroll',
    place: 'park',
    verb: 'strolling through the park',
    description: 'Wander around the park and the pond.',
    minutes: 45,
    rates: { energy: -6, satiety: -6, fun: 24 },
  },
  think: {
    kind: 'think',
    place: 'park',
    verb: 'sitting on the bench, thinking',
    description: 'Sit on the park bench and think things over.',
    minutes: 30,
    rates: { energy: -2, satiety: -4, fun: 8 },
  },
  read: {
    kind: 'read',
    place: 'library',
    verb: 'reading',
    description: 'Read one of the books in the library (pick a book_id).',
    minutes: 60,
    rates: { energy: -3, satiety: -4, fun: 18 },
  },
  people_watch: {
    kind: 'people_watch',
    place: 'plaza',
    verb: 'watching people at the plaza',
    description: 'Sit by the fountain and watch the town go by.',
    minutes: 30,
    rates: { energy: -3, satiety: -5, fun: 12 },
  },
  browse: {
    kind: 'browse',
    place: 'netcafe',
    verb: 'browsing the internet',
    description: 'Look something up on the real internet at the internet café (give a search query).',
    minutes: 45,
    rates: { energy: -4, satiety: -5, fun: 20 },
  },
  paint: {
    kind: 'paint',
    place: 'studio',
    verb: 'painting in the studio',
    description: 'Make an artwork at your art studio, about whatever is on your mind.',
    minutes: 60,
    rates: { energy: -4, satiety: -5, fun: 22 },
  },
  check_mail: {
    kind: 'check_mail',
    place: 'plaza',
    verb: 'reading letters at the post box',
    description: 'Go to the post box at the plaza and read the letters colleagues left you.',
    minutes: 30,
    rates: { energy: -2, satiety: -4, fun: 14 },
  },
};

export const ACTIVITY_KINDS = Object.keys(ACTIVITIES) as ActivityKind[];

export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === 'string' && value in ACTIVITIES;
}

// --- Paths -----------------------------------------------------------------

/** Spot -> door -> main street -> door -> spot. Consecutive duplicates removed. */
export function pathBetween(from: PlaceId, to: PlaceId): Point[] {
  const a = PLACES[from];
  const b = PLACES[to];
  const raw: Point[] = [
    a.spot,
    a.door,
    { x: a.door.x, y: MAIN_STREET_Y },
    { x: b.door.x, y: MAIN_STREET_Y },
    b.door,
    b.spot,
  ];
  return raw.filter((p, i) => i === 0 || p.x !== raw[i - 1]!.x || p.y !== raw[i - 1]!.y);
}

export function pathLength(path: Point[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += Math.abs(path[i]!.x - path[i - 1]!.x) + Math.abs(path[i]!.y - path[i - 1]!.y);
  }
  return total;
}

/** Position at fraction t (0..1) of the way along an axis-aligned path. */
export function pointAlong(path: Point[], t: number): Point {
  if (path.length === 0) return { x: 0, y: 0 };
  const total = pathLength(path);
  if (total === 0 || t <= 0) return { ...path[0]! };
  if (t >= 1) return { ...path[path.length - 1]! };
  let remaining = t * total;
  for (let i = 1; i < path.length; i++) {
    const p = path[i - 1]!;
    const q = path[i]!;
    const seg = Math.abs(q.x - p.x) + Math.abs(q.y - p.y);
    if (remaining <= seg) {
      const f = seg === 0 ? 0 : remaining / seg;
      return { x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f };
    }
    remaining -= seg;
  }
  return { ...path[path.length - 1]! };
}

export function walkMinutes(from: PlaceId, to: PlaceId): number {
  return pathLength(pathBetween(from, to)) * MINUTES_PER_TILE;
}

// --- Time ------------------------------------------------------------------

export const MINUTES_PER_DAY = 24 * 60;
export const WAKE_UP_HOUR = 7;

export function dayOf(simTime: number): number {
  return Math.floor(simTime / MINUTES_PER_DAY) + 1;
}

export function hourOf(simTime: number): number {
  return (simTime % MINUTES_PER_DAY) / 60;
}

export function isNight(simTime: number): boolean {
  const h = hourOf(simTime);
  return h >= 22 || h < 5;
}

export function formatTime(simTime: number): string {
  const minuteOfDay = Math.floor(simTime % MINUTES_PER_DAY);
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const mm = String(minuteOfDay % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatClock(simTime: number): string {
  return `Day ${dayOf(simTime)} · ${formatTime(simTime)}`;
}

/** Minutes from simTime until the next WAKE_UP_HOUR:00 (at least 60). */
export function minutesUntilMorning(simTime: number): number {
  const minuteOfDay = simTime % MINUTES_PER_DAY;
  const wake = WAKE_UP_HOUR * 60;
  const delta = minuteOfDay < wake ? wake - minuteOfDay : MINUTES_PER_DAY - minuteOfDay + wake;
  return Math.max(60, delta);
}

// --- Content files -----------------------------------------------------------

/** Minimal `key: value` frontmatter parser for persona and library markdown files. */
export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: match[2]!.trim() };
}
