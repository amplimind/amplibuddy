import { useEffect, useRef, useState } from 'react';
import {
  MAX_BOOK_BLURB_CHARS,
  MAX_BOOK_CHARS,
  MAX_BOOK_TITLE_CHARS,
  MAX_PDF_BYTES,
  type LibraryBook,
  type LibraryBookDraft,
  type PdfExtract,
} from '@ampli-world/shared';

// The library editor in ⚙️: write a text, upload a PDF, edit or remove books. Changes
// take effect at once; long texts are read one part per visit.

const SOURCE_LABEL: Record<LibraryBook['source'], string> = { builtin: 'came with the town', text: 'written here', pdf: 'from a PDF' };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

function visits(parts: number): string {
  return parts > 1 ? `read in ${parts} visits` : 'read in one visit';
}

function BookForm({
  draft,
  note,
  onSaved,
  onCancel,
}: {
  draft: LibraryBookDraft;
  note?: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [book, setBook] = useState(draft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await request('/api/setup/library', json('POST', book));
      onSaved();
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="setup-form">
      {note && <p className="hint">{note}</p>}
      <div className="field-row">
        <label className="field">
          <span className="field-label">Title</span>
          <input value={book.title} maxLength={MAX_BOOK_TITLE_CHARS} onChange={(e) => setBook({ ...book, title: e.target.value })} />
        </label>
        <label className="field">
          <span className="field-label">Author</span>
          <input value={book.author} maxLength={MAX_BOOK_TITLE_CHARS} onChange={(e) => setBook({ ...book, author: e.target.value })} />
        </label>
      </div>
      <label className="field">
        <span className="field-label">What it's about</span>
        <input
          value={book.blurb}
          maxLength={MAX_BOOK_BLURB_CHARS}
          placeholder="One sentence"
          onChange={(e) => setBook({ ...book, blurb: e.target.value })}
        />
        <span className="hint">Your character sees this when it chooses what to read.</span>
      </label>
      <label className="field">
        <span className="field-label">Text</span>
        <textarea
          className="book-text"
          value={book.text}
          maxLength={MAX_BOOK_CHARS}
          rows={14}
          placeholder="Write or paste the text here: a story, an article, notes about your team, anything worth reading."
          onChange={(e) => setBook({ ...book, text: e.target.value })}
        />
        <span className="hint">
          {book.text.length.toLocaleString()} characters. Long texts are read in parts, one per visit to the library.
        </span>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button type="button" onClick={() => void save()} disabled={saving || !book.title.trim() || !book.text.trim()}>
          {saving ? 'Saving…' : 'Put it on the shelf'}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function LibraryEditor({ name, onBusy }: { name: string; onBusy: (busy: boolean) => void }) {
  const [books, setBooks] = useState<LibraryBook[] | null>(null);
  const [editing, setEditing] = useState<{ draft: LibraryBookDraft; note?: string } | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = () =>
    request<LibraryBook[]>('/api/setup/library')
      .then(setBooks)
      .catch((err: Error) => setError(err.message));
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    onBusy(editing !== null || reading !== null);
    return () => onBusy(false);
  }, [editing, reading, onBusy]);

  async function edit(id: string) {
    setError(null);
    try {
      setEditing({ draft: await request<LibraryBookDraft>(`/api/setup/library/${encodeURIComponent(id)}`) });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await request(`/api/setup/library/${encodeURIComponent(id)}`, json('DELETE'));
      setRemoving(null);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function upload(file: File) {
    setError(null);
    if (file.size > MAX_PDF_BYTES) {
      setError(`That PDF is too big: up to ${MAX_PDF_BYTES / 1024 / 1024} MB.`);
      return;
    }
    setReading(file.name);
    try {
      const extract = await request<PdfExtract>('/api/setup/library/pdf', {
        method: 'POST',
        headers: { 'content-type': 'application/pdf', 'x-file-name': encodeURIComponent(file.name) },
        body: file,
      });
      setEditing({
        draft: { title: extract.title, author: extract.author, blurb: '', text: extract.text, source: 'pdf' },
        note: `Read ${extract.pages} pages from ${file.name}. Check the title, add a sentence about what it is, and put it on the shelf.`,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReading(null);
    }
  }

  if (editing) {
    return (
      <BookForm
        draft={editing.draft}
        note={editing.note}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    );
  }

  return (
    <div className="setup-form">
      <p className="hint">
        What {name} can read in the library. Add your own texts or PDFs (with real text, not scanned pages). Long ones
        are read in parts, one per visit, and {name} remembers what the earlier parts said. Changes count at once.
      </p>
      <div className="row">
        <button type="button" onClick={() => setEditing({ draft: { title: '', author: '', blurb: '', text: '', source: 'text' } })}>
          + Write a text
        </button>
        <button type="button" className="secondary" onClick={() => fileInput.current?.click()} disabled={reading !== null}>
          {reading ? `Reading ${reading}…` : '⬆ Upload a PDF'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void upload(file);
          }}
        />
      </div>
      {error && <p className="error">{error}</p>}
      {!books && !error && <p className="hint">Loading…</p>}
      {books && books.length === 0 && <p className="empty">The shelves are empty.</p>}
      {books && books.length > 0 && (
        <ul className="book-list">
          {books.map((b) => (
            <li key={b.id}>
              <span className="book-spine" aria-hidden>
                📖
              </span>
              <div>
                <span>
                  <strong>{b.title}</strong> by {b.author}
                </span>
                {b.blurb && <span className="hint">{b.blurb}</span>}
                <span className="hint">
                  {SOURCE_LABEL[b.source]} · {b.chars.toLocaleString()} characters · {visits(b.parts)}
                </span>
              </div>
              {removing === b.id ? (
                <>
                  <button type="button" className="secondary remove" onClick={() => void remove(b.id)}>
                    Remove
                  </button>
                  <button type="button" className="secondary" onClick={() => setRemoving(null)}>
                    Keep
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="secondary" onClick={() => void edit(b.id)}>
                    Edit
                  </button>
                  <button type="button" className="secondary remove" onClick={() => setRemoving(b.id)} aria-label={`Remove ${b.title}`}>
                    Remove
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
