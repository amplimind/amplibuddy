import type { LlmMeta, PlaceId, Point } from './types.ts';

// What the character adds to the town: things it builds on the plots, and its paintings
// hung on the frames. Plots and frames are fixed spots (tile coordinates), so whatever it
// makes fits the map; what stands or hangs there is up to the character.

export const BUILD_VIEWBOX = { width: 64, height: 64 };
export const MAX_BUILD_NAME_CHARS = 40;
export const MAX_BUILD_DESCRIPTION_CHARS = 200;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlotDef {
  id: string;
  /** Where the character walks to first; the last steps to the plot are only drawn. */
  place: PlaceId;
  /** "by the pond", for prompts and the feed. */
  where: string;
  /** The object is drawn into this box, standing on its bottom edge. */
  area: Box;
}

export interface FrameDef {
  id: string;
  place: PlaceId;
  where: string;
  /** The picture itself (4:3, like every painting). */
  rect: Box;
  /** Out in the open (always visible) or inside a building (seen when you look in). */
  outdoor: boolean;
}

export const PLOTS: PlotDef[] = [
  { id: 'garden', place: 'home', where: 'in the garden in front of your cottage', area: { x: 7.4, y: 9.3, w: 2, h: 2 } },
  { id: 'meadow-west', place: 'studio', where: 'on the meadow next to the studio', area: { x: 22.4, y: 3.2, w: 2, h: 2 } },
  { id: 'meadow-east', place: 'cafe', where: 'on the meadow next to the café', area: { x: 26.4, y: 4.6, w: 2, h: 2 } },
  { id: 'terrace', place: 'cafe', where: 'between the café and the Code Lab', area: { x: 38, y: 6.6, w: 2, h: 2 } },
  { id: 'lab-yard', place: 'lab', where: 'in the yard behind the Code Lab', area: { x: 51.8, y: 4.4, w: 2, h: 2 } },
  { id: 'plaza-corner', place: 'plaza', where: 'in a corner of the plaza', area: { x: 16.3, y: 13.7, w: 2, h: 2 } },
  { id: 'pond', place: 'park', where: 'by the pond', area: { x: 33.4, y: 15.4, w: 2, h: 2 } },
  { id: 'park-lawn', place: 'park', where: 'on the park lawn', area: { x: 30.4, y: 19.9, w: 2, h: 2 } },
  { id: 'meadow-south', place: 'netcafe', where: 'on the meadow between the internet café and the park', area: { x: 22.6, y: 19.6, w: 2, h: 2 } },
  { id: 'library-garden', place: 'library', where: 'in the garden below the library', area: { x: 5.6, y: 22.6, w: 2, h: 2 } },
  { id: 'south-field', place: 'park', where: 'on the field south of the park', area: { x: 32.4, y: 24, w: 2, h: 2 } },
  { id: 'workshop-yard', place: 'workshop', where: 'next to the workshop', area: { x: 52.2, y: 17.6, w: 2, h: 2 } },
];

export const FRAMES: FrameDef[] = [
  { id: 'plaza-1', place: 'plaza', where: 'on the first easel on the plaza', rect: { x: 16.5, y: 9.35, w: 1.2, h: 0.9 }, outdoor: true },
  { id: 'plaza-2', place: 'plaza', where: 'on the second easel on the plaza', rect: { x: 18.0, y: 9.35, w: 1.2, h: 0.9 }, outdoor: true },
  { id: 'plaza-3', place: 'plaza', where: 'on the third easel on the plaza', rect: { x: 23.4, y: 9.35, w: 1.2, h: 0.9 }, outdoor: true },
  { id: 'home', place: 'home', where: 'on the wall of your cottage', rect: { x: 8.2, y: 3.1, w: 1.0, h: 0.75 }, outdoor: false },
  { id: 'cafe', place: 'cafe', where: 'behind the counter in the café', rect: { x: 33.45, y: 3.05, w: 1.0, h: 0.75 }, outdoor: false },
  { id: 'studio-1', place: 'studio', where: 'on the left of your studio wall', rect: { x: 18.1, y: 2.35, w: 0.8, h: 0.6 }, outdoor: false },
  { id: 'studio-2', place: 'studio', where: 'on the right of your studio wall', rect: { x: 19.4, y: 2.35, w: 0.8, h: 0.6 }, outdoor: false },
];

export const plotById = (id: string | undefined) => PLOTS.find((p) => p.id === id);
export const frameById = (id: string | undefined) => FRAMES.find((f) => f.id === id);

/** Where the character stands while building at a plot or hanging a painting (tile coordinates, like positions). */
export function standPoint(target: { plot?: string; frame?: string }): Point | null {
  const plot = plotById(target.plot);
  if (plot) return { x: plot.area.x + plot.area.w / 2 - 0.5, y: plot.area.y + plot.area.h - 0.3 };
  const frame = frameById(target.frame);
  if (frame) return { x: frame.rect.x + frame.rect.w / 2 - 0.5, y: frame.rect.y + frame.rect.h + 0.2 };
  return null;
}

/** Something the character built, as everyone sees it (the SVG comes from /api/build/<id>.svg). */
export interface TownBuild {
  id: number;
  plot: string;
  name: string;
  description: string;
  simTime: number;
}

/** `replaced`: something newer went up on the same plot. */
export type BuildStatus = 'shown' | 'held' | 'hidden' | 'replaced';

/** Every build, for the admin page. */
export interface AdminBuild extends TownBuild {
  status: BuildStatus;
  createdAt: string;
  note?: string;
}

/** A painting on a frame. */
export interface TownFrame {
  frame: string;
  artId: number;
  title: string;
  simTime: number;
}

export interface TownState {
  builds: TownBuild[];
  frames: TownFrame[];
}

export interface BuildRequest {
  plot: string;
  name: string;
  description: string;
  svg: string;
  /** The content check said no: kept for the admin, not shown. */
  held?: boolean;
  note?: string;
  llm?: LlmMeta[];
}
