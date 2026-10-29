// Mailbox rules shared by sim (validation), brain (prompts) and web (form limits).

export const MAX_NAME_CHARS = 40;
export const MAX_LETTER_CHARS = 500;
export const MAX_REPLY_CHARS = 600;
/** Doodles are small PNGs drawn in the browser. */
export const DOODLE_SIZE = 256;
export const MAX_DOODLE_BYTES = 48_000;
/** Ampli's short description of a doodle, written when replying. */
export const MAX_CAPTION_CHARS = 120;
/** Ampli's note about one visitor (per scope: public / private). */
export const MAX_MEMORY_CHARS = 400;
/** Everything about a visitor is deleted this long after their last visit. */
export const VISITOR_RETENTION_DAYS = 90;
/** Letters Ampli reads per visit to the post box. */
export const LETTERS_PER_CHECK = 5;
/** After this many sim minutes of waiting, a routine rule sends Ampli to the post box. */
export const MAIL_OVERDUE_MINUTES = 180;
/** Answers to Ampli's own questions are worth hurrying for. */
export const ANSWER_OVERDUE_MINUTES = 30;

export type LetterVisibility = 'public' | 'private';

/**
 * checking: waiting for the moderation check
 * held:     a check said no; waits for a human
 * waiting:  in the post box
 * replied / skipped: Ampli has read it
 * hidden:   an admin took it down
 */
export type LetterStatus = 'checking' | 'held' | 'waiting' | 'replied' | 'skipped' | 'hidden';

/** A letter as its sender (or, if public, everyone) may see it. */
export interface Letter {
  id: number;
  name: string;
  text: string;
  visibility: LetterVisibility;
  status: LetterStatus;
  createdAt: string;
  createdSimTime: number;
  /** The doodle itself is served from /api/mail/:id/doodle with the letter's visibility rules. */
  hasDoodle: boolean;
  /** What Ampli saw in the doodle, once it has replied. */
  doodleCaption?: string;
  /** The question of Ampli's this letter answers, if any. */
  question?: string;
  reply?: string;
  repliedSimTime?: number;
}

export interface MailStats {
  waiting: number;
  oldestSimTime: number | null;
  /** Waiting letters that answer one of Ampli's questions, and the oldest of them. */
  answers: number;
  oldestAnswerSimTime: number | null;
}

export interface SendLetterRequest {
  name: string;
  /** May be empty when there is a doodle. */
  text: string;
  private: boolean;
  /** data:image/png;base64,… */
  doodle?: string;
  /** Event id of the question (a note_posted with question: true) this letter answers. */
  inReplyTo?: number;
}

export type Verdict = 'ok' | 'hold';

export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_CHARS);
  return name || null;
}

export function cleanText(value: unknown, max = MAX_LETTER_CHARS): string | null {
  if (typeof value !== 'string') return null;
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
  return text || null;
}

/**
 * What Ampli remembers about one visitor. Kept in two scopes so that a public
 * reply can never draw on something the visitor said privately.
 */
export interface VisitorMemory {
  /** From public letters only. The only memory a public reply sees. */
  public: string;
  /** From private letters only. Seen only when replying to a private letter. */
  private: string;
}

/** A letter as the brain gets it for checking: with the doodle as a data URL. */
export interface CheckLetter extends Letter {
  doodle?: string;
}

/** A waiting letter as the brain gets it: with this visitor's memory, nothing about others. */
export interface BrainLetter extends CheckLetter {
  memory: VisitorMemory;
  /** Letters from this visitor Ampli has already read. */
  lettersBefore: number;
}

/** What a visitor can see about themselves. */
export interface VisitorProfile {
  name: string;
  firstSeen: string;
  lastSeen: string;
  memory: VisitorMemory;
}

/** A letter as admins see it: including held replies, moderation notes and reports. */
export interface AdminLetter extends Letter {
  visitorId: string;
  /** The reply even when it was held or hidden. */
  draftReply?: string;
  note?: string;
  reports: number;
}

export interface AdminOverview {
  paused: boolean;
  counts: Record<LetterStatus, number>;
  reported: number;
  usageToday: { calls: number; costUsd: number };
}

/** Distinct reporters needed to take a public letter off the board until an admin decides. */
export const REPORTS_TO_HOLD = 3;
