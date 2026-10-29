import { useState, type FormEvent } from 'react';
import { MAX_LETTER_CHARS, MAX_NAME_CHARS, type WorldSnapshot } from '@ampli-world/shared';
import { readName, saveName } from './Mailbox.tsx';

/**
 * Ampli's open question, right above the tabs, with a reply box. The answer is an
 * ordinary letter linked to the question, so it goes through the same checks.
 */
export function AskCard({ snapshot }: { snapshot: WorldSnapshot }) {
  const question = snapshot.openQuestion;
  const author = snapshot.persona.name;
  const [name, setName] = useState(readName);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentFor, setSentFor] = useState<number | null>(null);

  if (sentFor !== null && question?.id !== sentFor) {
    // The question is answered (or replaced); show a short thank-you until the next one.
    return question ? null : <p className="ask-card ask-thanks">Thanks! {author} will read your answer soon.</p>;
  }
  if (!question) return null;

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!question) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/mail', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, text, private: false, inReplyTo: question.id }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'The answer could not be sent.');
      saveName(name.trim());
      setText('');
      setSentFor(question.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <form className="ask-card" onSubmit={send}>
      <span className="feed-kicker">❓ {author} asks you</span>
      <p className="ask-question">“{question.text}”</p>
      {!readName() && (
        <input
          value={name}
          maxLength={MAX_NAME_CHARS}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name"
          aria-label="Your name"
          required
        />
      )}
      <textarea
        value={text}
        maxLength={MAX_LETTER_CHARS}
        rows={2}
        onChange={(e) => setText(e.target.value)}
        placeholder={`Answer ${author}…`}
        aria-label={`Answer ${author}`}
        required
      />
      {error && <p className="form-error">{error}</p>}
      <button type="submit" disabled={sending || !name.trim() || !text.trim()}>
        {sending ? 'Sending…' : 'Answer'}
      </button>
    </form>
  );
}
