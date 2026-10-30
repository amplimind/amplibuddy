import type { GyrosEventKind, GyrosNudgeRun, GyrosState, GyrosStation } from './gyros.ts';
import type { MailStats } from './mail.ts';
import type { Look } from './species.ts';
import type { TownState } from './building.ts';

// Everything the sim, the brain and the web client agree on.
// Time is always "sim minutes" since the world began (day 1, 00:00).

export type PlaceId = 'home' | 'cafe' | 'park' | 'library' | 'plaza' | 'netcafe' | 'studio' | 'workshop' | 'lab';

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
  | 'visit_workshop'
  | 'code'
  | 'build'
  | 'hang_painting';

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
  /** Where to build, for `build`: a plot id (see PLOTS). */
  plot?: string;
  /** For `hang_painting`: which painting, and on which frame (see FRAMES). */
  artId?: number;
  frame?: string;
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
  /** Bumped whenever something is built or hung, so clients fetch /api/town again. */
  townVersion: number;
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
      data: {
        kind: ActivityKind;
        place: PlaceId;
        bookTitle?: string;
        query?: string;
        with?: string;
        /** Building or hanging a painting: where exactly ("by the pond"). */
        where?: string;
      };
    }
  | { type: 'activity_finished'; data: { kind: ActivityKind; place: PlaceId } }
  | { type: 'walk_started'; data: { from: PlaceId; to: PlaceId } }
  /** `part`/`parts`: which part of a long book this was (absent for one-part books). */
  | { type: 'reading'; data: { bookId: string; title: string; takeaway: string; part?: number; parts?: number; llm?: LlmMeta } }
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
  /** The town or the character got a new name in the settings. */
  | { type: 'renamed'; data: { what: 'town' | 'character'; from: string; to: string } }
  /**
   * Something the character built on a plot. `replaced`: what stood there before. Held builds
   * carry no name or description, only `held`, so the character knows nothing went up.
   */
  | {
      type: 'built';
      data: { plot: string; where: string; buildId?: number; name?: string; description?: string; replaced?: string; held?: boolean; llm?: LlmMeta };
    }
  /** A painting went up on a frame. `replaced`: the title of the one that hung there before. */
  | { type: 'painting_hung'; data: { frame: string; where: string; artId: number; title: string; replaced?: string } }
  /** One of the character's websites stopped with an error in someone's browser. */
  | { type: 'site_error'; data: { project: string; name: string; problem: string } }
  /**
   * A coding session at the Code Lab. `files`/`deleted`: what changed. `sha`: the commit on the
   * Git server (absent when there is none or it was unreachable). `held`: the content check said
   * no, nothing was saved.
   */
  | {
      type: 'code_committed';
      data: {
        project: string;
        name: string;
        message?: string;
        files?: string[];
        deleted?: string[];
        sha?: string;
        /** Where the site runs, and the commit on the Git server (when there is one). */
        url?: string;
        commitUrl?: string;
        /** What the Code Lab's check found: syntax errors, missing files, things the sandbox blocks. */
        warnings?: string[];
        held?: boolean;
        /** Why it couldn't be saved (a path or size the Code Lab doesn't allow). */
        error?: string;
        llm?: LlmMeta;
      };
    }
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
  /** How many visits it takes to read it once (see READING_PART_CHARS). */
  parts: number;
}

export interface BookWithText extends Book {
  text: string;
}

/** One part of a book, as the brain gets it for a reading session. */
export interface BookPart extends Book {
  /** 1-based. */
  part: number;
  text: string;
  /** What the character noted on the previous parts of this read, oldest first. */
  earlier: string[];
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
  /** `nextPart`: where reading continues (1 = from the start). */
  books: (Book & { timesRead: number; nextPart: number })[];
  usageToday: UsageToday;
  mail: MailStats;
  /** Web searches since 00:00 UTC, for the daily cap. */
  browsesToday: number;
  /** The latest web searches (newest last), so the character doesn't look up the same thing again. */
  recentSearches: { query: string; takeaway?: string; simTime: number }[];
  /** What the character itself said lately (thoughts, notes, searches, paintings, chat lines), oldest first. */
  recentOwnTexts: string[];
  /** Its websites at the Code Lab (no file contents), and coding sessions since 00:00 UTC. */
  projects: { slug: string; name: string; description: string; files: string[]; lastCommit: string | null; problems: string[] }[];
  codeToday: number;
  /** Artworks since 00:00 UTC, for the daily cap. */
  artToday: number;
  /** Chats started since 00:00 UTC, for the daily cap. */
  chatsToday: number;
  /** Notice-board notes since the start of the current sim day, for the daily cap. */
  notesToday: number;
  /** Each neighbour's own notes (about Ampli and the town), keyed by neighbour id. */
  neighborNotes: Record<string, string[]>;
  /** What stands on the plots and hangs on the frames, and the paintings it could hang. */
  town: TownState;
  paintings: { id: number; title: string }[];
  /** Builds since 00:00 UTC (any status), and paintings hung since then, for the daily caps. */
  buildsToday: number;
  hangsToday: number;
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
  /** The part that was read (1-based), as handed out by the sim. */
  part?: number;
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
