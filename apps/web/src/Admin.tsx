import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AdminLetter, AdminOverview, Artwork } from '@ampli-world/shared';

const TOKEN_KEY = 'aw_admin';
const VIEWS = ['held', 'reported', 'recent', 'art'] as const;
type View = (typeof VIEWS)[number];

function readToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeToken(token: string): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Without storage the token just lives in memory for this tab.
  }
}

class Unauthorized extends Error {}

async function adminFetch<T>(token: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': token },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 401 || res.status === 403) throw new Unauthorized((await res.json().catch(() => ({}))).error);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/** Images behind the admin token: fetched with the header, shown via an object URL. */
function AdminImage({ token, path, alt, className }: { token: string; path: string; alt: string; className: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    fetch(path, { headers: { 'x-admin-token': token } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (!blob) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => {});
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [token, path]);
  return src ? <img className={className} src={src} alt={alt} /> : null;
}

function ArtRow({
  art,
  token,
  onAction,
}: {
  art: Artwork & { note?: string };
  token: string;
  onAction: (id: number, action: 'approve' | 'hide') => void;
}) {
  return (
    <li className="letter">
      <div className="letter-head">
        <strong>#{art.id} {art.title}</strong>
        <span className={`badge status-${art.status === 'shown' ? 'replied' : 'held'}`}>{art.status}</span>
        <span className="hint">{new Date(art.createdAt).toLocaleString()}</span>
      </div>
      <AdminImage className="admin-art" token={token} path={`/api/admin/art/${art.id}.svg`} alt={art.title} />
      <p className="letter-text">{art.caption}</p>
      {art.note && <p className="hint">Note: {art.note}</p>}
      <div className="admin-actions">
        {art.status !== 'shown' && (
          <button type="button" onClick={() => onAction(art.id, 'approve')}>
            Show in gallery
          </button>
        )}
        {art.status !== 'hidden' && (
          <button type="button" className="danger" onClick={() => onAction(art.id, 'hide')}>
            Hide
          </button>
        )}
      </div>
    </li>
  );
}

function LetterRow({
  letter,
  token,
  onAction,
}: {
  letter: AdminLetter;
  token: string;
  onAction: (id: number, action: 'approve' | 'hide') => void;
}) {
  const unpublished = letter.status === 'held' || letter.status === 'hidden';
  return (
    <li className="letter">
      <div className="letter-head">
        <strong>#{letter.id} {letter.name}</strong>
        <span className="badge">{letter.visibility}</span>
        <span className={`badge status-${letter.status}`}>{letter.status}</span>
        {letter.reports > 0 && <span className="badge status-held">{letter.reports} reports</span>}
        <span className="hint">{new Date(letter.createdAt).toLocaleString()}</span>
      </div>
      {letter.text && <p className="letter-text">{letter.text}</p>}
      {letter.hasDoodle && (
        <AdminImage className="doodle" token={token} path={`/api/admin/letters/${letter.id}/doodle`} alt="Doodle" />
      )}
      {letter.draftReply && (
        <p className="letter-reply">
          <strong>{unpublished ? 'Reply (not published):' : 'Reply:'}</strong> {letter.draftReply}
        </p>
      )}
      {letter.note && <p className="hint">Note: {letter.note}</p>}
      <div className="admin-actions">
        {(unpublished || letter.reports > 0) && (
          <button type="button" onClick={() => onAction(letter.id, 'approve')}>
            {unpublished ? (letter.draftReply ? 'Approve & publish' : 'Approve to post box') : 'Dismiss reports'}
          </button>
        )}
        {letter.status !== 'hidden' && (
          <button type="button" className="danger" onClick={() => onAction(letter.id, 'hide')}>
            Hide
          </button>
        )}
      </div>
    </li>
  );
}

export function Admin() {
  const [token, setToken] = useState(readToken);
  const [draft, setDraft] = useState('');
  const [view, setView] = useState<View>('held');
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [letters, setLetters] = useState<AdminLetter[]>([]);
  const [art, setArt] = useState<(Artwork & { note?: string })[]>([]);
  const [error, setError] = useState<string | null>(null);

  const fail = useCallback((err: unknown) => {
    if (err instanceof Unauthorized) {
      storeToken('');
      setToken('');
    }
    setError((err as Error).message || 'Something went wrong.');
  }, []);

  const refresh = useCallback(() => {
    if (!token) return;
    setError(null);
    adminFetch<AdminOverview>(token, '/api/admin/overview').then(setOverview).catch(fail);
    if (view === 'art') adminFetch<Artwork[]>(token, '/api/admin/art?view=recent').then(setArt).catch(fail);
    else adminFetch<AdminLetter[]>(token, `/api/admin/letters?view=${view}`).then(setLetters).catch(fail);
  }, [token, view, fail]);

  useEffect(refresh, [refresh]);

  function login(e: FormEvent) {
    e.preventDefault();
    storeToken(draft);
    setToken(draft);
    setDraft('');
  }

  async function act(id: number, action: 'approve' | 'hide') {
    await adminFetch(token, `/api/admin/letters/${id}/${action}`, {}).catch(fail);
    refresh();
  }

  async function actOnArt(id: number, action: 'approve' | 'hide') {
    await adminFetch(token, `/api/admin/art/${id}/${action}`, {}).catch(fail);
    refresh();
  }

  async function togglePause() {
    if (!overview) return;
    await adminFetch(token, '/api/admin/mailbox', { paused: !overview.paused }).catch(fail);
    refresh();
  }

  if (!token) {
    return (
      <div className="app admin">
        <form className="card letter-form admin-login" onSubmit={login}>
          <h3>Ampli World admin</h3>
          <label>
            Admin token
            <input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" required />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button type="submit">Open</button>
        </form>
      </div>
    );
  }

  return (
    <div className="app admin">
      <header className="topbar">
        <div>
          <h1>Ampli World admin</h1>
          <p className="subtitle">
            <a href="/">← back to town</a>
          </p>
        </div>
        <button
          type="button"
          className="link"
          onClick={() => {
            storeToken('');
            setToken('');
          }}
        >
          Log out
        </button>
      </header>

      {overview && (
        <section className="card admin-overview">
          <div>
            <strong>Mailbox:</strong> {overview.paused ? 'paused (closed for new letters, Ampli stops answering)' : 'open'}{' '}
            <button type="button" className={overview.paused ? '' : 'danger'} onClick={togglePause}>
              {overview.paused ? 'Reopen mailbox' : 'Pause mailbox'}
            </button>
          </div>
          <p className="hint">
            {overview.counts.held} held · {overview.reported} reported · {overview.counts.checking} being checked ·{' '}
            {overview.counts.waiting} in the post box · {overview.counts.replied} replied · {overview.counts.hidden} hidden
            · today: {overview.usageToday.calls} model calls, ${overview.usageToday.costUsd.toFixed(3)}
          </p>
        </section>
      )}

      <nav className="tabs admin-tabs" role="tablist">
        {VIEWS.map((v) => (
          <button
            key={v}
            role="tab"
            aria-selected={view === v}
            className={view === v ? 'tab tab-active' : 'tab'}
            onClick={() => setView(v)}
          >
            {v === 'held' ? 'Held for review' : v === 'reported' ? 'Reported' : v === 'recent' ? 'All recent' : 'Art'}
          </button>
        ))}
      </nav>

      {error && <p className="form-error">{error}</p>}
      <section className="card">
        {view === 'art' ? (
          art.length === 0 ? (
            <p className="empty">No artworks yet.</p>
          ) : (
            <ul className="letters">
              {art.map((a) => (
                <ArtRow key={a.id} art={a} token={token} onAction={actOnArt} />
              ))}
            </ul>
          )
        ) : letters.length === 0 ? (
          <p className="empty">Nothing here.</p>
        ) : (
          <ul className="letters">
            {letters.map((l) => (
              <LetterRow key={l.id} letter={l} token={token} onAction={act} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
