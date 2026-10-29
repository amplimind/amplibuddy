import type { LlmMeta } from './types.ts';

// Ampli's art studio: artworks are small SVGs written by the model.

export const ART_VIEWBOX = { width: 400, height: 300 };
export const MAX_SVG_CHARS = 20_000;
export const MAX_ART_TITLE_CHARS = 80;

/** shown: in the gallery. held: the check said no, waits for an admin. hidden: taken down. */
export type ArtStatus = 'shown' | 'held' | 'hidden';

/** An artwork without its SVG (served from /api/art/:id.svg). */
export interface Artwork {
  id: number;
  title: string;
  caption: string;
  createdAt: string;
  simTime: number;
  status: ArtStatus;
  llm?: LlmMeta;
}

export interface ArtworkRequest {
  title: string;
  caption: string;
  svg: string;
  /** The check said no: store it for an admin, don't show it. */
  held?: boolean;
  note?: string;
  llm?: LlmMeta[];
}

/** Bumped when served SVGs change (e.g. a repair), so browsers fetch them again. */
export const ART_VERSION = 2;

const escapeAmpersands = (svg: string) => svg.replace(/&(?!(?:#\d+|#x[\da-f]+|[a-z]\w*);)/gi, '&amp;');

/**
 * Fixes what models most often get wrong: anything after the </svg> that closes the
 * root (e.g. a second </svg>), and bare ampersands in text. Safe to run on stored art.
 */
export function repairSvg(svg: string): string {
  let depth = 0;
  const tags = /<(\/?)svg\b(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/gi;
  for (let m = tags.exec(svg); m; m = tags.exec(svg)) {
    if (m[1]) depth--;
    else if (!m[2]) depth++;
    if (depth === 0) return escapeAmpersands(svg.slice(0, m.index + m[0].length));
  }
  return escapeAmpersands(svg);
}

/**
 * Every element closed, in the right order, with no stray "<" in text: what an <img>
 * needs to render an SVG at all. Not a full XML parser, but it catches what models break.
 */
export function wellFormedSvg(svg: string): boolean {
  const body = svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '');
  const stack: string[] = [];
  const tags = /<(\/?)([a-zA-Z][\w:.-]*)(?:[^>"']|"[^"]*"|'[^']*')*?(\/?)>/g;
  let last = 0;
  for (let m = tags.exec(body); m; m = tags.exec(body)) {
    if (body.slice(last, m.index).includes('<')) return false;
    last = m.index + m[0].length;
    const [, close, name, self] = m;
    if (close) {
      if (stack.pop() !== name) return false;
    } else if (!self) {
      stack.push(name!);
    }
  }
  return stack.length === 0 && !body.slice(last).includes('<');
}

/**
 * Accepts only a self-contained, well-formed SVG: no scripts, event handlers, foreign
 * content or external references. Repairs the usual model slips (see repairSvg), rejects
 * the rest. Adds the SVG namespace if missing (needed for <img> rendering). Returns null
 * when unusable.
 */
export function cleanSvg(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let svg = value.trim();
  const fenced = /^```(?:svg|xml)?\s*([\s\S]*?)\s*```$/i.exec(svg);
  if (fenced) svg = fenced[1]!.trim();
  svg = repairSvg(svg);
  if (svg.length > MAX_SVG_CHARS || !/^<svg[\s>]/i.test(svg) || !/<\/svg>$/i.test(svg)) return null;
  if (!wellFormedSvg(svg)) return null;
  const forbidden =
    /<\s*(script|foreignObject|iframe|object|embed|image|use|a|animate|set)\b|\bon[a-z]+\s*=|javascript:|(?:xlink:)?href\s*=|url\(\s*['"]?(?!#)|@import|<!ENTITY|<!DOCTYPE/i;
  if (forbidden.test(svg)) return null;
  if (!/xmlns\s*=/.test(svg.slice(0, svg.indexOf('>')))) svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
}
