import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { DOODLE_SIZE } from '@ampli-world/shared';

const COLORS = ['#3b3127', '#e07a3a', '#c8553d', '#e0b84c', '#5e9748', '#4a6fa5', '#ffffff'];
const SIZES = [3, 7, 14];

/** A small square canvas. Reports a PNG data URL after each stroke, or null when cleared. */
export function DoodlePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [color, setColor] = useState(COLORS[0]!);
  const [size, setSize] = useState(SIZES[1]!);

  function clear() {
    const ctx = canvasRef.current!.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, DOODLE_SIZE, DOODLE_SIZE);
  }

  useEffect(() => {
    const canvas = canvasRef.current!;
    canvas.width = DOODLE_SIZE;
    canvas.height = DOODLE_SIZE;
    clear();
  }, []);

  function point(e: PointerEvent<HTMLCanvasElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * DOODLE_SIZE, y: ((e.clientY - r.top) / r.height) * DOODLE_SIZE };
  }

  function stroke(from: { x: number; y: number }, to: { x: number; y: number }) {
    const ctx = canvasRef.current!.getContext('2d')!;
    ctx.strokeStyle = color;
    ctx.lineWidth = size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }

  return (
    <div className="doodle-pad">
      <canvas
        ref={canvasRef}
        className="doodle-canvas"
        aria-label="Drawing area"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          last.current = point(e);
          stroke(last.current, last.current);
        }}
        onPointerMove={(e) => {
          if (!last.current) return;
          const p = point(e);
          stroke(last.current, p);
          last.current = p;
        }}
        onPointerUp={() => {
          last.current = null;
          onChange(canvasRef.current!.toDataURL('image/png'));
        }}
        onPointerCancel={() => {
          last.current = null;
        }}
      />
      <div className="doodle-tools">
        {COLORS.map((c) => (
          <button
            key={c}
            type="button"
            className={c === color ? 'swatch swatch-active' : 'swatch'}
            style={{ background: c }}
            aria-label={c === '#ffffff' ? 'Eraser' : `Colour ${c}`}
            onClick={() => setColor(c)}
          />
        ))}
        <span className="doodle-sep" />
        {SIZES.map((s) => (
          <button
            key={s}
            type="button"
            className={s === size ? 'brush brush-active' : 'brush'}
            aria-label={`Brush size ${s}`}
            onClick={() => setSize(s)}
          >
            <span style={{ width: s, height: s }} />
          </button>
        ))}
        <button
          type="button"
          className="link"
          onClick={() => {
            clear();
            onChange(null);
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
