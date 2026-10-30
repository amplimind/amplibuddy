import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventBody, MindView } from '@ampli-world/shared';
import { createApp } from '../src/http.ts';
import { Sim } from '../src/sim.ts';
import { Store } from '../src/store.ts';

const DAY = 24 * 60;

test('mind page: time by category, highlights, knowledge (public letters only), interests and memory', async () => {
  const store = new Store(':memory:');
  const sim = new Sim(store, new Map(), { name: 'Ampli', species: 'fox', look: 'fox', town: 'Mindhaven' }, 1, [
    { id: 'hedda', name: 'Hedda', species: 'hedgehog', look: 'hedgehog', place: 'cafe' },
  ]);
  const at = (simTime: number, body: EventBody) => store.appendEvent(simTime, body);
  // Day 1: 30 min reading, 60 min painting, 20 min sleeping (not counted).
  at(DAY + 600, { type: 'activity_started', data: { kind: 'read', place: 'library', bookTitle: 'Ponds' } });
  at(DAY + 630, { type: 'reading', data: { bookId: 'ponds', title: 'Ponds', takeaway: 'Ice keeps the oxygen in the pond.' } });
  at(DAY + 630, { type: 'activity_finished', data: { kind: 'read', place: 'library' } });
  at(DAY + 700, { type: 'activity_started', data: { kind: 'paint', place: 'studio' } });
  at(DAY + 760, { type: 'artwork_created', data: { artworkId: 1, title: 'Pond under ice', caption: 'The oxygen pond.' } });
  at(DAY + 760, { type: 'activity_finished', data: { kind: 'paint', place: 'studio' } });
  at(DAY + 800, { type: 'activity_started', data: { kind: 'nap', place: 'home' } });
  at(DAY + 820, { type: 'activity_finished', data: { kind: 'nap', place: 'home' } });
  at(DAY + 900, { type: 'mail_read', data: { letterId: 1, from: 'Dennis', text: 'Hello from the office!' } });
  at(DAY + 910, { type: 'mail_read', data: { letterId: 2 } });
  for (let i = 0; i < 3; i++) at(DAY + 1000 + i, { type: 'thought', data: { text: `The pond and its oxygen again ${i}.`, source: 'llm' } });
  store.saveNotebook(DAY + 1400, ['Ponds hold oxygen under ice.']);
  store.saveNotebook(2 * DAY + 60, ['Ponds hold oxygen under the ice, says the book.', 'Hedda likes strong coffee.']);
  store.setNeighborNotes('hedda', ['Ampli likes ponds.']);
  sim.engine.simTime = DAY + 1200;

  const app = createApp(sim, { brainToken: 't', webDist: '/nonexistent' });
  const view = (await (await app.request('/api/mind')).json()) as MindView;

  const day1 = view.days.find((d) => d.day === 2)!;
  assert.equal(day1.minutes.learning, 30);
  assert.equal(day1.minutes.creating, 60);
  assert.equal(Object.values(day1.minutes).reduce((a, b) => a + b, 0), 90, 'sleep and naps are not awake time');
  assert.deepEqual(day1.highlights.map((h) => h.icon), ['📖', '🎨', '✉️', '✉️']);
  assert.deepEqual(view.knowledge.map((k) => [k.kind, k.title]), [['letter', 'From Dennis'], ['book', 'Ponds']], 'the private letter is not knowledge');
  assert.equal(view.stats.letters, 2);
  assert.ok(view.interests.some((i) => i.word === 'oxygen'), JSON.stringify(view.interests));
  assert.ok(!view.interests.some((i) => i.word === 'mindhaven' || i.word === 'ampli'), 'names are not interests');
  assert.deepEqual(view.memory.map((m) => m.day), [2, 2], 'a rewrite after midnight belongs to the day before');
  assert.deepEqual(view.neighbors[0]!.notes, ['Ampli likes ponds.']);
});
