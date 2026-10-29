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

/**
 * Accepts only a self-contained SVG: no scripts, event handlers, foreign content
 * or external references. Rejects rather than repairs. Adds the SVG namespace if
 * missing (needed for <img> rendering). Returns null when unusable.
 */
export function cleanSvg(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let svg = value.trim();
  const fenced = /^```(?:svg|xml)?\s*([\s\S]*?)\s*```$/i.exec(svg);
  if (fenced) svg = fenced[1]!.trim();
  if (svg.length > MAX_SVG_CHARS || !/^<svg[\s>]/i.test(svg) || !/<\/svg>$/i.test(svg)) return null;
  const forbidden =
    /<\s*(script|foreignObject|iframe|object|embed|image|use|a|animate|set)\b|\bon[a-z]+\s*=|javascript:|(?:xlink:)?href\s*=|url\(\s*['"]?(?!#)|@import|<!ENTITY|<!DOCTYPE/i;
  if (forbidden.test(svg)) return null;
  if (!/xmlns\s*=/.test(svg.slice(0, svg.indexOf('>')))) svg = svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return svg;
}
