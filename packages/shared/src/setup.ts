import type { Look } from './species.ts';
import type { PlaceId } from './types.ts';

// The setup wizard and the settings page: what the browser sees and sends.

export const MAX_SETUP_NAME_CHARS = 30;
export const MAX_SETUP_SPECIES_CHARS = 40;
export const MAX_PERSONALITY_CHARS = 6000;

/** Where neighbours can live. Home is the main character's. */
export const RESIDENT_PLACES: PlaceId[] = ['cafe', 'park', 'library', 'plaza', 'netcafe', 'studio', 'workshop', 'lab'];

export interface PersonaDraft {
  name: string;
  species: string;
  look: Look;
  town: string;
  personality: string;
}

export interface ResidentDraft {
  /** Absent for a new resident; the sim makes one from the name. */
  id?: string;
  name: string;
  species: string;
  look: Look;
  place: PlaceId;
  /** Null = there all day. */
  hours: { from: number; to: number } | null;
  personality: string;
  active: boolean;
}

export interface PersonalityTemplate {
  id: string;
  title: string;
  description: string;
  personality: string;
  /** Resident templates suggest the rest too. */
  name?: string;
  species?: string;
  look?: Look;
  place?: PlaceId;
  hours?: { from: number; to: number } | null;
}

export type BrainMode = 'local' | 'cloud';

export interface SetupState {
  complete: boolean;
  persona: PersonaDraft;
  residents: ResidentDraft[];
  brain: {
    mode: BrainMode | null;
    model: string;
    visionModel: string;
    /** Whether an OpenRouter key is configured. The key itself never leaves the server. */
    hasKey: boolean;
  };
  /** Sim minutes per real second. */
  speed: number;
  gyros: { url: string; uiUrl: string };
  /** Whether the character may build things in town. */
  building: boolean;
  templates: { characters: PersonalityTemplate[]; residents: PersonalityTemplate[] };
  machine: { ramGb: number };
}

export interface SetupApply {
  persona?: PersonaDraft;
  /** The full list: residents not in it are removed. */
  residents?: ResidentDraft[];
  brain?: { mode: BrainMode; model?: string; visionModel?: string; openrouterKey?: string };
  speed?: number;
  gyros?: { url: string; uiUrl: string };
  building?: boolean;
  complete?: boolean;
}

export interface LocalModelChoice {
  /** What to download from the Ollama library. */
  model: string;
  /** For doodles; same as model if it can see. */
  visionModel: string;
  downloadGb: number;
  note: string;
}

export interface OllamaStatus {
  installed: boolean;
  running: boolean;
  version: string | null;
  models: string[];
  recommended: LocalModelChoice;
}

/** The workshop only shows a GyrOS that runs on this machine. */
export const GYROS_DEFAULTS = { url: 'http://localhost:8100', uiUrl: 'http://localhost:3200' };

/** http(s) on localhost, 127.0.0.1 or [::1]; anything else is not "this machine". */
export function isLocalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** The Code Lab's Git server, as the settings page sees it. */
export interface GitProbe {
  running: boolean;
  url: string;
  version: string | null;
  /** The town has a token for it (set up by `npm run git:start`). */
  connected: boolean;
}

export interface GyrosProbe {
  /** GyrOS answered on this machine. */
  running: boolean;
  url: string;
  /** How many runs it knows about, when running. */
  runs: number;
}

/** Ollama loads models with a huge context on big Macs; ours run as "ampli-<model>" with 16k. */
export const LOCAL_CONTEXT = 16384;
export const localAlias = (model: string) => `ampli-${model}`;

/** The best local setup for this much memory. */
export function recommendLocalModel(ramGb: number): LocalModelChoice {
  if (ramGb >= 40) {
    return {
      model: 'ornith:35b',
      visionModel: 'gemma4:12b',
      downloadGb: 29,
      note: 'Fast and good: a mixture-of-experts model for thinking, plus a smaller one that can look at doodles.',
    };
  }
  return {
    model: 'gemma4:12b',
    visionModel: 'gemma4:12b',
    downloadGb: 8,
    note:
      ramGb >= 14
        ? 'One model for everything, including doodles. Fits comfortably in your memory.'
        : 'Your Mac has little memory for local models: this will be slow. The cloud option is faster.',
  };
}
