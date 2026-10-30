import type { LlmMeta } from './types.ts';

// The Code Lab: small websites the character writes, kept in projects (folders of text
// files), mirrored to a local Git server when there is one, and served in a sandbox.

export const CODE_EXTENSIONS = ['html', 'css', 'js', 'json', 'svg', 'txt', 'md'] as const;
export const MAX_PROJECTS = 30;
export const MAX_PROJECT_FILES = 12;
export const MAX_FILE_CHARS = 40_000;
export const MAX_PROJECT_CHARS = 80_000;
export const MAX_COMMIT_MESSAGE_CHARS = 200;
export const MAX_PROJECT_NAME_CHARS = 40;
export const MAX_PROJECT_DESCRIPTION_CHARS = 200;

/**
 * A safe path inside a project: lowercase-friendly segments, at most three deep, a known
 * text extension, no hidden files, nothing that climbs out. Returns the normalised path
 * or null.
 */
export function cleanProjectPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.trim().replace(/^\.?\/+/, '');
  const segments = path.split('/');
  if (segments.length === 0 || segments.length > 3) return null;
  if (segments.some((s) => !/^[\w][\w.-]{0,63}$/.test(s) || s.includes('..'))) return null;
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return (CODE_EXTENSIONS as readonly string[]).includes(ext) ? path : null;
}

/** "My Pond Clock!" -> "my-pond-clock". */
export function projectSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, MAX_PROJECT_NAME_CHARS) || 'project'
  );
}

export interface ProjectCommit {
  message: string;
  simTime: number;
  /** Set when the commit reached the Git server. */
  sha?: string;
}

/** A project as everyone sees it (no file contents). */
export interface CodeProject {
  slug: string;
  name: string;
  description: string;
  files: { path: string; chars: number }[];
  /** Newest first. */
  commits: ProjectCommit[];
  /** Where the site runs (the sandboxed sites server). */
  siteUrl: string;
  /** The repository on the Git server, if there is one. */
  repoUrl: string | null;
}

export interface ProjectFile {
  path: string;
  content: string;
}

/** What the brain sends after a coding session. */
export interface CodeCommitRequest {
  /** An existing project's slug, or the name of a new one. */
  project: string;
  /** For a new project: what it is. */
  description?: string;
  /** Files to create or replace. */
  files: ProjectFile[];
  /** Paths to remove. */
  deleted?: string[];
  message: string;
  /** The content check said no: nothing is saved or published. */
  held?: boolean;
  llm?: LlmMeta[];
}
