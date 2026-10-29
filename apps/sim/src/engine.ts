import {
  ACTIVITIES,
  IDLE_RATES,
  PLACES,
  clampNeed,
  minutesUntilMorning,
  moodFrom,
  pathBetween,
  pointAlong,
  walkMinutes,
  type AgentState,
  type EventBody,
  type Plan,
} from '@ampli-world/shared';

export type Emit = (body: EventBody, simTime: number) => void;

export interface EngineState {
  simTime: number;
  agent: AgentState;
}

/** Day 1, 07:00. */
export const START_TIME = 7 * 60;

/** Mood boost decays toward 0 by this much per sim hour. */
const BOOST_DECAY_PER_HOUR = 0.05;

export function initialState(): EngineState {
  const needs = { energy: 85, satiety: 55, fun: 60, social: 60 };
  return {
    simTime: START_TIME,
    agent: {
      place: 'home',
      position: { ...PLACES.home.spot },
      needs,
      mood: moodFrom(needs, 0),
      moodBoost: 0,
      activity: null,
      walk: null,
      next: null,
      thinking: false,
    },
  };
}

/**
 * The authoritative world. Pure logic: no I/O, no timers. The host calls
 * advance() with elapsed sim minutes and plan() when the brain has decided.
 */
export class Engine {
  simTime: number;
  agent: AgentState;

  constructor(
    state: EngineState,
    private readonly emit: Emit,
    private readonly bookTitle: (id: string) => string | undefined = () => undefined,
    /** Sim speed; walks are timed so they look the same at any speed. */
    private readonly minutesPerSecond = 1,
  ) {
    this.simTime = state.simTime;
    this.agent = state.agent;
    // Worlds saved before the social need existed.
    this.agent.needs.social ??= 60;
    this.retimeWalk();
  }

  /**
   * A walk saved at a different sim speed would crawl or race after a restart.
   * Keep its progress, re-time the rest for the current speed.
   */
  private retimeWalk(): void {
    const walk = this.agent.walk;
    if (!walk) return;
    const duration = walkMinutes(walk.from, walk.to, this.minutesPerSecond);
    const progress = Math.min(1, Math.max(0, (this.simTime - walk.startedAt) / (walk.endsAt - walk.startedAt)));
    walk.startedAt = this.simTime - progress * duration;
    walk.endsAt = walk.startedAt + duration;
  }

  get idle(): boolean {
    return !this.agent.activity && !this.agent.walk && !this.agent.next;
  }

  state(): EngineState {
    return { simTime: this.simTime, agent: this.agent };
  }

  /** Move time forward, stopping at every walk/activity boundary so effects land on time. */
  advance(minutes: number): void {
    let remaining = minutes;
    while (remaining > 0) {
      const boundary = this.agent.walk?.endsAt ?? this.agent.activity?.endsAt ?? Infinity;
      const step = Math.min(remaining, Math.max(0, boundary - this.simTime));
      this.applyNeeds(step);
      this.simTime += step;
      remaining -= step;
      this.updatePosition();
      if (this.simTime >= boundary) this.finishCurrent();
    }
  }

  /** Start a plan. Walks to the right place first if needed. */
  plan(plan: Plan): { ok: true } | { ok: false; error: string } {
    if (!this.idle) return { ok: false, error: 'busy' };
    const def = ACTIVITIES[plan.kind];
    if (!def) return { ok: false, error: `unknown activity ${plan.kind}` };
    if (plan.kind === 'read' && !plan.bookId) return { ok: false, error: 'read needs a bookId' };
    if (plan.kind === 'browse' && !plan.query) return { ok: false, error: 'browse needs a query' };

    this.agent.thinking = false;
    const from = this.agent.place ?? 'plaza';
    if (from === def.place) {
      this.startActivity(plan);
    } else {
      this.agent.place = null;
      this.agent.next = plan;
      this.agent.walk = {
        from,
        to: def.place,
        path: pathBetween(from, def.place),
        startedAt: this.simTime,
        endsAt: this.simTime + walkMinutes(from, def.place, this.minutesPerSecond),
      };
      this.emit({ type: 'walk_started', data: { from, to: def.place } }, this.simTime);
    }
    return { ok: true };
  }

  private startActivity(plan: Plan): void {
    const def = ACTIVITIES[plan.kind];
    const minutes = plan.kind === 'sleep' ? minutesUntilMorning(this.simTime) : def.minutes;
    this.agent.activity = {
      ...plan,
      place: def.place,
      startedAt: this.simTime,
      endsAt: this.simTime + minutes,
    };
    const bookTitle = plan.bookId ? this.bookTitle(plan.bookId) : undefined;
    this.emit(
      {
        type: 'activity_started',
        data: {
          kind: plan.kind,
          place: def.place,
          ...(bookTitle ? { bookTitle } : {}),
          ...(plan.query ? { query: plan.query } : {}),
        },
      },
      this.simTime,
    );
  }

  private finishCurrent(): void {
    const { walk, activity } = this.agent;
    if (walk) {
      this.agent.walk = null;
      this.agent.place = walk.to;
      this.agent.position = { ...PLACES[walk.to].spot };
      const next = this.agent.next;
      this.agent.next = null;
      if (next) this.startActivity(next);
      return;
    }
    if (activity) {
      this.agent.activity = null;
      this.agent.moodBoost = Math.min(0.3, this.agent.moodBoost + (activity.kind === 'sleep' ? 0.1 : 0.05));
      this.agent.mood = moodFrom(this.agent.needs, this.agent.moodBoost);
      this.emit({ type: 'activity_finished', data: { kind: activity.kind, place: activity.place } }, this.simTime);
    }
  }

  private applyNeeds(minutes: number): void {
    if (minutes <= 0) return;
    const rates = this.agent.activity ? ACTIVITIES[this.agent.activity.kind].rates : IDLE_RATES;
    const hours = minutes / 60;
    const n = this.agent.needs;
    n.energy = clampNeed(n.energy + rates.energy * hours);
    n.satiety = clampNeed(n.satiety + rates.satiety * hours);
    n.fun = clampNeed(n.fun + rates.fun * hours);
    n.social = clampNeed(n.social + rates.social * hours);

    const decay = BOOST_DECAY_PER_HOUR * hours;
    const b = this.agent.moodBoost;
    this.agent.moodBoost = b > 0 ? Math.max(0, b - decay) : Math.min(0, b + decay);
    this.agent.mood = moodFrom(n, this.agent.moodBoost);
  }

  private updatePosition(): void {
    const walk = this.agent.walk;
    if (!walk) return;
    const t = (this.simTime - walk.startedAt) / (walk.endsAt - walk.startedAt);
    this.agent.position = pointAlong(walk.path, t);
  }
}
