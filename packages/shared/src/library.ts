// The library: books are plain text (written in the app, uploaded as PDF, or shipped with
// the repo). Long ones are read in parts, one part per visit, so any book fits a model's
// context, even a local one.

/** About 6k tokens: room for the part, the notebook and the notes on earlier parts in 16k. */
export const READING_PART_CHARS = 24_000;
export const MAX_BOOK_CHARS = 2_000_000;
export const MAX_PDF_BYTES = 30 * 1024 * 1024;
export const MAX_BOOK_TITLE_CHARS = 120;
export const MAX_BOOK_BLURB_CHARS = 300;

/**
 * Splits a text into parts of at most `size` characters, at paragraph breaks where
 * possible, then at sentence ends, and only as a last resort mid-sentence.
 */
export function splitIntoParts(text: string, size = READING_PART_CHARS): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const cut = [window.lastIndexOf('\n\n'), Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n')), window.lastIndexOf(' ')].find(
      (i) => i > size * 0.5,
    );
    const end = cut === undefined ? size : cut + 1;
    parts.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) parts.push(rest);
  return parts.length > 0 ? parts : [''];
}

/** Text from a PDF, tidied: page breaks become paragraphs, hyphenated line breaks are joined. */
export function tidyExtractedText(pages: string[]): string {
  return pages
    .map((page) =>
      page
        .replace(/\r\n?/g, '\n')
        .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim(),
    )
    .filter(Boolean)
    .join('\n\n');
}

/** A book as the library editor sees it. */
export interface LibraryBook {
  id: string;
  title: string;
  author: string;
  blurb: string;
  /** Shipped with the town, written in the app, or from a PDF. */
  source: 'builtin' | 'text' | 'pdf';
  chars: number;
  parts: number;
}

export interface LibraryBookDraft {
  /** Absent for a new book. */
  id?: string;
  title: string;
  author: string;
  blurb: string;
  text: string;
  source?: 'text' | 'pdf';
}

/** What came out of an uploaded PDF, to check and complete before it goes on the shelf. */
export interface PdfExtract {
  title: string;
  author: string;
  text: string;
  pages: number;
}

/**
 * Where reading a book continues, from its latest readings (newest first): the part after
 * the last one, with the notes on the parts read so far in this pass (up to three, oldest
 * first). After the last part, or if the book changed length, it starts over.
 */
export function readingProgress(
  readings: { part?: number; parts?: number; takeaway: string }[],
  parts: number,
): { next: number; earlier: string[] } {
  const last = readings[0];
  if (!last?.part || last.parts !== parts || last.part >= parts) return { next: 1, earlier: [] };
  const earlier: string[] = [];
  for (let i = 0, expect = last.part; i < readings.length && earlier.length < 3; i++, expect--) {
    const r = readings[i]!;
    if (r.part !== expect || r.parts !== parts) break;
    earlier.unshift(r.takeaway);
  }
  return { next: last.part + 1, earlier };
}
