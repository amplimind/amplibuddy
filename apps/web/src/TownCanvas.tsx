import { useEffect, useRef, useState, type RefObject } from 'react';
import { drawFrame, drawStatic, foxTile, HEIGHT, TILE, WIDTH, type FrameState, type View } from './town.ts';
import type { Bubble, LiveSnapshot } from './useWorld.ts';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.5;

/** Where the camera looks (map pixels) and how far it's zoomed in (1 = whole map). */
interface Camera {
  zoom: number;
  cx: number;
  cy: number;
  follow: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The view for a camera on a canvas of cssW x cssH, keeping the map edge-to-edge. */
function viewFor(cam: Camera, cssW: number, cssH: number): View {
  const scale = (cssW / WIDTH) * cam.zoom;
  const halfW = cssW / 2 / scale;
  const halfH = cssH / 2 / scale;
  cam.cx = clamp(cam.cx, halfW, WIDTH - halfW);
  cam.cy = clamp(cam.cy, halfH, HEIGHT - halfH);
  return { scale, tx: cssW / 2 - cam.cx * scale, ty: cssH / 2 - cam.cy * scale };
}

export function TownCanvas({ live, bubble }: { live: RefObject<LiveSnapshot | null>; bubble: RefObject<Bubble | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const camera = useRef<Camera>({ zoom: 1, cx: WIDTH / 2, cy: HEIGHT / 2, follow: false });
  const [follow, setFollow] = useState(false);
  const [zoomed, setZoomed] = useState(false);

  const setZoom = (zoom: number) => {
    camera.current.zoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    setZoomed(camera.current.zoom > 1);
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const staticLayer = document.createElement('canvas');
    const sctx = staticLayer.getContext('2d')!;
    let dpr = window.devicePixelRatio || 1;
    let cssW = 1;
    let cssH = 1;
    let view: View = { scale: 1, tx: 0, ty: 0 };
    let staticKey = '';

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      cssW = canvas.clientWidth || 1;
      cssH = canvas.clientHeight || 1;
      canvas.width = staticLayer.width = Math.round(cssW * dpr);
      canvas.height = staticLayer.height = Math.round(cssH * dpr);
      staticKey = '';
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const state: FrameState = { lastX: 0, facing: 1, lastNow: 0, reveal: {}, mouse: null };
    const toMap = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      return { x: (e.clientX - r.left - view.tx) / view.scale, y: (e.clientY - r.top - view.ty) / view.scale };
    };

    // Drag to pan.
    let drag: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const m = toMap(e);
      state.mouse = { x: m.x / TILE, y: m.y / TILE };
      if (!drag) return;
      const cam = camera.current;
      cam.cx -= (e.clientX - drag.x) / view.scale;
      cam.cy -= (e.clientY - drag.y) / view.scale;
      view = viewFor(cam, cssW, cssH);
      if (cam.follow && (e.clientX !== drag.x || e.clientY !== drag.y)) {
        cam.follow = false;
        setFollow(false);
      }
      drag = { x: e.clientX, y: e.clientY };
    };
    const onUp = () => {
      drag = null;
    };
    const onLeave = () => {
      state.mouse = null;
    };
    // Wheel to zoom around the pointer.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = camera.current;
      const before = toMap(e);
      const zoom = clamp(cam.zoom * Math.exp(-e.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
      const r = canvas.getBoundingClientRect();
      const scale = (cssW / WIDTH) * zoom;
      cam.zoom = zoom;
      cam.cx = before.x - (e.clientX - r.left - cssW / 2) / scale;
      cam.cy = before.y - (e.clientY - r.top - cssH / 2) / scale;
      // Several wheel events can arrive per frame; keep the next one anchored to this view.
      view = viewFor(cam, cssW, cssH);
      setZoomed(zoom > 1);
    };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    let raf = 0;
    const frame = (now: number) => {
      const cam = camera.current;
      const snap = live.current;
      if (cam.follow && snap) {
        const fox = foxTile(snap, now);
        cam.cx += ((fox.x + 0.5) * TILE - cam.cx) * 0.15;
        cam.cy += ((fox.y + 0.5) * TILE - cam.cy) * 0.15;
      }
      view = viewFor(cam, cssW, cssH);
      const key = `${view.scale.toFixed(4)}|${view.tx.toFixed(1)}|${view.ty.toFixed(1)}|${staticLayer.width}`;
      if (key !== staticKey) {
        sctx.setTransform(1, 0, 0, 1, 0, 0);
        sctx.clearRect(0, 0, staticLayer.width, staticLayer.height);
        sctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.tx, dpr * view.ty);
        drawStatic(sctx);
        staticKey = key;
      }
      drawFrame(ctx, staticLayer, snap, bubble.current, now, state, view, dpr);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [live, bubble]);

  const toggleFollow = () => {
    const next = !camera.current.follow;
    camera.current.follow = next;
    if (next && camera.current.zoom < 2) setZoom(2.5);
    setFollow(next);
  };

  return (
    <div className="map">
      <canvas
        ref={canvasRef}
        className="town"
        style={{ aspectRatio: `${WIDTH} / ${HEIGHT}` }}
        aria-label="Map of the town. Scroll to zoom, drag to move, hover over a building to look inside."
      />
      <div className="map-controls">
        <button type="button" onClick={() => setZoom(camera.current.zoom * ZOOM_STEP)} aria-label="Zoom in">
          ＋
        </button>
        <button type="button" onClick={() => setZoom(camera.current.zoom / ZOOM_STEP)} aria-label="Zoom out">
          −
        </button>
        <button
          type="button"
          disabled={!zoomed && !follow}
          onClick={() => {
            camera.current.follow = false;
            setFollow(false);
            setZoom(1);
          }}
          aria-label="Show the whole map"
          title="Whole map"
        >
          ⤢
        </button>
        <button
          type="button"
          className={follow ? 'active' : ''}
          onClick={toggleFollow}
          aria-pressed={follow}
          aria-label="Follow Ampli"
          title="Follow Ampli"
        >
          🦊
        </button>
      </div>
    </div>
  );
}
