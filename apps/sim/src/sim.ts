import { frameById, type BookWithText, type EventBody, type Neighbor, type Persona, type WorldEvent, type WorldSnapshot } from '@ampli-world/shared';
import { Engine, initialState } from './engine.ts';
import type { GyrosBridge } from './gyros.ts';
import type { ShelfBook } from './library.ts';
import type { Projects } from './projects.ts';
import type { Store } from './store.ts';

export interface SseMessage {
  event: 'state' | 'event';
  data: string;
}

/** Fan-out to connected SSE clients. */
export class Hub {
  private readonly listeners = new Set<(msg: SseMessage) => void>();

  add(fn: (msg: SseMessage) => void): void {
    this.listeners.add(fn);
  }

  delete(fn: (msg: SseMessage) => void): void {
    this.listeners.delete(fn);
  }

  broadcast(msg: SseMessage): void {
    for (const fn of this.listeners) fn(msg);
  }
}

/** Engine + persistence + broadcasting, glued together. */
export class Sim {
  readonly hub = new Hub();
  readonly engine: Engine;
  /** Set by main when GYROS_URL is configured. */
  gyros: GyrosBridge | null = null;
  /** Set by main unless CODE=off. */
  projects: Projects | null = null;

  constructor(
    readonly store: Store,
    readonly books: Map<string, ShelfBook>,
    readonly persona: Persona,
    readonly minutesPerSecond: number,
    readonly neighbors: Neighbor[] = [],
  ) {
    this.engine = new Engine(
      store.loadState() ?? initialState(),
      (body, simTime) => this.record(body, simTime),
      (id) => books.get(id)?.title,
      minutesPerSecond,
      // Without a partner, the first neighbour (older brains only knew one).
      (partnerId) => neighbors.find((n) => n.id === partnerId) ?? (partnerId ? undefined : neighbors[0]),
    );
  }

  snapshot(): WorldSnapshot {
    return {
      simTime: this.engine.simTime,
      minutesPerSecond: this.minutesPerSecond,
      persona: this.persona,
      neighbors: this.neighbors,
      agent: this.engine.agent,
      mailWaiting: this.store.mailStats().waiting,
      latestArtId: this.store.latestArtId(),
      openQuestion: this.store.openQuestion(),
      townVersion: this.store.townVersion(),
      gyros: this.gyros?.state() ?? null,
    };
  }

  /** Log an event at the current sim time and push it to clients. */
  log(body: EventBody): WorldEvent {
    return this.record(body, this.engine.simTime);
  }

  tick(realSeconds: number): void {
    this.engine.advance(realSeconds * this.minutesPerSecond);
    this.broadcastState();
  }

  broadcastState(): void {
    this.hub.broadcast({ event: 'state', data: JSON.stringify(this.snapshot()) });
  }

  save(): void {
    this.store.saveState(this.engine.state());
  }

  private record(body: EventBody, simTime: number): WorldEvent {
    const event = this.store.appendEvent(simTime, body);
    this.hub.broadcast({ event: 'event', data: JSON.stringify(event) });
    if (body.type === 'activity_started' && body.data.kind === 'hang_painting') this.hangPainting(simTime);
    return event;
  }

  /** At the frame: the painting goes up (if it's still in the gallery), the old one comes down. */
  private hangPainting(simTime: number): void {
    const { frame: frameId, artId } = this.engine.agent.activity ?? {};
    const frame = frameById(frameId);
    const art = typeof artId === 'number' ? this.store.artwork(artId) : null;
    if (!frame || !art || art.status !== 'shown') return;
    const before = this.store.hangPainting(frame.id, art.id, simTime);
    const replaced = before !== null && before !== art.id ? this.store.artwork(before)?.title : undefined;
    this.record(
      { type: 'painting_hung', data: { frame: frame.id, where: frame.where, artId: art.id, title: art.title, ...(replaced ? { replaced } : {}) } },
      simTime,
    );
  }
}
