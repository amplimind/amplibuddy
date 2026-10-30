import { useEffect, useState } from 'react';
import { formatClock, type CodeProject } from '@ampli-world/shared';

// The Code Lab's websites: what each is, what changed lately, and links to open it (in its
// sandbox) and to its repository on the local Git server.

export function CodeTab({ name, codeVersion }: { name: string; codeVersion: number }) {
  const [projects, setProjects] = useState<CodeProject[] | null>(null);

  useEffect(() => {
    fetch('/api/projects')
      .then((r) => (r.ok ? (r.json() as Promise<CodeProject[]>) : []))
      .then(setProjects)
      .catch(() => setProjects([]));
  }, [codeVersion]);

  if (!projects) return <p className="hint">Loading…</p>;
  if (projects.length === 0) {
    return (
      <p className="empty">
        {name} hasn't built a website yet. It happens at the Code Lab, the building with the green roof, when the mood
        strikes.
      </p>
    );
  }
  return (
    <div className="projects">
      <p className="hint">
        Websites {name} wrote itself, in HTML, CSS and JavaScript. They run in a sandbox: no network, no access to anything
        else.
      </p>
      {projects.map((p) => (
        <article key={p.slug} className="project">
          <header>
            <strong>{p.name}</strong>
            <span className="hint">
              {p.files.length} {p.files.length === 1 ? 'file' : 'files'} · {p.commits.length}{' '}
              {p.commits.length === 1 ? 'commit' : 'commits'}
            </span>
          </header>
          {p.description && <p>{p.description}</p>}
          <div className="row">
            <a className="chip chip-link" href={p.siteUrl} target="_blank" rel="noopener noreferrer">
              Open the site ↗
            </a>
            {p.repoUrl && (
              <a className="chip chip-link" href={p.repoUrl} target="_blank" rel="noopener noreferrer">
                Code ↗
              </a>
            )}
          </div>
          <ol className="commits">
            {p.commits.slice(0, 4).map((c, i) => (
              <li key={`${c.simTime}-${i}`}>
                <span className="feed-time">{formatClock(c.simTime)}</span> {c.message}
                {c.sha && <code className="sha">{c.sha.slice(0, 7)}</code>}
              </li>
            ))}
          </ol>
        </article>
      ))}
    </div>
  );
}
