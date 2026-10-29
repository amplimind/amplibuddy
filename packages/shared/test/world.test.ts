import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanSvg,
  minutesUntilMorning,
  moodFrom,
  pathBetween,
  pathLength,
  pointAlong,
  PLACES,
} from '../src/index.ts';

test('path goes spot -> door -> main street -> door -> spot', () => {
  const path = pathBetween('home', 'cafe');
  assert.deepEqual(path, [
    PLACES.home.spot,
    PLACES.home.door,
    { x: 6, y: 12 },
    { x: 33, y: 12 },
    PLACES.cafe.door,
    PLACES.cafe.spot,
  ]);
  assert.equal(pathLength(path), 5 + 3 + 27 + 3 + 3);
});

test('every building spot is inside the building and lined up with its door', () => {
  for (const id of ['home', 'cafe', 'library', 'netcafe'] as const) {
    const { area, door, spot } = PLACES[id];
    assert.ok(spot.x >= area.x && spot.x < area.x + area.w && spot.y >= area.y && spot.y < area.y + area.h, id);
    assert.ok(spot.x === door.x || spot.y === door.y, `${id} spot must share an axis with the door`);
  }
});

test('path to plaza crosses the street and ends at the fountain spot', () => {
  const path = pathBetween('home', 'plaza');
  assert.deepEqual(path, [PLACES.home.spot, PLACES.home.door, { x: 6, y: 12 }, PLACES.plaza.door, PLACES.plaza.spot]);
});

test('path from the park bench starts at the bench', () => {
  const path = pathBetween('park', 'cafe');
  assert.deepEqual(path[0], PLACES.park.spot);
  assert.deepEqual(path[1], PLACES.park.door);
});

test('pointAlong interpolates and clamps', () => {
  const path = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }];
  assert.deepEqual(pointAlong(path, 0), { x: 0, y: 0 });
  assert.deepEqual(pointAlong(path, 0.25), { x: 0, y: 5 });
  assert.deepEqual(pointAlong(path, 0.75), { x: 5, y: 10 });
  assert.deepEqual(pointAlong(path, 2), { x: 10, y: 10 });
});

test('sleep lasts until 07:00', () => {
  assert.equal(minutesUntilMorning(23 * 60), 8 * 60);
  assert.equal(minutesUntilMorning(1440 + 2 * 60), 5 * 60);
  assert.equal(minutesUntilMorning(6 * 60 + 30), 60, 'minimum one hour');
});

test('mood: lowest need dominates the label', () => {
  const ok = { energy: 90, satiety: 90, fun: 90, social: 90 };
  assert.equal(moodFrom({ ...ok, energy: 10 }, 0).label, 'sleepy');
  assert.equal(moodFrom({ ...ok, satiety: 15 }, 0).label, 'hungry and a bit grumpy');
  assert.equal(moodFrom({ ...ok, social: 10 }, 0).label, 'lonely');
  assert.equal(moodFrom({ energy: 95, satiety: 95, fun: 95, social: 95 }, 0).label, 'cheerful');
  assert.equal(moodFrom({ energy: 50, satiety: 50, fun: 50, social: 50 }, 0.2).label, 'content');
});

test('cleanSvg accepts plain drawings and rejects anything active or external', () => {
  const ok = '<svg viewBox="0 0 400 300"><rect width="400" height="300" fill="#fde"/><circle cx="200" cy="150" r="40"/></svg>';
  assert.match(cleanSvg(ok)!, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox/);
  assert.equal(cleanSvg('```svg\n' + ok + '\n```')?.endsWith('</svg>'), true, 'code fences are unwrapped');
  for (const bad of [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"><rect/></svg>',
    '<svg><a href="https://x.y"><rect/></a></svg>',
    '<svg><rect fill="url(https://x.y/p.svg)"/></svg>',
    '<svg><foreignObject><div/></foreignObject></svg>',
    '<svg><image href="x.png"/></svg>',
    '<svg><style>@import url(x.css)</style></svg>',
    '<div>not svg</div>',
    `<svg>${'x'.repeat(21_000)}</svg>`,
  ]) {
    assert.equal(cleanSvg(bad), null, bad.slice(0, 40));
  }
  assert.ok(cleanSvg('<svg viewBox="0 0 4 3"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/></svg>'), 'local gradients are fine');
});
