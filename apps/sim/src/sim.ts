import type { BookWithText, EventBody, Neighbor, Persona, WorldEvent, WorldSnapshot } from '@ampli-world/shared';
import { Engine, initialState } from './engine.ts';
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

  constructor(
    readonly store: Store,
    readonly books: Map<string, BookWithText>,
    readonly persona: Persona,
    readonly minutesPerSecond: number,
    readonly neighbors: Neighbor[] = [],
  ) {
    this.engine = new Engine(
      store.loadState() ?? initialState(),
      (body, simTime) => this.record(body, simTime),
      (id) => books.get(id)?.title,
      minutesPerSecond,
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
    return event;
  }
}
