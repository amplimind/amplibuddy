import {
  ART_VERSION,
  MAIN_STREET_Y,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLACES,
  hourOf,
  neighborPresent,
  pointAlong,
  GYROS_STATIONS,
  type ActivityKind,
  type GyrosRun,
  type GyrosState,
  type GyrosStation,
  type Neighbor,
  type PlaceDef,
  type PlaceId,
  type Point,
} from '@ampli-world/shared';
import { drawCritter } from './critters.ts';
import type { Bubble, LiveSnapshot } from './useWorld.ts';

// Canvas renderer for the town. The static layer (ground, roads, buildings)
// is drawn once; the character, night tint and bubbles are drawn per frame.

export const TILE = 24;
export const WIDTH = MAP_WIDTH * TILE;
export const HEIGHT = MAP_HEIGHT * TILE;

const BUBBLE_MS = 14_000;

const C = {
  grass: '#9cc77a',
  grassDark: '#90bc6e',
  grassLight: '#a8d087',
  road: '#e6d3a3',
  roadEdge: '#d2bb86',
  paving: '#e2dacb',
  pavingLine: '#cfc5b3',
  water: '#7db6d6',
  waterLight: '#a9d2e8',
  hedge: '#5e9748',
  parkGrass: '#8fc070',
  tree: '#4f8a3c',
  treeLight: '#66a250',
  trunk: '#7a5235',
  wood: '#9a6a43',
  shadow: 'rgba(40, 30, 20, 0.18)',
  ink: '#3b3127',
  fox: '#e07a3a',
  foxDark: '#b85b25',
  cream: '#fff6e8',
  glow: '#ffd77a',
};

interface BuildingStyle {
  roof: string;
  roofDark: string;
  wall: string;
  awning?: [string, string];
}

const BUILDINGS: Partial<Record<PlaceDef['id'], BuildingStyle>> = {
  home: { roof: '#c8553d', roofDark: '#a8432f', wall: '#f3e3c3' },
  cafe: { roof: '#7b5e57', roofDark: '#5f4741', wall: '#fff1d6', awning: ['#2f9c95', '#f7f3ea'] },
  library: { roof: '#4a6fa5', roofDark: '#3a5885', wall: '#e8dcc8' },
  netcafe: { roof: '#3b4a6b', roofDark: '#2c3852', wall: '#e6eef5', awning: ['#7a5cc7', '#e6eef5'] },
  studio: { roof: '#d9822b', roofDark: '#b5661a', wall: '#fbf3e4', awning: ['#e0b84c', '#c8553d'] },
  workshop: { roof: '#55606e', roofDark: '#424b57', wall: '#ece6da', awning: ['#f2a33a', '#3b3127'] },
};

/** The workshop has a glass roof: GyrOS stays visible from outside. */
const GLASS_ROOF_ALPHA = 0.28;

/** Station desks in the workshop (tile centres): along the top, then back along the bottom. */
const STATION_POS: Record<GyrosStation, Point> = {
  ticket: { x: 42.1, y: 15.9 },
  questions: { x: 43.9, y: 15.9 },
  draft: { x: 45.7, y: 15.9 },
  setup: { x: 47.5, y: 15.9 },
  bench: { x: 49.3, y: 15.9 },
  gates: { x: 49.3, y: 21.1 },
  browser: { x: 47.5, y: 21.1 },
  review: { x: 45.7, y: 21.1 },
  dock: { x: 43.9, y: 21.1 },
  watch: { x: 42.1, y: 21.1 },
};

const PARK_TREES: Point[] = [
  { x: 28.6, y: 15.6 },
  { x: 29.8, y: 19.6 },
  { x: 36.4, y: 15.4 },
  { x: 28.4, y: 21.1 },
  { x: 30.4, y: 16.9 },
  { x: 37.0, y: 17.6 },
];
const POND = { x: 34.8, y: 19.6, rx: 2.4, ry: 1.3 };
const FOUNTAIN = { x: 22.5, y: 14.5, r: 0.95 };
const POST_BOX = { x: 18.6, y: 14.2 };

const ACTIVITY_ICON: Record<ActivityKind, string> = {
  sleep: '💤',
  nap: '💤',
  eat: '🍲',
  coffee: '☕',
  stroll: '🌿',
  think: '💭',
  read: '📖',
  people_watch: '👀',
  check_mail: '📬',
  browse: '💻',
  paint: '🎨',
  chat: '💬',
  post_note: '📌',
  visit_workshop: '⚙️',
};

function px(tile: number): number {
  return tile * TILE;
}

/** Deterministic 0..1 noise per tile, so the grass pattern is stable. */
function noise(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function facadeOnTop(place: PlaceDef): boolean {
  return place.door.y < place.area.y;
}

/** Window positions (tile x) on a building facade: every other tile, skipping the door. */
function windowTiles(place: PlaceDef): number[] {
  const out: number[] = [];
  for (let x = place.area.x + 1; x < place.area.x + place.area.w - 1; x += 2) {
    if (x !== place.door.x) out.push(x);
  }
  return out;
}

function facadeY(place: PlaceDef): number {
  return facadeOnTop(place) ? place.area.y : place.area.y + place.area.h - 1;
}

// --- Static layer ------------------------------------------------------------

function drawGround(ctx: CanvasRenderingContext2D) {
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      const n = noise(x, y);
      ctx.fillStyle = n < 0.18 ? C.grassDark : n > 0.85 ? C.grassLight : C.grass;
      ctx.fillRect(px(x), px(y), TILE, TILE);
      if (n > 0.93) {
        ctx.fillStyle = n > 0.97 ? '#f4e27a' : '#f7f2ea';
        ctx.fillRect(px(x) + 8, px(y) + 9, 3, 3);
      }
    }
  }
}

function drawRoadSegment(ctx: CanvasRenderingContext2D, a: Point, b: Point) {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x) + 1;
  const h = Math.abs(a.y - b.y) + 1;
  ctx.fillStyle = C.roadEdge;
  ctx.fillRect(px(x0) - 1, px(y0) - 1, px(w) + 2, px(h) + 2);
  ctx.fillStyle = C.road;
  ctx.fillRect(px(x0) + 2, px(y0) + 2, px(w) - 4, px(h) - 4);
}

function drawRoads(ctx: CanvasRenderingContext2D) {
  drawRoadSegment(ctx, { x: 0, y: MAIN_STREET_Y }, { x: MAP_WIDTH - 1, y: MAIN_STREET_Y });
  for (const place of Object.values(PLACES)) {
    if (place.id === 'plaza') continue;
    drawRoadSegment(ctx, place.door, { x: place.door.x, y: MAIN_STREET_Y });
    drawRoadSegment(ctx, place.spot, place.door);
  }
  // Re-fill the street so lane edges don't cut across it.
  ctx.fillStyle = C.road;
  ctx.fillRect(0, px(MAIN_STREET_Y) + 2, WIDTH, TILE - 4);
}

function drawPlaza(ctx: CanvasRenderingContext2D) {
  const { x, y, w, h } = PLACES.plaza.area;
  ctx.fillStyle = C.paving;
  roundRect(ctx, px(x), px(y), px(w), px(h), 10);
  ctx.fill();
  ctx.strokeStyle = C.pavingLine;
  ctx.lineWidth = 1;
  for (let i = 1; i < w; i++) {
    ctx.beginPath();
    ctx.moveTo(px(x + i), px(y) + 4);
    ctx.lineTo(px(x + i), px(y + h) - 4);
    ctx.stroke();
  }
  for (let j = 1; j < h; j++) {
    ctx.beginPath();
    ctx.moveTo(px(x) + 4, px(y + j));
    ctx.lineTo(px(x + w) - 4, px(y + j));
    ctx.stroke();
  }
  // Fountain
  const fx = px(FOUNTAIN.x);
  const fy = px(FOUNTAIN.y);
  ctx.fillStyle = '#b9b0a0';
  ctx.beginPath();
  ctx.arc(fx, fy, px(FOUNTAIN.r) + 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.water;
  ctx.beginPath();
  ctx.arc(fx, fy, px(FOUNTAIN.r), 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.waterLight;
  ctx.beginPath();
  ctx.arc(fx - 4, fy - 4, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#b9b0a0';
  ctx.beginPath();
  ctx.arc(fx, fy, 4, 0, Math.PI * 2);
  ctx.fill();

  // Post box
  const bx = px(POST_BOX.x);
  const by = px(POST_BOX.y);
  ctx.fillStyle = C.shadow;
  ctx.fillRect(bx - 5, by + 9, 14, 4);
  ctx.fillStyle = '#c23b2e';
  roundRect(ctx, bx - 6, by - 10, 12, 20, 4);
  ctx.fill();
  ctx.fillStyle = '#3b3127';
  ctx.fillRect(bx - 4, by - 4, 8, 2);
}

function drawTree(ctx: CanvasRenderingContext2D, t: Point) {
  const x = px(t.x);
  const y = px(t.y);
  ctx.fillStyle = C.shadow;
  ctx.beginPath();
  ctx.ellipse(x + 3, y + 9, 13, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.trunk;
  ctx.fillRect(x - 2, y, 4, 9);
  ctx.fillStyle = C.tree;
  ctx.beginPath();
  ctx.arc(x, y - 2, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.treeLight;
  ctx.beginPath();
  ctx.arc(x - 4, y - 6, 7, 0, Math.PI * 2);
  ctx.fill();
}

function drawPark(ctx: CanvasRenderingContext2D) {
  const { x, y, w, h } = PLACES.park.area;
  ctx.fillStyle = C.parkGrass;
  roundRect(ctx, px(x), px(y), px(w), px(h), 14);
  ctx.fill();
  drawRoadSegment(ctx, PLACES.park.door, PLACES.park.spot);

  // Hedge with a gap for the gate.
  const gate = px(PLACES.park.door.x);
  ctx.strokeStyle = C.hedge;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(gate - 4, px(y));
  ctx.lineTo(px(x) + 14, px(y));
  ctx.arcTo(px(x), px(y), px(x), px(y) + 14, 14);
  ctx.arcTo(px(x), px(y + h), px(x) + 14, px(y + h), 14);
  ctx.arcTo(px(x + w), px(y + h), px(x + w), px(y + h) - 14, 14);
  ctx.arcTo(px(x + w), px(y), px(x + w) - 14, px(y), 14);
  ctx.lineTo(gate + TILE + 4, px(y));
  ctx.stroke();

  // Path from the gate to the bench is drawn by drawRoads; pond and trees on top.
  ctx.fillStyle = '#6aa4c4';
  ctx.beginPath();
  ctx.ellipse(px(POND.x), px(POND.y), px(POND.rx) + 3, px(POND.ry) + 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = C.water;
  ctx.beginPath();
  ctx.ellipse(px(POND.x), px(POND.y), px(POND.rx), px(POND.ry), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = C.waterLight;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(px(POND.x) - 10, px(POND.y) - 4, 14, 5, 0, Math.PI * 1.1, Math.PI * 1.9);
  ctx.stroke();

  // Bench just below the spot.
  const bench = PLACES.park.spot;
  ctx.fillStyle = C.wood;
  ctx.fillRect(px(bench.x) - 6, px(bench.y) + 18, TILE + 12, 5);
  ctx.fillRect(px(bench.x) - 4, px(bench.y) + 23, 3, 4);
  ctx.fillRect(px(bench.x) + TILE + 1, px(bench.y) + 23, 3, 4);

  for (const t of PARK_TREES) drawTree(ctx, t);
}

/** The part of a building under its roof (everything but the facade row), in tiles. */
function roomOf(place: PlaceDef): { x: number; y: number; w: number; h: number } {
  const { x, y, w, h } = place.area;
  return { x, y: facadeOnTop(place) ? y + 1 : y, w, h: h - 1 };
}

function insideArea(place: PlaceDef, p: Point): boolean {
  const { x, y, w, h } = place.area;
  return p.x >= x && p.x < x + w && p.y >= y && p.y < y + h;
}

// --- Interiors (tile coordinates; drawn once into the static layer) ------------------

function rect(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, w: number, h: number, r = 3) {
  ctx.fillStyle = color;
  roundRect(ctx, px(x), px(y), px(w), px(h), r);
  ctx.fill();
}

function circle(ctx: CanvasRenderingContext2D, color: string, x: number, y: number, r: number) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(px(x), px(y), px(r), 0, Math.PI * 2);
  ctx.fill();
}

function planks(ctx: CanvasRenderingContext2D, room: ReturnType<typeof roomOf>, base: string, line: string) {
  ctx.fillStyle = base;
  ctx.fillRect(px(room.x), px(room.y), px(room.w), px(room.h));
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  for (let y = room.y + 0.5; y < room.y + room.h; y += 0.5) {
    ctx.beginPath();
    ctx.moveTo(px(room.x), px(y));
    ctx.lineTo(px(room.x + room.w), px(y));
    ctx.stroke();
  }
}

function checker(ctx: CanvasRenderingContext2D, room: ReturnType<typeof roomOf>, a: string, b: string) {
  for (let y = room.y; y < room.y + room.h; y += 0.5) {
    for (let x = room.x; x < room.x + room.w; x += 0.5) {
      ctx.fillStyle = Math.round((x + y) * 2) % 2 === 0 ? a : b;
      ctx.fillRect(px(x), px(y), TILE / 2, TILE / 2);
    }
  }
}

const SPINES = ['#c8553d', '#4a6fa5', '#e0b84c', '#5e8c61', '#7b5e9e', '#d9822b'];

/** A shelf full of book spines along one wall. */
function shelf(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  rect(ctx, '#6b4a2f', x, y, w, h, 2);
  const vertical = h > w;
  const len = vertical ? h : w;
  for (let i = 0.1, n = 0; i < len - 0.15; i += 0.18, n++) {
    ctx.fillStyle = SPINES[Math.floor(noise(Math.round(x * 10) + n, Math.round(y * 10)) * SPINES.length)]!;
    if (vertical) ctx.fillRect(px(x) + 3, px(y + i), px(w) - 6, px(0.13));
    else ctx.fillRect(px(x + i), px(y) + 3, px(0.13), px(h) - 6);
  }
}

function chair(ctx: CanvasRenderingContext2D, x: number, y: number, color = '#9a6a43') {
  rect(ctx, color, x - 0.25, y - 0.25, 0.5, 0.5, 4);
}

/** Where the newest artwork is shown, in tiles: the canvas on the studio easel. */
const EASEL = { x: 15.15, y: 2.35, w: 2.0, h: 1.5 };

const INTERIORS: Partial<Record<PlaceId, (ctx: CanvasRenderingContext2D, room: ReturnType<typeof roomOf>) => void>> = {
  workshop(ctx, room) {
    checker(ctx, room, '#d7d4cf', '#cbc8c2');
    // A conveyor line through the middle: the run's path from ticket to pull request.
    ctx.strokeStyle = 'rgba(59, 49, 39, 0.25)';
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(px(STATION_POS.ticket.x), px(17.2));
    ctx.lineTo(px(STATION_POS.bench.x + 0.6), px(17.2));
    ctx.lineTo(px(STATION_POS.bench.x + 0.6), px(19.9));
    ctx.lineTo(px(STATION_POS.watch.x), px(19.9));
    ctx.stroke();
    ctx.setLineDash([]);
    for (const s of GYROS_STATIONS) {
      const p = STATION_POS[s.id];
      rect(ctx, '#8c7a66', p.x - 0.6, p.y - 0.45, 1.2, 0.75, 3);
      rect(ctx, '#b49a7e', p.x - 0.55, p.y - 0.45, 1.1, 0.25, 3);
      ctx.font = `${px(0.42)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.icon, px(p.x), px(p.y - 0.05));
      ctx.font = `600 ${px(0.27)}px ui-rounded, system-ui, sans-serif`;
      ctx.fillStyle = C.ink;
      ctx.fillText(s.label, px(p.x), px(p.y + (s.id === 'ticket' || s.id === 'questions' || s.id === 'draft' || s.id === 'setup' || s.id === 'bench' ? 0.55 : -0.7)));
    }
  },
  studio(ctx, room) {
    planks(ctx, room, '#efe2c8', '#e0cfae');
    // Paint splashes on the floor, pictures on the wall, pots and a stool.
    for (const [x, y, r, c] of [
      [13.2, 5.2, 0.18, '#c8553d'],
      [16.4, 5.4, 0.14, '#4a6fa5'],
      [18.8, 4.9, 0.2, '#e0b84c'],
      [14.9, 5.6, 0.1, '#5e9748'],
    ] as const) {
      circle(ctx, c, x, y, r);
    }
    for (const [x, c] of [
      [18.0, '#4a6fa5'],
      [19.3, '#c8553d'],
    ] as const) {
      rect(ctx, '#7a5235', x, 2.25, 1.0, 0.8, 2);
      rect(ctx, c, x + 0.1, 2.35, 0.8, 0.6, 1);
    }
    rect(ctx, '#9a6a43', 12.3, 4.6, 1.2, 0.7, 3);
    circle(ctx, '#c8553d', 12.6, 4.85, 0.15);
    circle(ctx, '#e0b84c', 12.95, 4.85, 0.15);
    circle(ctx, '#4a6fa5', 13.25, 5.1, 0.13);
    // Easel: legs, then a blank canvas (the newest artwork is drawn over it each frame).
    ctx.strokeStyle = '#7a5235';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(px(EASEL.x + 0.3), px(EASEL.y + EASEL.h + 0.6));
    ctx.lineTo(px(EASEL.x + EASEL.w / 2), px(EASEL.y - 0.1));
    ctx.lineTo(px(EASEL.x + EASEL.w - 0.3), px(EASEL.y + EASEL.h + 0.6));
    ctx.stroke();
    rect(ctx, '#ffffff', EASEL.x, EASEL.y, EASEL.w, EASEL.h, 1);
  },
  home(ctx, room) {
    planks(ctx, room, '#d8b48a', '#c49c70');
    // Rug, bookshelf, side table with a mug, plant.
    ctx.fillStyle = '#c8553d';
    ctx.beginPath();
    ctx.ellipse(px(6.5), px(6.7), px(1.5), px(0.6), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e8a87c';
    ctx.beginPath();
    ctx.ellipse(px(6.5), px(6.7), px(1.1), px(0.38), 0, 0, Math.PI * 2);
    ctx.fill();
    shelf(ctx, 3.15, 3.3, 0.6, 2.8);
    circle(ctx, '#9a6a43', 8.7, 4.4, 0.45);
    circle(ctx, '#fff6e8', 8.6, 4.3, 0.13);
    circle(ctx, '#7a5235', 9.3, 7.25, 0.28);
    circle(ctx, '#5e9748', 9.3, 7.0, 0.38);
    // Bed (Ampli's spot is on it).
    rect(ctx, '#7a5235', 5.35, 3.15, 2.3, 2.2, 5);
    rect(ctx, '#f4ede1', 5.5, 3.3, 2.0, 1.9, 4);
    rect(ctx, '#6aa6d6', 5.5, 4.45, 2.0, 0.75, 4);
    rect(ctx, '#ffffff', 5.8, 3.4, 1.4, 0.5, 6);
  },
  cafe(ctx, room) {
    checker(ctx, room, '#f1e4cf', '#e2cfb2');
    // Counter with pastries and the coffee machine.
    rect(ctx, '#7b5e57', 30.3, 3.15, 6.4, 0.85, 3);
    rect(ctx, '#a4877f', 30.3, 3.15, 6.4, 0.3, 3);
    rect(ctx, '#9aa3ad', 35.4, 3.2, 0.8, 0.6, 2);
    circle(ctx, '#f1e4cf', 31.4, 3.6, 0.22);
    circle(ctx, '#d9822b', 31.4, 3.6, 0.12);
    circle(ctx, '#fff6e8', 32.3, 3.6, 0.13);
    circle(ctx, '#fff6e8', 32.8, 3.6, 0.13);
    // Two tables; Ampli sits next to the right one.
    for (const [tx, ty] of [
      [34.6, 6.5],
      [31.4, 5.8],
    ] as const) {
      chair(ctx, tx, ty - 0.75);
      chair(ctx, tx + 0.8, ty);
      circle(ctx, '#d9c8ad', tx, ty, 0.48);
      circle(ctx, '#fff8ec', tx, ty, 0.42);
      circle(ctx, '#ffffff', tx + 0.1, ty - 0.05, 0.12);
    }
  },
  library(ctx, room) {
    planks(ctx, room, '#a07850', '#8a6440');
    shelf(ctx, 3.15, 16.2, 0.65, 4.6);
    shelf(ctx, 10.2, 16.2, 0.65, 4.6);
    shelf(ctx, 3.9, 20.2, 6.2, 0.6);
    ctx.fillStyle = '#5e8c61';
    ctx.beginPath();
    ctx.ellipse(px(6.5), px(19.3), px(1.6), px(0.55), 0, 0, Math.PI * 2);
    ctx.fill();
    // Reading table with books, lamp, armchair under Ampli's spot.
    rect(ctx, '#7a5235', 8.0, 17.6, 1.4, 1.1, 3);
    rect(ctx, '#4a6fa5', 8.2, 17.8, 0.5, 0.35, 1);
    rect(ctx, '#c8553d', 8.6, 18.2, 0.5, 0.3, 1);
    circle(ctx, 'rgba(255, 215, 122, 0.35)', 7.6, 17.4, 0.55);
    circle(ctx, '#ffd77a', 7.6, 17.4, 0.18);
    rect(ctx, '#6e2e2e', 5.75, 17.8, 1.5, 1.35, 6);
    rect(ctx, '#8c3b3b', 5.95, 17.95, 1.1, 1.05, 5);
  },
  netcafe(ctx, room) {
    checker(ctx, room, '#646d84', '#5b6378');
    // Router with a blinking light, a neon "@", the desk row with three screens.
    rect(ctx, '#2c3852', 18.4, 19.2, 0.8, 0.45, 2);
    circle(ctx, '#7dff9b', 19.05, 19.42, 0.06);
    ctx.font = `700 ${px(0.7)}px ui-rounded, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = '#b48cff';
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#d8c2ff';
    ctx.fillText('@', px(12.75), px(19.55));
    ctx.shadowBlur = 0;
    rect(ctx, '#cfd6e3', 12.3, 21.25, 7.4, 0.65, 3);
    for (const sx of [14.5, 16.5, 18.5]) {
      chair(ctx, sx, 20.75, '#2c3852');
      rect(ctx, '#1e2533', sx - 0.45, 21.3, 0.9, 0.5, 2);
      rect(ctx, '#7fd3ff', sx - 0.37, 21.36, 0.74, 0.36, 1);
    }
  },
};

/** Walls, floor and furniture: what you see when the roof fades away. */
function drawBuildingBase(ctx: CanvasRenderingContext2D, place: PlaceDef, style: BuildingStyle) {
  const { x, y, w, h } = place.area;
  const top = facadeOnTop(place);
  const fy = facadeY(place);
  const room = roomOf(place);

  ctx.fillStyle = C.shadow;
  roundRect(ctx, px(x) + 5, px(y) + 6, px(w), px(h), 6);
  ctx.fill();

  ctx.save();
  roundRect(ctx, px(room.x), px(room.y), px(room.w), px(room.h), 6);
  ctx.clip();
  INTERIORS[place.id]?.(ctx, room);
  ctx.restore();
  ctx.strokeStyle = '#6b5444';
  ctx.lineWidth = 4;
  roundRect(ctx, px(room.x) + 2, px(room.y) + 2, px(room.w) - 4, px(room.h) - 4, 5);
  ctx.stroke();

  // Facade with windows and a door.
  ctx.fillStyle = style.wall;
  ctx.fillRect(px(x), px(fy), px(w), TILE);
  ctx.strokeStyle = 'rgba(0,0,0,0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(px(x) + 0.5, px(fy) + 0.5, px(w) - 1, TILE - 1);

  for (const wx of windowTiles(place)) {
    ctx.fillStyle = '#8fb3c9';
    ctx.fillRect(px(wx) + 5, px(fy) + 6, 14, 11);
    ctx.fillStyle = style.wall;
    ctx.fillRect(px(wx) + 11, px(fy) + 6, 2, 11);
  }
  ctx.fillStyle = C.wood;
  ctx.fillRect(px(place.door.x) + 6, px(fy) + (top ? 0 : 4), 12, 20);
  ctx.fillStyle = C.glow;
  ctx.fillRect(px(place.door.x) + 14, px(fy) + 12, 2, 2);

  if (style.awning) {
    const ay = top ? px(fy) + TILE - 6 : px(fy) - 2;
    for (let i = 0; i < w * 2; i++) {
      ctx.fillStyle = style.awning[i % 2]!;
      ctx.fillRect(px(x) + i * (TILE / 2), ay, TILE / 2, 7);
    }
  }
}

/** Drawn every frame so it can fade out when Ampli is inside or the mouse hovers over it. */
function drawRoof(ctx: CanvasRenderingContext2D, place: PlaceDef, style: BuildingStyle, alpha: number) {
  if (alpha <= 0.01) return;
  const { x, w } = place.area;
  const room = roomOf(place);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = style.roof;
  roundRect(ctx, px(x), px(room.y), px(w), px(room.h), 6);
  ctx.fill();
  ctx.strokeStyle = style.roofDark;
  ctx.lineWidth = 2;
  for (let i = 1; i < room.h; i++) {
    ctx.beginPath();
    ctx.moveTo(px(x) + 4, px(room.y + i));
    ctx.lineTo(px(x + w) - 4, px(room.y + i));
    ctx.stroke();
  }
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(px(x) + 6, px(room.y) + px(room.h) / 2);
  ctx.lineTo(px(x + w) - 6, px(room.y) + px(room.h) / 2);
  ctx.stroke();
  ctx.restore();
}

function drawLabel(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number) {
  ctx.font = '600 11px ui-rounded, system-ui, sans-serif';
  const w = ctx.measureText(text).width + 14;
  ctx.fillStyle = 'rgba(255, 252, 245, 0.92)';
  roundRect(ctx, cx - w / 2, cy - 9, w, 18, 9);
  ctx.fill();
  ctx.fillStyle = C.ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, cy + 0.5);
}

export function drawStatic(ctx: CanvasRenderingContext2D) {
  drawGround(ctx);
  drawRoads(ctx);
  drawPlaza(ctx);
  drawPark(ctx);
  for (const place of Object.values(PLACES)) {
    const style = BUILDINGS[place.id];
    if (style) drawBuildingBase(ctx, place, style);
  }
}

/** Roofs (faded by `reveal`) and place labels, which fade with their roof. */
function drawRoofsAndLabels(ctx: CanvasRenderingContext2D, reveal: Partial<Record<PlaceId, number>>) {
  for (const place of Object.values(PLACES)) {
    const style = BUILDINGS[place.id];
    const open = reveal[place.id] ?? 0;
    const glass = place.id === 'workshop';
    if (style) drawRoof(ctx, place, style, (1 - open) * (glass ? GLASS_ROOF_ALPHA : 1));
    const { x, y, w } = place.area;
    const cy = glass ? px(y) - 12 : style ? px(roomOf(place).y) + px(roomOf(place).h) / 2 : px(y) + 14;
    ctx.save();
    ctx.globalAlpha = glass ? 1 : 1 - open;
    drawLabel(ctx, place.name, px(x + w / 2), cy);
    ctx.restore();
  }
}

// --- Per frame ---------------------------------------------------------------

/** 0 by day, up to ~0.5 at night, with dusk and dawn ramps. */
function darkness(simTime: number): number {
  const h = hourOf(simTime);
  if (h >= 7 && h < 18) return 0;
  if (h >= 18 && h < 21) return ((h - 18) / 3) * 0.5;
  if (h >= 5 && h < 7) return ((7 - h) / 2) * 0.5;
  return 0.5;
}

/** Hedda's spot behind the café counter, facing the tables (tile coordinates). */
/** Where neighbours stand at each place (tiles); a second one at the same place stands beside. */
const RESIDENT_SPOTS: Record<PlaceId, Point> = {
  home: { x: 8.2, y: 4.4 },
  cafe: { x: 33.5, y: 3.65 }, // behind the counter
  park: { x: 34.4, y: 16.3 },
  library: { x: 8.2, y: 17.6 },
  plaza: { x: 17.4, y: 14.6 },
  netcafe: { x: 16.2, y: 20.4 },
  studio: { x: 16.4, y: 4.4 },
  workshop: { x: 47, y: 18.6 },
};

/** Map pixel position of each neighbour who's in town right now. */
function residentPositions(neighbors: Neighbor[], simTime: number): Map<string, Point> {
  const perPlace = new Map<PlaceId, number>();
  const positions = new Map<string, Point>();
  for (const n of neighbors) {
    if (!neighborPresent(n, simTime)) continue;
    const i = perPlace.get(n.place) ?? 0;
    perPlace.set(n.place, i + 1);
    const spot = RESIDENT_SPOTS[n.place];
    positions.set(n.id, { x: px(spot.x + i * 1.2), y: px(spot.y) });
  }
  return positions;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = next;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = `${lines[maxLines - 1]!.replace(/[.,;:!?]?$/, '')}…`;
  }
  return lines;
}

function drawBubble(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = '13px ui-rounded, system-ui, sans-serif';
  const lines = wrap(ctx, text, 230, 4);
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
  const h = lines.length * 17 + 14;
  const bx = Math.min(Math.max(x - w / 2, 6), WIDTH - w - 6);
  const by = Math.max(y - h - 34, 6);

  ctx.fillStyle = 'rgba(40, 30, 20, 0.15)';
  roundRect(ctx, bx + 2, by + 3, w, h, 10);
  ctx.fill();
  ctx.fillStyle = '#fffdf8';
  roundRect(ctx, bx, by, w, h, 10);
  ctx.fill();
  // Thought-bubble dots toward the head.
  for (const [dx, dy, r] of [
    [0, h + 7, 4],
    [4, h + 15, 2.5],
  ] as const) {
    ctx.beginPath();
    ctx.arc(Math.min(Math.max(x + dx, bx + 10), bx + w - 10), by + dy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = C.ink;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, bx + 10, by + 8 + i * 17));
  ctx.restore();
}

function drawLitWindows(ctx: CanvasRenderingContext2D, dark: number, simTime: number, agentHome: boolean) {
  if (dark <= 0) return;
  const h = hourOf(simTime);
  ctx.save();
  ctx.globalAlpha = Math.min(1, dark * 2);
  for (const place of Object.values(PLACES)) {
    if (!BUILDINGS[place.id]) continue;
    // The café never closes; home is lit while Ampli is home and awake-ish; library until 22:00.
    const lit =
      place.id === 'cafe' ||
      (place.id === 'home' && agentHome) ||
      ((place.id === 'library' || place.id === 'netcafe' || place.id === 'studio') && h < 22 && h > 6);
    if (!lit) continue;
    const fy = facadeY(place);
    ctx.fillStyle = C.glow;
    ctx.shadowColor = C.glow;
    ctx.shadowBlur = 12;
    for (const wx of windowTiles(place)) ctx.fillRect(px(wx) + 5, px(fy) + 6, 14, 11);
  }
  ctx.restore();
}

/** Mutable per-canvas state for animation (facing direction, roof fades, pointer, easel art). */
export interface FrameState {
  lastX: number;
  facing: number;
  lastNow: number;
  /** The newest artwork, loaded as an image for the easel. */
  easel?: { id: number; img: HTMLImageElement };
  /** 0 = roof on, 1 = roof gone, per building. */
  reveal: Partial<Record<PlaceId, number>>;
  /** Pointer position in tiles, for peeking into buildings. */
  mouse: Point | null;
}

const REVEAL_SPEED = 5;

/** The newest artwork on the easel (under the studio roof, so only visible when you look inside). */
function drawEasel(ctx: CanvasRenderingContext2D, state: FrameState, latestArtId: number | null) {
  if (latestArtId === null) return;
  if (state.easel?.id !== latestArtId) {
    const img = new Image();
    img.src = `/api/art/${latestArtId}.svg?v=${ART_VERSION}`;
    state.easel = { id: latestArtId, img };
  }
  const { img } = state.easel;
  if (img.complete && img.naturalWidth > 0) ctx.drawImage(img, px(EASEL.x), px(EASEL.y), px(EASEL.w), px(EASEL.h));
}

function updateReveal(state: FrameState, fox: Point, now: number) {
  const dt = Math.min(0.1, (now - (state.lastNow || now)) / 1000);
  state.lastNow = now;
  for (const place of Object.values(PLACES)) {
    if (!BUILDINGS[place.id]) continue;
    const peek = insideArea(place, fox) || (state.mouse !== null && insideArea(place, state.mouse));
    const current = state.reveal[place.id] ?? 0;
    state.reveal[place.id] = current + ((peek ? 1 : 0) - current) * Math.min(1, dt * REVEAL_SPEED);
  }
}

/** Map pixels to CSS pixels: x * scale + tx. */
export interface View {
  scale: number;
  tx: number;
  ty: number;
}

/** Ampli's current position in tiles, interpolated along a walk. */
export function foxTile(live: LiveSnapshot, now: number): Point {
  const { snapshot, receivedAt } = live;
  const { agent } = snapshot;
  if (!agent.walk) return agent.position;
  const simNow = snapshot.simTime + ((now - receivedAt) / 1000) * snapshot.minutesPerSecond;
  return pointAlong(agent.walk.path, (simNow - agent.walk.startedAt) / (agent.walk.endsAt - agent.walk.startedAt));
}

/** One small robot per active GyrOS run, at its station; orange with "!" when it waits for a human. */
interface RobotHit {
  run: GyrosRun;
  x: number;
  y: number;
}

const ROBOTS_PER_ROW = 3;
const MAX_ROBOTS = 6;

/** One little robot per run, in rows of three at its station, facing the aisle. Returns the one under the mouse. */
function drawWorkshopRuns(
  ctx: CanvasRenderingContext2D,
  gyros: GyrosState | null,
  now: number,
  mouse: Point | null,
): RobotHit | null {
  const area = PLACES.workshop.area;
  if (!gyros || !gyros.connected) {
    drawLabel(ctx, gyros ? 'GyrOS offline' : 'closed', px(area.x + area.w / 2), px(area.y + area.h / 2));
    return null;
  }
  const byStation = new Map<GyrosStation, GyrosRun[]>();
  for (const run of gyros.runs) byStation.set(run.station, [...(byStation.get(run.station) ?? []), run]);
  let hit: RobotHit | null = null;
  for (const [station, runs] of byStation) {
    const base = STATION_POS[station];
    const top = base.y < 18;
    const shown = runs.slice(0, MAX_ROBOTS);
    shown.forEach((run, i) => {
      const row = Math.floor(i / ROBOTS_PER_ROW);
      const inRow = Math.min(ROBOTS_PER_ROW, shown.length - row * ROBOTS_PER_ROW);
      const col = i % ROBOTS_PER_ROW;
      const x = px(base.x + (col - (inRow - 1) / 2) * 0.55);
      const rowY = top ? base.y + 1.05 + row * 0.6 : base.y - 1.25 - row * 0.6;
      const y = px(rowY) + (run.busy ? Math.sin(now / 160 + i) * 1.2 : 0);
      drawRobot(ctx, run, x, y);
      if (mouse && Math.abs(mouse.x * TILE - x) < 8 && Math.abs(mouse.y * TILE - y) < 9) hit = { run, x, y };
    });
    drawStationBadge(ctx, base, runs);
  }
  return hit;
}

/** How many runs sit at a station, on the desk's corner; orange if any waits for a human. */
function drawStationBadge(ctx: CanvasRenderingContext2D, base: Point, runs: GyrosRun[]) {
  const x = px(base.x + 0.62);
  const y = px(base.y - 0.42);
  ctx.fillStyle = runs.some((r) => r.pending) ? '#e07a3a' : '#5b6670';
  ctx.beginPath();
  ctx.arc(x, y, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.font = '700 8px ui-rounded, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(runs.length), x, y + 0.5);
}

function drawRobot(ctx: CanvasRenderingContext2D, run: GyrosRun, x: number, y: number) {
  const color = run.pending ? '#f2a33a' : run.status === 'watching' ? '#5e9748' : run.busy ? '#4a6fa5' : '#9aa3ad';
  ctx.fillStyle = C.shadow;
  ctx.beginPath();
  ctx.ellipse(x, y + 7, 6, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  roundRect(ctx, x - 6, y - 6, 12, 11, 3);
  ctx.fill();
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y - 6);
  ctx.lineTo(x, y - 9);
  ctx.stroke();
  ctx.fillStyle = run.busy ? '#ffd77a' : C.ink;
  ctx.beginPath();
  ctx.arc(x, y - 10, 1.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillRect(x - 3.5, y - 3, 2.5, 2.5);
  ctx.fillRect(x + 1, y - 3, 2.5, 2.5);
  if (run.pending) {
    ctx.font = '700 10px system-ui, sans-serif';
    ctx.fillStyle = '#b3261e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('!', x + 8, y - 8);
  }
}

/** Ticket, workflow, step and title of the robot under the mouse, in screen pixels above everything else. */
function drawRobotTooltip(ctx: CanvasRenderingContext2D, run: GyrosRun, x: number, y: number, viewWidth: number) {
  const name = run.ticketKey ? (run.workflow === 'carplan' ? run.ticketKey : `${run.ticketKey} · ${run.workflow}`) : run.workflow;
  const step = run.pendingLabel ? `Waiting for: ${run.pendingLabel}` : run.stepLabel;
  const title = run.title && run.title.length > 52 ? `${run.title.slice(0, 51)}…` : run.title;
  const lines = [name, step, ...(title ? [title] : [])];
  const font = (weight: number) => `${weight} 12px ui-rounded, system-ui, sans-serif`;
  let w = 0;
  lines.forEach((line, i) => {
    ctx.font = font(i === 0 ? 700 : 500);
    w = Math.max(w, ctx.measureText(line).width + 20);
  });
  const h = lines.length * 16 + 12;
  const left = Math.min(Math.max(x - w / 2, 6), viewWidth - w - 6);
  const top = y - 18 - h < 6 ? y + 18 : y - 18 - h;
  ctx.fillStyle = 'rgba(255, 252, 245, 0.97)';
  ctx.strokeStyle = run.pending ? '#f2a33a' : '#d8ccb8';
  ctx.lineWidth = 1;
  roundRect(ctx, left, top, w, h, 8);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    ctx.font = font(i === 0 ? 700 : 500);
    ctx.fillStyle = i === 0 ? C.ink : '#6b5d4f';
    ctx.fillText(line, left + 10, top + 7 + i * 16);
  });
  ctx.textBaseline = 'middle';
}

/** A bell over the workshop roof while GyrOS waits for a human. */
function drawWorkshopBell(ctx: CanvasRenderingContext2D, gyros: GyrosState | null, now: number) {
  const waiting = gyros?.runs.filter((r) => r.pending).length ?? 0;
  if (waiting === 0) return;
  const { x, y, w } = PLACES.workshop.area;
  ctx.font = '18px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.translate(px(x + w / 2) + 52, px(y) - 14);
  ctx.rotate(Math.sin(now / 180) * 0.25);
  ctx.fillText('🔔', 0, 0);
  ctx.restore();
  if (waiting > 1) drawLabel(ctx, String(waiting), px(x + w / 2) + 68, px(y) - 20);
}

export function drawFrame(
  ctx: CanvasRenderingContext2D,
  staticLayer: HTMLCanvasElement,
  live: LiveSnapshot | null,
  bubble: Bubble | null,
  now: number,
  state: FrameState,
  view: View,
  dpr: number,
) {
  // The static layer is already rendered for this view, pixel for pixel.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(staticLayer, 0, 0);
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
  if (!live) {
    drawRoofsAndLabels(ctx, state.reveal);
    return;
  }

  const { snapshot, receivedAt } = live;
  const { agent } = snapshot;
  const simNow = snapshot.simTime + ((now - receivedAt) / 1000) * snapshot.minutesPerSecond;

  let pos = agent.position;
  if (agent.walk) {
    const t = (simNow - agent.walk.startedAt) / (agent.walk.endsAt - agent.walk.startedAt);
    pos = pointAlong(agent.walk.path, t);
  }
  const x = px(pos.x + 0.5);
  const y = px(pos.y + 0.5);
  if (Math.abs(x - state.lastX) > 0.05) state.facing = x > state.lastX ? 1 : -1;
  state.lastX = x;

  updateReveal(state, { x: pos.x + 0.5, y: pos.y + 0.5 }, now);
  drawEasel(ctx, state, snapshot.latestArtId);
  const robot = drawWorkshopRuns(ctx, snapshot.gyros, now, state.mouse);
  // Neighbours stand at their place during opening hours (under the roof, so visible when you look inside).
  const residents = residentPositions(snapshot.neighbors, simNow);
  snapshot.neighbors.forEach((n, i) => {
    const at = residents.get(n.id);
    if (at) drawCritter(ctx, n.look, at.x, at.y, { facing: -1, bob: Math.sin(now / 700 + i) * 0.6 });
  });
  drawRoofsAndLabels(ctx, state.reveal);
  drawWorkshopBell(ctx, snapshot.gyros, now);

  const kind = agent.activity?.kind;
  const sleeping = kind === 'sleep' || kind === 'nap';
  const bob = agent.walk ? Math.abs(Math.sin(now / 110)) * -3 : sleeping ? Math.sin(now / 900) * 0.8 : 0;
  drawCritter(ctx, snapshot.persona.look, x, y, { facing: state.facing, sleeping, bob });

  const dark = darkness(simNow);
  if (dark > 0) {
    ctx.fillStyle = `rgba(22, 26, 64, ${dark})`;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }
  drawLitWindows(ctx, dark, simNow, agent.place === 'home' && kind !== 'sleep');
  // A lamp goes on around Ampli when it's inside at night (but not while sleeping).
  if (dark > 0 && !sleeping && agent.place && BUILDINGS[agent.place] && (state.reveal[agent.place] ?? 0) > 0.5) {
    const glow = ctx.createRadialGradient(x, y, 4, x, y, px(2.2));
    glow.addColorStop(0, `rgba(255, 214, 140, ${dark * 0.9})`);
    glow.addColorStop(1, 'rgba(255, 214, 140, 0)');
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = glow;
    ctx.fillRect(x - px(2.2), y - px(2.2), px(4.4), px(4.4));
    ctx.restore();
  }

  if (snapshot.mailWaiting > 0) {
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✉️', px(POST_BOX.x), px(POST_BOX.y) - 20 + Math.sin(now / 400) * 2);
  }

  // An unanswered question floats next to Ampli.
  if (snapshot.openQuestion) {
    ctx.font = '15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('❓', x - 14, y - 20 + Math.sin(now / 450 + 1) * 2);
  }

  // Status icon above the head.
  const icon = agent.thinking ? '💭' : kind ? ACTIVITY_ICON[kind] : null;
  if (icon) {
    ctx.font = '15px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const float = Math.sin(now / 500) * 2;
    ctx.fillText(icon, x + 14, y - 20 + float);
  }

  if (bubble) {
    const age = now - bubble.receivedAt;
    if (age < BUBBLE_MS) {
      const alpha = Math.min(1, age / 300, (BUBBLE_MS - age) / 800);
      const at = bubble.speaker && bubble.speaker !== 'ampli' ? residents.get(bubble.speaker) : undefined;
      drawBubble(ctx, bubble.text, at?.x ?? x, at?.y ?? y, alpha);
    }
  }

  // The robot tooltip is drawn in screen pixels, so it stays readable at any zoom.
  if (robot) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawRobotTooltip(ctx, robot.run, robot.x * view.scale + view.tx, robot.y * view.scale + view.ty, ctx.canvas.width / dpr);
  }
}
