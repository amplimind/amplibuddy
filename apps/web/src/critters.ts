import type { Look } from '@ampli-world/shared';

// Every animal in town, drawn from the same little body: a round head-body, a muzzle
// and two eyes, with ears, tail and markings that make the species. Facing right at
// scale 1; about 24 map pixels (one tile) tall.

type Ears = 'pointy' | 'cat' | 'round' | 'long' | 'floppy' | 'mouse' | 'tiny';
type Tail = 'bushy' | 'thin' | 'string' | 'puff' | 'stub' | 'ringed' | 'none';

interface Sprite {
  body: string;
  dark: string;
  muzzle: string;
  /** Inside of the ears, where it shows. */
  inner?: string;
  nose: string;
  ears: Ears;
  tail: Tail;
  /** Raccoon mask across the eyes. */
  mask?: boolean;
  /** Hedgehog spines along the back. */
  spines?: boolean;
}

const INK = '#3b3127';
const SHADOW = 'rgba(40, 30, 20, 0.18)';
const PINK = '#f2b8b8';

const SPRITES: Record<Look, Sprite> = {
  fox: { body: '#e07a3a', dark: '#b85b25', muzzle: '#fff6e8', nose: INK, ears: 'pointy', tail: 'bushy' },
  cat: { body: '#8e939e', dark: '#6c707b', muzzle: '#f2f2f5', inner: PINK, nose: '#d98c8c', ears: 'cat', tail: 'thin' },
  dog: { body: '#c99d6d', dark: '#8b6440', muzzle: '#f5e6d0', nose: INK, ears: 'floppy', tail: 'stub' },
  rabbit: { body: '#ece5da', dark: '#cfc4b4', muzzle: '#ffffff', inner: PINK, nose: '#d98c8c', ears: 'long', tail: 'puff' },
  bear: { body: '#8d5d3d', dark: '#6b452c', muzzle: '#d9b48f', inner: '#b98a63', nose: INK, ears: 'round', tail: 'none' },
  raccoon: { body: '#918c86', dark: '#44403c', muzzle: '#eee9e3', inner: '#c9c3bc', nose: INK, ears: 'round', tail: 'ringed', mask: true },
  hedgehog: { body: '#9a714e', dark: '#5a3e2b', muzzle: '#ecd3ad', nose: INK, ears: 'tiny', tail: 'none', spines: true },
  mouse: { body: '#aaa5a2', dark: '#8a8584', muzzle: '#eeeae7', inner: PINK, nose: '#d98c8c', ears: 'mouse', tail: 'string' },
};

export interface CritterPose {
  /** 1 = facing right, -1 = facing left. */
  facing?: number;
  sleeping?: boolean;
  /** Vertical bounce while walking or breathing, in map pixels. */
  bob?: number;
  /** 1 = map size. */
  scale?: number;
}

function ellipse(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, rot: number, fill: string) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  ctx.fill();
}

function drawTail(ctx: CanvasRenderingContext2D, s: Sprite) {
  switch (s.tail) {
    case 'bushy':
      ellipse(ctx, -11, 3, 8, 5, -0.5, s.body);
      ellipse(ctx, -17, 0, 3, 3, 0, s.muzzle);
      return;
    case 'ringed':
      ellipse(ctx, -12, 2, 8, 4.5, -0.5, s.body);
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(-12, 2, 8, 4.5, -0.5, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = s.dark;
      for (const x of [-18, -13, -8]) {
        ctx.save();
        ctx.translate(x, 2 - (x + 12) * 0.5);
        ctx.rotate(-0.5);
        ctx.fillRect(-1.3, -6, 2.6, 12);
        ctx.restore();
      }
      ctx.restore();
      return;
    case 'thin':
    case 'string': {
      ctx.strokeStyle = s.tail === 'thin' ? s.body : PINK;
      ctx.lineWidth = s.tail === 'thin' ? 2.6 : 1.4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-8, 5);
      if (s.tail === 'thin') ctx.quadraticCurveTo(-19, 6, -16, -7);
      else ctx.quadraticCurveTo(-16, 10, -21, 3);
      ctx.stroke();
      return;
    }
    case 'puff':
      ellipse(ctx, -10, 4, 3.8, 3.8, 0, '#ffffff');
      return;
    case 'stub':
      // Low at the back, wagging up and away: reads as a tail, not an ear.
      ellipse(ctx, -11, 4, 1.7, 4, -1.0, s.body);
      return;
    case 'none':
      return;
  }
}

function drawEars(ctx: CanvasRenderingContext2D, s: Sprite) {
  const triangle = (ex: number, h: number, w: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(ex - w, -6);
    ctx.lineTo(ex, -6 - h);
    ctx.lineTo(ex + w, -6);
    ctx.closePath();
    ctx.fill();
  };
  switch (s.ears) {
    case 'pointy':
      for (const ex of [-6, 5]) triangle(ex, 9, 4, s.dark);
      return;
    case 'cat':
      for (const ex of [-5, 5]) {
        triangle(ex, 7, 3.6, s.body);
        triangle(ex, 4, 1.8, s.inner ?? s.dark);
      }
      return;
    case 'round':
      for (const ex of [-6, 5]) {
        ellipse(ctx, ex, -8, 4, 4, 0, s.dark);
        ellipse(ctx, ex, -8, 2, 2, 0, s.inner ?? s.muzzle);
      }
      return;
    case 'long':
      for (const [ex, rot] of [[-4, -0.25], [3, 0.15]] as const) {
        ellipse(ctx, ex, -15, 2.8, 8, rot, s.body);
        ellipse(ctx, ex, -15, 1.3, 5.5, rot, s.inner ?? s.dark);
      }
      return;
    case 'floppy':
      // Hanging down the side of the head, from the top.
      ellipse(ctx, -4.5, -1.5, 3.4, 6.8, 0.3, s.dark);
      return;
    case 'mouse':
      for (const ex of [-6, 4]) {
        ellipse(ctx, ex, -9, 5.2, 5.2, 0, s.body);
        ellipse(ctx, ex, -9, 3, 3, 0, s.inner ?? s.dark);
      }
      return;
    case 'tiny':
      // Body-coloured and tucked into the spines, so they don't read as a second pair of eyes.
      ellipse(ctx, -3, -9.2, 2.2, 1.8, 0, s.body);
      return;
  }
}

function drawSpines(ctx: CanvasRenderingContext2D, s: Sprite) {
  ctx.fillStyle = s.dark;
  // Along the back: from the tail end over the top, stopping short of the face.
  for (let i = 0; i < 9; i++) {
    const a = Math.PI * 0.75 + (i / 8) * Math.PI * 0.85;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a - 0.22) * 8, Math.sin(a - 0.22) * 8);
    ctx.lineTo(Math.cos(a) * 14.5, Math.sin(a) * 13);
    ctx.lineTo(Math.cos(a + 0.22) * 8, Math.sin(a + 0.22) * 8);
    ctx.fill();
  }
}

export function drawCritter(ctx: CanvasRenderingContext2D, look: Look, x: number, y: number, pose: CritterPose = {}) {
  const s = SPRITES[look] ?? SPRITES.fox;
  const { facing = 1, sleeping = false, bob = 0, scale = 1 } = pose;
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.scale(facing * scale, scale);

  ellipse(ctx, 0, 10 - bob, 11, 4, 0, SHADOW);
  drawTail(ctx, s);
  if (s.spines) drawSpines(ctx, s);

  ellipse(ctx, 0, 0, 10, 10, 0, s.body);
  drawEars(ctx, s);

  if (s.mask) {
    ctx.fillStyle = s.dark;
    ctx.beginPath();
    ctx.ellipse(2, -3, 7.5, 3, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  ellipse(ctx, 4, 3, 6, 5, 0, s.muzzle);
  ellipse(ctx, 9, 2, 1.8, 1.8, 0, s.nose);

  ctx.strokeStyle = s.mask ? '#ffffff' : INK;
  ctx.fillStyle = s.mask ? '#ffffff' : INK;
  ctx.lineWidth = 1.5;
  for (const ex of [-2, 5]) {
    if (sleeping) {
      ctx.beginPath();
      ctx.moveTo(ex - 2, -3);
      ctx.lineTo(ex + 2, -3);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.arc(ex, -3, 1.6, 0, Math.PI * 2);
      ctx.fill();
      if (s.mask) {
        ctx.fillStyle = INK;
        ctx.beginPath();
        ctx.arc(ex + 0.3, -3, 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
      }
    }
  }
  ctx.restore();
}
