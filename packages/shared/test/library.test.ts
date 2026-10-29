import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readingProgress, splitIntoParts, tidyExtractedText } from '../src/index.ts';

test('long texts are split into parts at paragraph breaks, never over the size', () => {
  assert.deepEqual(splitIntoParts('Short text.'), ['Short text.']);
  const paragraph = 'A sentence about ponds. '.repeat(40).trim();
  const text = Array.from({ length: 30 }, () => paragraph).join('\n\n');
  const parts = splitIntoParts(text, 3000);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length <= 3000));
  assert.ok(parts.every((p) => p.endsWith('ponds.')), 'cut at a paragraph or sentence, not mid-word');
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '), 'nothing lost');
  assert.equal(splitIntoParts('x'.repeat(250), 100).length, 3, 'one endless word still gets cut');
});

test('PDF text: hyphenated line breaks joined, pages become paragraphs', () => {
  assert.equal(tidyExtractedText(['The pond freezes from the top. The fish swim be-\nneath the ice.', '  Page two.  ']), 'The pond freezes from the top. The fish swim beneath the ice.\n\nPage two.');
});

test('reading continues where it stopped and starts over after the last part', () => {
  assert.deepEqual(readingProgress([], 4), { next: 1, earlier: [] });
  const r = (part: number, takeaway = `p${part}`) => ({ part, parts: 4, takeaway });
  assert.deepEqual(readingProgress([r(2), r(1)], 4), { next: 3, earlier: ['p1', 'p2'] });
  assert.deepEqual(readingProgress([r(4), r(3)], 4), { next: 1, earlier: [] }, 'finished: start over');
  assert.deepEqual(readingProgress([r(2), r(1)], 6), { next: 1, earlier: [] }, 'the book changed length');
  assert.deepEqual(readingProgress([{ takeaway: 'old, before parts' }], 4), { next: 1, earlier: [] });
  assert.deepEqual(readingProgress([r(3), r(2), r(1), r(4)], 4).earlier, ['p1', 'p2', 'p3'], 'only this pass');
});
