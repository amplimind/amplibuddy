import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  MAX_BOOK_BLURB_CHARS,
  MAX_BOOK_CHARS,
  MAX_BOOK_TITLE_CHARS,
  parseFrontmatter,
  splitIntoParts,
  tidyExtractedText,
  type Book,
  type BookWithText,
  type LibraryBook,
  type LibraryBookDraft,
  type PdfExtract,
} from '@ampli-world/shared';
import { USER_LIBRARY_DIR, WORLD_LIBRARY_DIR, writeText } from '@ampli-world/shared/node';

export interface ShelfBook extends BookWithText {
  source: LibraryBook['source'];
}

/** Books are markdown files with title/author/blurb frontmatter. The file name is the id. */
export function loadLibrary(dir: string): Map<string, ShelfBook> {
  const books = new Map<string, ShelfBook>();
  if (!existsSync(dir)) return books;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const id = basename(file, '.md');
    const { meta, body } = parseFrontmatter(readFileSync(join(dir, file), 'utf8'));
    books.set(id, {
      id,
      title: meta.title ?? id,
      author: meta.author ?? 'unknown',
      blurb: meta.blurb ?? '',
      text: body,
      parts: splitIntoParts(body).length,
      source: meta.source === 'pdf' || meta.source === 'text' ? meta.source : 'builtin',
    });
  }
  return books;
}

export function withoutText({ text: _text, source: _source, ...book }: BookWithText & { source?: unknown }): Book {
  return book;
}

export function libraryEntry(book: ShelfBook): LibraryBook {
  return {
    id: book.id,
    title: book.title,
    author: book.author,
    blurb: book.blurb,
    source: book.source,
    chars: book.text.length,
    parts: book.parts,
  };
}

/** One line, no frontmatter breakers. */
function line(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').replace(/---/g, '-').trim().slice(0, max) : '';
}

function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/[\s_]+/g, '-')
      .slice(0, 40) || 'book'
  );
}

/** Editing starts from a copy of the shipped books, so removing one of them works too. */
function ensureOwnLibrary(): void {
  if (existsSync(USER_LIBRARY_DIR)) return;
  mkdirSync(USER_LIBRARY_DIR, { recursive: true });
  if (!existsSync(WORLD_LIBRARY_DIR)) return;
  for (const file of readdirSync(WORLD_LIBRARY_DIR).filter((f) => f.endsWith('.md'))) {
    copyFileSync(join(WORLD_LIBRARY_DIR, file), join(USER_LIBRARY_DIR, file));
  }
}

/**
 * Puts a book on the shelf (new or changed) in your own library and in the running
 * town at once. Returns null when it has no title or no text.
 */
export function saveBook(draft: LibraryBookDraft, books: Map<string, ShelfBook>): ShelfBook | null {
  const title = line(draft.title, MAX_BOOK_TITLE_CHARS);
  const text = typeof draft.text === 'string' ? draft.text.replace(/\r\n?/g, '\n').trim().slice(0, MAX_BOOK_CHARS) : '';
  if (!title || !text) return null;
  ensureOwnLibrary();
  const existing = draft.id && /^[\w-]{1,60}$/.test(draft.id) ? books.get(draft.id) : undefined;
  let id = existing?.id ?? slug(title);
  if (!existing) for (let n = 2; books.has(id) || existsSync(join(USER_LIBRARY_DIR, `${id}.md`)); n++) id = `${slug(title)}-${n}`;
  const book: ShelfBook = {
    id,
    title,
    author: line(draft.author, MAX_BOOK_TITLE_CHARS) || 'unknown',
    blurb: line(draft.blurb, MAX_BOOK_BLURB_CHARS),
    text,
    parts: splitIntoParts(text).length,
    source: existing?.source ?? (draft.source === 'pdf' ? 'pdf' : 'text'),
  };
  const source = book.source === 'builtin' ? '' : `source: ${book.source}\n`;
  writeText(
    join(USER_LIBRARY_DIR, `${id}.md`),
    `---\ntitle: ${book.title}\nauthor: ${book.author}\nblurb: ${book.blurb}\n${source}---\n${text}\n`,
  );
  books.set(id, book);
  return book;
}

export function deleteBook(id: string, books: Map<string, ShelfBook>): boolean {
  if (!books.has(id)) return false;
  ensureOwnLibrary();
  const file = join(USER_LIBRARY_DIR, `${id}.md`);
  if (existsSync(file)) unlinkSync(file);
  books.delete(id);
  return true;
}

export class PdfSupportMissing extends Error {}

/**
 * The text of a PDF, page by page, plus its title and author if it names them. Text only:
 * no fonts loaded, nothing rendered, and this pdf.js has no code-evaluation path left (the
 * one behind CVE-2024-4367 is gone), so an uploaded file stays data.
 */
export async function extractPdf(bytes: Uint8Array, fileName: string): Promise<PdfExtract> {
  // Loaded on demand: pdf.js is big, and the town runs fine without it.
  let unpdf: typeof import('unpdf');
  try {
    unpdf = await import('unpdf');
  } catch {
    throw new PdfSupportMissing('PDF support is not installed yet: run `npm install` in the Ampli World folder.');
  }
  const pdf = await unpdf.getDocumentProxy(bytes, { disableFontFace: true });
  const { totalPages, text } = await unpdf.extractText(pdf, { mergePages: false });
  const info: Record<string, unknown> = (await unpdf.getMeta(pdf).catch(() => ({ info: {} }))).info ?? {};
  const meta = (key: string) => (typeof info[key] === 'string' ? (info[key] as string).trim() : '');
  const fromName = basename(fileName, '.pdf').replace(/[_-]+/g, ' ').trim();
  return {
    title: line(meta('Title'), MAX_BOOK_TITLE_CHARS) || line(fromName, MAX_BOOK_TITLE_CHARS) || 'Untitled',
    author: line(meta('Author'), MAX_BOOK_TITLE_CHARS),
    text: tidyExtractedText(text).slice(0, MAX_BOOK_CHARS),
    pages: totalPages,
  };
}
