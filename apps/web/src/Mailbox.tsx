import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DoodlePad } from './DoodlePad.tsx';
import {
  MAIL_OVERDUE_MINUTES,
  MAX_LETTER_CHARS,
  MAX_NAME_CHARS,
  VISITOR_RETENTION_DAYS,
  isNight,
  type Letter,
  type LetterStatus,
  type VisitorProfile,
  type WorldSnapshot,
} from '@ampli-world/shared';

const STATUS_LABEL: Record<LetterStatus, string> = {
  checking: 'Being checked…',
  held: 'Waiting for a human to review it',
  waiting: 'In the post box',
  replied: 'Replied',
  skipped: 'Read',
  hidden: 'Not published',
};

const NAME_KEY = 'aw_name';

function readName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    // Remembering the name is a convenience only.
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return (await res.json()) as T;
}

/** "usually within about 30 minutes", derived from the overdue rule and the sim speed. */
function expectedWait(snapshot: WorldSnapshot): string {
  const { agent, simTime, persona } = snapshot;
  if (agent.activity?.kind === 'sleep' || isNight(simTime)) {
    return `${persona.name} is asleep right now 💤 and will read your letter in the morning.`;
  }
  const minutes = Math.round(MAIL_OVERDUE_MINUTES / snapshot.minutesPerSecond / 60);
  const span = minutes <= 1 ? 'a minute or so' : `about ${minutes} minutes`;
  return `${persona.name} reads mail at the post box in its own time, usually within ${span}.`;
}

function ReportButton({ id }: { id: number }) {
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  if (state === 'done') return <span className="hint">Thanks, reported.</span>;
  return (
    <button
      type="button"
      className="link report"
      disabled={state === 'sending'}
      onClick={async () => {
        setState('sending');
        await fetch(`/api/mail/${id}/report`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }).catch(() => null);
        setState('done');
      }}
    >
      Report
    </button>
  );
}

function LetterCard({ letter, author, showStatus }: { letter: Letter; author: string; showStatus: boolean }) {
  return (
    <li className="letter">
      <div className="letter-head">
        <strong>{letter.name}</strong>
        {letter.visibility === 'private' && <span className="badge">private</span>}
        {showStatus && <span className={`badge status-${letter.status}`}>{STATUS_LABEL[letter.status]}</span>}
      </div>
      {letter.text && <p className="letter-text">{letter.text}</p>}
      {letter.hasDoodle && (
        <img
          className="doodle"
          src={`/api/mail/${letter.id}/doodle`}
          alt={letter.doodleCaption ? `Doodle: ${letter.doodleCaption}` : 'A doodle'}
          loading="lazy"
        />
      )}
      {letter.reply && (
        <p className="letter-reply">
          <strong>{author}:</strong> {letter.reply}
        </p>
      )}
      {!showStatus && letter.status === 'skipped' && <p className="hint">{author} read this.</p>}
      {!showStatus && <ReportButton id={letter.id} />}
    </li>
  );
}

function Memory({ me, author, onForget }: { me: VisitorProfile; author: string; onForget: () => Promise<void> }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const nothing = !me.memory.public && !me.memory.private;
  return (
    <section className="memory">
      <h3>What {author} remembers about you</h3>
      {nothing ? (
        <p className="hint">Nothing yet. {author} writes a note about you after reading your letters.</p>
      ) : (
        <>
          {me.memory.public && <p className="memory-note">{me.memory.public}</p>}
          {me.memory.private && (
            <p className="memory-note">
              <span className="badge">from private letters, only you see this</span> {me.memory.private}
            </p>
          )}
        </>
      )}
      {confirming ? (
        <div className="forget-confirm">
          <p>
            Delete all your letters, {author}’s replies and notes about you, and replace your name with “a visitor” in
            the diary and feed? This can’t be undone.
          </p>
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onForget();
              setBusy(false);
              setConfirming(false);
            }}
          >
            {busy ? 'Forgetting…' : 'Yes, forget me'}
          </button>
          <button type="button" className="link" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="link" onClick={() => setConfirming(true)}>
          Forget me
        </button>
      )}
    </section>
  );
}

export function Mailbox({ snapshot, mailVersion }: { snapshot: WorldSnapshot | null; mailVersion: number }) {
  const [name, setName] = useState(readName);
  const [text, setText] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [doodle, setDoodle] = useState<string | null>(null);
  /** Bumped to remount (and so clear) the doodle pad after sending. */
  const [padKey, setPadKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mine, setMine] = useState<Letter[]>([]);
  const [board, setBoard] = useState<Letter[]>([]);
  const [me, setMe] = useState<VisitorProfile | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const author = snapshot?.persona.name ?? 'Ampli';

  const refresh = useCallback(() => {
    getJson<Letter[]>('/api/mail/mine').then(setMine).catch(() => {});
    getJson<Letter[]>('/api/board').then(setBoard).catch(() => {});
    getJson<VisitorProfile | null>('/api/me').then(setMe).catch(() => {});
    getJson<{ open: boolean }>('/api/mail/status')
      .then((s) => setOpen(s.open))
      .catch(() => {});
  }, []);

  async function forget() {
    const res = await fetch('/api/forget-me', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => null);
    if (res?.ok) {
      const { letters } = (await res.json()) as { letters: number };
      setNotice(`Done. ${author} has forgotten you (${letters} letter${letters === 1 ? '' : 's'} deleted).`);
    } else {
      setNotice('That didn’t work. Please try again.');
    }
    refresh();
  }

  useEffect(refresh, [refresh, mailVersion]);

  // Status changes (checked, held) don't produce public events, so poll while a letter is on its way.
  const pending = mine.some((l) => l.status === 'checking' || l.status === 'waiting');
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(refresh, 10_000);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  async function send(e: FormEvent) {
    e.preventDefault();
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/mail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, text, private: isPrivate, ...(doodle ? { doodle } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'The letter could not be sent.');
      saveName(name.trim());
      setText('');
      setDoodle(null);
      setDrawing(false);
      setPadKey((k) => k + 1);
      setPrivate(false);
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mailbox">
      <form className="letter-form" onSubmit={send}>
        <h3>Write to {author}</h3>
        {!open ? (
          <p className="form-error">The post box is closed for now. Please try again later.</p>
        ) : (
          snapshot && <p className="hint">{expectedWait(snapshot)}</p>
        )}
        <label>
          Your name
          <input value={name} maxLength={MAX_NAME_CHARS} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          Your letter
          <textarea
            value={text}
            maxLength={MAX_LETTER_CHARS}
            rows={4}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Ask ${author} something, tell it about your day, recommend a book…`}
            required={!doodle}
          />
          <span className="counter">
            {text.length}/{MAX_LETTER_CHARS}
          </span>
        </label>
        {drawing ? (
          <DoodlePad key={padKey} onChange={setDoodle} />
        ) : (
          <button type="button" className="link" onClick={() => setDrawing(true)}>
            ✏️ Add a doodle
          </button>
        )}
        <label className="checkbox">
          <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} />
          Private: only you will see {author}’s reply
        </label>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" disabled={!open || sending || !name.trim() || (!text.trim() && !doodle)}>
          {sending ? 'Sending…' : 'Put it in the post box'}
        </button>
        <p className="fineprint">
          Your name and letter are stored so {author} can reply. Public letters and replies are visible to everyone here
          and may show up in {author}’s diary. Private letters stay out of the diary and the feed, but admins can read
          them for moderation. Every letter is checked by an AI model before it reaches the post box. Your letters are
          linked to this browser. “Forget me” deletes all of it, and everything is deleted automatically{' '}
          {VISITOR_RETENTION_DAYS} days after your last visit.
        </p>
      </form>

      {notice && <p className="hint">{notice}</p>}
      {me && <Memory me={me} author={author} onForget={forget} />}

      {mine.length > 0 && (
        <section>
          <h3>Your letters</h3>
          <ul className="letters">
            {mine.map((l) => (
              <LetterCard key={l.id} letter={l} author={author} showStatus />
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3>Notice board</h3>
        {board.length === 0 ? (
          <p className="empty">No public letters yet. Be the first!</p>
        ) : (
          <ul className="letters">
            {board.map((l) => (
              <LetterCard key={l.id} letter={l} author={author} showStatus={false} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
