import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookOf, recommendLocalModel } from '../src/index.ts';

test('the sprite: explicit look wins, else guessed from the species text, else a fox', () => {
  assert.equal(lookOf('small fox'), 'fox');
  assert.equal(lookOf('a very old Cat'), 'cat');
  assert.equal(lookOf('bunny'), 'rabbit');
  assert.equal(lookOf('grumpy bear cub'), 'bear');
  assert.equal(lookOf('hedgehog', 'mouse'), 'mouse');
  assert.equal(lookOf('dragon', 'unicorn'), 'fox', 'unknown looks fall back');
});

test('local model: the fast one on big Macs, one small model otherwise', () => {
  assert.equal(recommendLocalModel(64).model, 'ornith:35b');
  assert.equal(recommendLocalModel(64).visionModel, 'gemma4:12b');
  assert.equal(recommendLocalModel(16).model, 'gemma4:12b');
  assert.match(recommendLocalModel(8).note, /cloud/);
});
