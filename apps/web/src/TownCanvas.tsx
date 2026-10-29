import { useEffect, useRef, type RefObject } from 'react';
import { MAP_HEIGHT, MAP_WIDTH } from '@ampli-world/shared';
import { drawFrame, drawStatic, HEIGHT, WIDTH, type FrameState } from './town.ts';
import type { Bubble, LiveSnapshot } from './useWorld.ts';

export function TownCanvas({ live, bubble }: { live: RefObject<LiveSnapshot | null>; bubble: RefObject<Bubble | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = WIDTH * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);

    const staticLayer = document.createElement('canvas');
    staticLayer.width = WIDTH * dpr;
    staticLayer.height = HEIGHT * dpr;
    const sctx = staticLayer.getContext('2d')!;
    sctx.scale(dpr, dpr);
    drawStatic(sctx);

    const state: FrameState = { lastX: 0, facing: 1, lastNow: 0, reveal: {}, mouse: null };
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      state.mouse = { x: ((e.clientX - r.left) / r.width) * MAP_WIDTH, y: ((e.clientY - r.top) / r.height) * MAP_HEIGHT };
    };
    const onLeave = () => {
      state.mouse = null;
    };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    let raf = 0;
    const frame = (now: number) => {
      drawFrame(ctx, staticLayer, live.current, bubble.current, now, state);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
    };
  }, [live, bubble]);

  return <canvas ref={canvasRef} className="town" aria-label="Map of the town with the character in it. Hover over a building to look inside." />;
}
