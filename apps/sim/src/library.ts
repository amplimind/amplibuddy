import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseFrontmatter, type Book, type BookWithText } from '@ampli-world/shared';

/** Books are markdown files with title/author/blurb frontmatter. The file name is the id. */
export function loadLibrary(dir: string): Map<string, BookWithText> {
  const books = new Map<string, BookWithText>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const id = basename(file, '.md');
    const { meta, body } = parseFrontmatter(readFileSync(join(dir, file), 'utf8'));
    books.set(id, {
      id,
      title: meta.title ?? id,
      author: meta.author ?? 'unknown',
      blurb: meta.blurb ?? '',
      text: body,
    });
  }
  return books;
}

export function withoutText({ text: _text, ...book }: BookWithText): Book {
  return book;
}
