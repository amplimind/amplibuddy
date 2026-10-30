import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import {
  MAX_COMMIT_MESSAGE_CHARS,
  MAX_FILE_CHARS,
  MAX_PROJECT_CHARS,
  MAX_PROJECT_DESCRIPTION_CHARS,
  MAX_PROJECT_FILES,
  MAX_PROJECT_NAME_CHARS,
  MAX_PROJECTS,
  cleanProjectPath,
  projectSlug,
  type CodeCommitRequest,
  type CodeProject,
  type ProjectCommit,
  type ProjectFile,
} from '@ampli-world/shared';
import { checkProject } from './check.ts';

// The Code Lab's projects: one folder of text files per website in data/projects/<slug>/,
// plus <slug>.json with its name, description and commits. The folder is the truth; a local
// Git server (Forgejo), when there is one, gets every change as a real commit.

interface ProjectMeta {
  name: string;
  description: string;
  commits: ProjectCommit[];
  problems?: string[];
}

const MAX_KEPT_COMMITS = 30;

/** Slugs come from URLs too: only what projectSlug() makes is a project, nothing that could climb out. */
const isSlug = (slug: string) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(slug);

function line(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Commits to a Forgejo (or Gitea) server through its API, as the character's own user. */
export class GitServer {
  constructor(
    readonly url: string,
    readonly user: string,
    private readonly token: string,
    private readonly author: { name: string; email: string },
  ) {}

  repoUrl(slug: string): string {
    return `${this.url}/${encodeURIComponent(this.user)}/${encodeURIComponent(slug)}`;
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await fetch(`${this.url}/api/v1${path}`, {
      method,
      headers: { authorization: `token ${this.token}`, 'content-type': 'application/json', accept: 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
  }

  private repoPath(slug: string): string {
    return `/repos/${encodeURIComponent(this.user)}/${encodeURIComponent(slug)}`;
  }

  /** Makes the repository if it doesn't exist yet. */
  async ensureRepo(slug: string, description: string): Promise<void> {
    if ((await this.api('GET', this.repoPath(slug))).status === 200) return;
    const created = await this.api<{ message?: string }>('POST', '/user/repos', {
      name: slug,
      description,
      private: false,
      auto_init: false,
      default_branch: 'main',
    });
    if (created.status !== 201) throw new Error(`could not create the repository: ${created.data?.message ?? created.status}`);
  }

  /** One commit with all changes (content null = delete). Returns the commit's sha. */
  async commit(slug: string, changes: { path: string; content: string | null }[], message: string): Promise<string> {
    // Updates and deletes need each file's current blob sha.
    const tree = await this.api<{ tree?: { path: string; sha: string; type: string }[] }>(
      'GET',
      `${this.repoPath(slug)}/git/trees/main?recursive=true&per_page=1000`,
    );
    const shas = new Map((tree.status === 200 ? (tree.data.tree ?? []) : []).filter((t) => t.type === 'blob').map((t) => [t.path, t.sha]));
    const files = changes
      .filter((c) => c.content !== null || shas.has(c.path))
      .map((c) =>
        c.content === null
          ? { operation: 'delete', path: c.path, sha: shas.get(c.path) }
          : {
              operation: shas.has(c.path) ? 'update' : 'create',
              path: c.path,
              content: Buffer.from(c.content, 'utf8').toString('base64'),
              ...(shas.has(c.path) ? { sha: shas.get(c.path) } : {}),
            },
      );
    if (files.length === 0) throw new Error('nothing to commit');
    const res = await this.api<{ commit?: { sha?: string }; message?: string }>('POST', `${this.repoPath(slug)}/contents`, {
      branch: 'main',
      message,
      files,
      author: this.author,
      committer: this.author,
    });
    const sha = res.data?.commit?.sha;
    if (res.status !== 201 || !sha) throw new Error(`commit failed: ${res.data?.message ?? res.status}`);
    return sha;
  }
}

export class CommitError extends Error {}

export class Projects {
  constructor(
    private readonly dir: string,
    /** Where the sandboxed sites server answers, e.g. http://localhost:4380. */
    private readonly sitesUrl: string,
    readonly git: GitServer | null = null,
  ) {}

  private metaFile(slug: string): string {
    return join(this.dir, `${slug}.json`);
  }

  private folder(slug: string): string {
    return join(this.dir, slug);
  }

  private meta(slug: string): ProjectMeta | null {
    if (!isSlug(slug)) return null;
    try {
      return JSON.parse(readFileSync(this.metaFile(slug), 'utf8')) as ProjectMeta;
    } catch {
      return null;
    }
  }

  slugs(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5))
      .filter((slug) => existsSync(this.folder(slug)))
      .sort();
  }

  /** Every file of a project with its content. */
  files(slug: string): ProjectFile[] {
    const root = this.folder(slug);
    if (!this.meta(slug) || !existsSync(root)) return [];
    const out: ProjectFile[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir).sort()) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else {
          const path = cleanProjectPath(relative(root, full));
          if (path) out.push({ path, content: readFileSync(full, 'utf8') });
        }
      }
    };
    walk(root);
    return out;
  }

  /** A file to serve from the sites server, or null. */
  file(slug: string, path: string): string | null {
    const clean = cleanProjectPath(path);
    if (!clean || !this.meta(slug)) return null;
    const full = join(this.folder(slug), clean);
    return existsSync(full) && statSync(full).isFile() ? readFileSync(full, 'utf8') : null;
  }

  project(slug: string): CodeProject | null {
    const meta = this.meta(slug);
    if (!meta) return null;
    return {
      slug,
      name: meta.name,
      description: meta.description,
      files: this.files(slug).map((f) => ({ path: f.path, chars: f.content.length })),
      commits: meta.commits,
      siteUrl: `${this.sitesUrl}/${slug}/`,
      repoUrl: this.git ? this.git.repoUrl(slug) : null,
      problems: meta.problems ?? [],
    };
  }

  list(): CodeProject[] {
    return this.slugs()
      .map((slug) => this.project(slug)!)
      .filter(Boolean)
      .sort((a, b) => (b.commits[0]?.simTime ?? 0) - (a.commits[0]?.simTime ?? 0));
  }

  /**
   * Applies a coding session: checks every path and size, writes the files, records the
   * commit and mirrors it to the Git server (a failed mirror doesn't undo the local change).
   */
  async commit(req: CodeCommitRequest, simTime: number) {
    const message = line(req.message, MAX_COMMIT_MESSAGE_CHARS);
    if (!message) throw new CommitError('a commit needs a message');
    const existing = this.slugs().includes(req.project) ? req.project : null;
    let slug = existing;
    let meta: ProjectMeta;
    if (existing) {
      meta = this.meta(existing)!;
    } else {
      const name = line(req.project, MAX_PROJECT_NAME_CHARS);
      if (!name) throw new CommitError('a new project needs a name');
      if (this.slugs().length >= MAX_PROJECTS) throw new CommitError(`at most ${MAX_PROJECTS} projects`);
      slug = projectSlug(name);
      for (let n = 2; this.slugs().includes(slug); n++) slug = `${projectSlug(name)}-${n}`;
      meta = { name, description: line(req.description, MAX_PROJECT_DESCRIPTION_CHARS), commits: [] };
    }

    // Validate everything before touching the disk.
    const current = new Map(this.files(slug!).map((f) => [f.path, f.content]));
    const written: ProjectFile[] = [];
    for (const f of Array.isArray(req.files) ? req.files : []) {
      const path = cleanProjectPath(f?.path);
      if (!path) throw new CommitError(`not allowed as a file: ${String(f?.path).slice(0, 80)}`);
      if (typeof f.content !== 'string') throw new CommitError(`${path} has no content`);
      if (f.content.length > MAX_FILE_CHARS) throw new CommitError(`${path} is too long (max ${MAX_FILE_CHARS} characters)`);
      if (current.get(path) !== f.content) written.push({ path, content: f.content });
    }
    const deleted = (Array.isArray(req.deleted) ? req.deleted : [])
      .map(cleanProjectPath)
      .filter((p): p is string => !!p && current.has(p) && !written.some((w) => w.path === p));
    const after = new Map(current);
    for (const w of written) after.set(w.path, w.content);
    for (const d of deleted) after.delete(d);
    if (written.length === 0 && deleted.length === 0) throw new CommitError('nothing changed');
    if (after.size > MAX_PROJECT_FILES) throw new CommitError(`at most ${MAX_PROJECT_FILES} files per project`);
    const total = [...after.values()].reduce((sum, c) => sum + c.length, 0);
    if (total > MAX_PROJECT_CHARS) throw new CommitError(`the project would be too big (max ${MAX_PROJECT_CHARS} characters)`);

    const root = this.folder(slug!);
    for (const w of written) {
      mkdirSync(dirname(join(root, w.path)), { recursive: true });
      writeFileSync(join(root, w.path), w.content);
    }
    for (const d of deleted) rmSync(join(root, d), { force: true });
    mkdirSync(root, { recursive: true });

    let sha: string | undefined;
    if (this.git) {
      try {
        await this.git.ensureRepo(slug!, meta.description);
        sha = await this.git.commit(
          slug!,
          [...written.map((w) => ({ path: w.path, content: w.content })), ...deleted.map((path) => ({ path, content: null }))],
          message,
        );
      } catch (err) {
        console.warn(`[sim] Git server: ${(err as Error).message} (kept the change locally)`);
      }
    }
    meta.commits = [{ message, simTime, ...(sha ? { sha } : {}) }, ...meta.commits].slice(0, MAX_KEPT_COMMITS);
    meta.problems = checkProject([...after].map(([path, content]) => ({ path, content })));
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.metaFile(slug!), `${JSON.stringify(meta, null, 2)}\n`);
    return { project: this.project(slug!)!, message, written: written.map((w) => w.path), deleted, sha, problems: meta.problems };
  }
}
