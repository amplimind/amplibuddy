import type { GyrosEventKind, GyrosNudgeRun, GyrosState, GyrosStation } from './gyros.ts';
import type { MailStats } from './mail.ts';
import type { Look } from './species.ts';

// Everything the sim, the brain and the web client agree on.
// Time is always "sim minutes" since the world began (day 1, 00:00).

export type PlaceId = 'home' | 'cafe' | 'park' | 'library' | 'plaza' | 'netcafe' | 'studio' | 'workshop';

export type ActivityKind =
  | 'sleep'
  | 'nap'
  | 'eat'
  | 'coffee'
  | 'stroll'
  | 'think'
  | 'read'
  | 'people_watch'
  | 'check_mail'
  | 'browse'
  | 'paint'
  | 'chat'
  | 'post_note'
  | 'visit_workshop';

export interface Point {
  x: number;
  y: number;
}

/** 0 = desperate, 100 = fully satisfied. */
export interface Needs {
  energy: number;
  satiety: number;
  fun: number;
  /** Company: drains when alone, filled by chats and letters. */
  social: number;
}

export interface Mood {
  label: string;
  /** 0..1, how good the character feels overall. */
  valence: number;
}

/** What the brain asks for. The sim walks there first if needed. */
export interface Plan {
  kind: ActivityKind;
  bookId?: string;
  /** Web search query, for `browse`. */
  query?: string;
  /** Who to talk to, for `chat`: a neighbour's id. The chat happens at their place. */
  partnerId?: string;
}

export interface Activity extends Plan {
  place: PlaceId;
  startedAt: number;
  endsAt: number;
}

export interface Walk {
  from: PlaceId;
  to: PlaceId;
  path: Point[];
  startedAt: number;
  endsAt: number;
}

export interface AgentState {
  place: PlaceId | null;
  position: Point;
  needs: Needs;
  mood: Mood;
  /** Short-lived mood modifier from events, decays toward 0. Range -0.3..0.3. */
  moodBoost: number;
  activity: Activity | null;
  walk: Walk | null;
  /** Activity queued to start once the current walk arrives. */
  next: Plan | null;
  /** True while the brain is deliberating (shown as a thought bubble). */
  thinking: boolean;
}

export interface Persona {
  name: string;
  species: string;
  /** Which drawn animal the character is. */
  look: Look;
  town: string;
}

/** Another animal in town, played by its own AI persona. */
export interface Neighbor {
  id: string;
  name: string;
  species: string;
  look: Look;
  place: PlaceId;
  /** Hours of the day the neighbour is there, e.g. { from: 8, to: 12 }. Absent = always. */
  hours?: { from: number; to: number };
}

export interface WorldSnapshot {
  simTime: number;
  minutesPerSecond: number;
  persona: Persona;
  neighbors: Neighbor[];
  agent: AgentState;
  /** Letters in the post box, shown on the map. */
  mailWaiting: number;
  /** Newest artwork in the gallery, shown on the easel in the studio. */
  latestArtId: number | null;
  /** GyrOS at the workshop; null when no GYROS_URL is configured. */
  gyros: GyrosState | null;
  /** Ampli's latest question if nobody has answered it yet (shown as ❓ and as an answer card). */
  openQuestion: { id: number; text: string; simTime: number } | null;
}

export type ThoughtSource = 'llm' | 'routine' | 'offline';

export interface LlmMeta {
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface Thought {
  text: string;
  source: ThoughtSource;
  llm?: LlmMeta;
}

export type EventBody =
  | { type: 'thought'; data: Thought }
  | {
      type: 'activity_started';
      /** `with`: the chat partner's name. */
      data: { kind: ActivityKind; place: PlaceId; bookTitle?: string; query?: string; with?: string };
    }
  | { type: 'activity_finished'; data: { kind: ActivityKind; place: PlaceId } }
  | { type: 'walk_started'; data: { from: PlaceId; to: PlaceId } }
  | { type: 'reading'; data: { bookId: string; title: string; takeaway: string; llm?: LlmMeta } }
  | { type: 'diary_written'; data: { day: number } }
  /** Public letters carry content; private (or held) ones carry only the id. */
  | {
      type: 'mail_read';
      data: {
        letterId: number;
        from?: string;
        text?: string;
        reply?: string;
        doodle?: boolean;
        doodleCaption?: string;
        /** Ampli's question this letter answered. */
        question?: string;
      };
    }
  /** One line of a conversation between Ampli and a neighbour. */
  | { type: 'chat_line'; data: { chatId: number; speaker: string; name: string; text: string; llm?: LlmMeta } }
  /** Something happened in GyrOS (only whitelisted facts). */
  | {
      type: 'gyros';
      data: {
        kind: GyrosEventKind;
        runId: string;
        ticketKey: string | null;
        title: string | null;
        station: GyrosStation;
        stepLabel: string;
        pendingLabel?: string | null;
        round: number;
        status: string;
      };
    }
  /** What Ampli explained after watching GyrOS at the workshop. */
  | { type: 'workshop_note'; data: { text: string; llm?: LlmMeta } }
  /** Ampli rang the workshop bell for runs that have waited too long for a human. */
  | { type: 'gyros_nudge'; data: { text: string; runs: GyrosNudgeRun[]; llm?: LlmMeta } }
  /**
   * A note Ampli pinned on the notice board. Held notes carry no text, only `held`, and notes that
   * couldn't be written only `failed`, so Ampli knows what actually is on the board.
   */
  | { type: 'note_posted'; data: { text?: string; held?: boolean; failed?: boolean; question?: boolean; llm?: LlmMeta } }
  | { type: 'artwork_created'; data: { artworkId: number; title: string; caption: string; llm?: LlmMeta } }
  /** A web search at the internet café. No takeaway when the outbound check held it. */
  | { type: 'browsed'; data: { query: string; takeaway?: string; sources: WebSource[]; llm?: LlmMeta } };

export interface WebSource {
  title: string;
  url: string;
}

export type EventType = EventBody['type'];

export type WorldEvent = EventBody & {
  id: number;
  simTime: number;
  realTime: string;
};

export interface DiaryEntry {
  day: number;
  simTime: number;
  text: string;
  llm?: LlmMeta;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  blurb: string;
}

export interface BookWithText extends Book {
  text: string;
}

export interface UsageToday {
  calls: number;
  costUsd: number;
}

/** Everything the brain needs to make one decision, in one request. */
export interface BrainContext {
  snapshot: WorldSnapshot;
  idle: boolean;
  recentEvents: WorldEvent[];
  notebook: string[];
  lastDiary: DiaryEntry | null;
  books: (Book & { timesRead: number })[];
  usageToday: UsageToday;
  mail: MailStats;
  /** Web searches since 00:00 UTC, for the daily cap. */
  browsesToday: number;
  /** Artworks since 00:00 UTC, for the daily cap. */
  artToday: number;
  /** Chats started since 00:00 UTC, for the daily cap. */
  chatsToday: number;
  /** Notice-board notes since the start of the current sim day, for the daily cap. */
  notesToday: number;
  /** Each neighbour's own notes (about Ampli and the town), keyed by neighbour id. */
  neighborNotes: Record<string, string[]>;
}

export interface DecisionRequest {
  plan: Plan;
  thought: Thought;
}

export interface DiaryRequest {
  day: number;
  text: string;
  /** Full rewritten notebook: replaces the previous one. */
  notebook: string[];
  llm?: LlmMeta;
}

export interface ReadingRequest {
  bookId: string;
  takeaway: string;
  llm?: LlmMeta;
}

export interface MailVerdictRequest {
  verdict: 'ok' | 'hold';
  reason: string;
  llm?: LlmMeta;
}

export interface MailReplyRequest {
  decision: 'reply' | 'skip';
  reply?: string;
  /** Outbound check said no: store the reply but don't publish it. */
  held?: boolean;
  /** Skip reason or moderation reason. Admin-only, never shown publicly. */
  note?: string;
  /** Rewritten memory about this visitor, for the scope of this letter's visibility. */
  memory?: string;
  /** What the doodle shows, in a few words. */
  doodleCaption?: string;
  llm?: LlmMeta[];
}

export interface BrowseRequest {
  query: string;
  takeaway?: string;
  sources: WebSource[];
  /** Outbound check said no: log the search, not the takeaway. */
  held?: boolean;
  llm?: LlmMeta[];
}

export interface ChatLineRequest {
  chatId: number;
  /** 'ampli' or a neighbour id. */
  speaker: string;
  text: string;
  llm?: LlmMeta;
}

export interface NeighborNotesRequest {
  neighborId: string;
  notes: string[];
  llm?: LlmMeta;
}

export interface NoteRequest {
  text?: string;
  /** Writing the note failed (the model never produced one): nothing gets pinned, but Ampli is told. */
  failed?: boolean;
  /** True when Ampli asks for something and hopes for an answer. */
  question?: boolean;
  /** Outbound check said no: don't pin it. */
  held?: boolean;
  llm?: LlmMeta[];
}

export interface GyrosNudgeRequest {
  /** The overdue runs this bell is about; the sim ignores any that aren't overdue (anymore). */
  runIds: string[];
  text: string;
  llm?: LlmMeta[];
}

export interface WorkshopNoteRequest {
  text: string;
  llm?: LlmMeta;
}
