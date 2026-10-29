import {
  ACTIVITIES,
  ACTIVITY_KINDS,
  hourOf,
  isNight,
  ANSWER_OVERDUE_MINUTES,
  MAIL_OVERDUE_MINUTES,
  minutesUntilMorning,
  type ActivityKind,
  type BrainContext,
  type DecisionRequest,
  type Needs,
  type ThoughtSource,
  waitedFor,
} from '@ampli-world/shared';

// The cheap half of the brain. Bodily needs and bedtime are handled by rules,
// so the LLM is only asked when there is a real choice to make.

const ROUTINE_THOUGHTS: Partial<Record<ActivityKind, string[]>> = {
  sleep: ["It's late. My eyes are closing on their own — bed.", 'Time to curl up. Today was enough.'],
  nap: ['I can barely keep my eyes open. Quick nap.', 'Running on empty. A short nap first.'],
  eat: ['My stomach is growling. Food, now.', "I can't think on an empty stomach. To the café!"],
  check_mail: ["Letters have been waiting a while. Time to check the post box.", 'Someone wrote to me and I keep putting it off. Post box!'],
};

const OFFLINE_THOUGHTS: Record<ActivityKind, string[]> = {
  sleep: ['Bedtime.'],
  nap: ['A little rest sounds good.'],
  eat: ["I'm getting peckish. Something to eat."],
  coffee: ['A coffee would sharpen me up.', 'Coffee first, ideas later.'],
  stroll: ['I want some fresh air. Park!', 'Legs need stretching. Off to the pond.'],
  think: ["I'll sit on the bench and let my thoughts wander.", 'Bench time. Some things need mulling over.'],
  read: ['I feel like reading something.', 'The library is calling.'],
  people_watch: ["Let's see what's happening at the plaza.", 'I want to be around a bit of bustle.'],
  check_mail: ['Let me see if anyone wrote to me.'],
  browse: ['I want to look something up.'],
  paint: ['I feel like making something.'],
  chat: ['I could use some company.'],
  post_note: ['Maybe someone out there wants to write to me.'],
  visit_workshop: ["Let's see what GyrOS is up to."],
};

function pick<T>(items: T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!;
}

function decision(kind: ActivityKind, text: string, source: ThoughtSource, bookId?: string): DecisionRequest {
  return { plan: bookId ? { kind, bookId } : { kind }, thought: { text, source } };
}

/**
 * Activities that make sense to offer right now: sleep only in the evening, mail only
 * when there is some, browsing only when the web is allowed and the daily cap isn't hit.
 */
export function availableActivities(
  simTime: number,
  opts: {
    mailWaiting?: number;
    canBrowse?: boolean;
    canPaint?: boolean;
    canChat?: boolean;
    canPostNote?: boolean;
    canVisitWorkshop?: boolean;
  } = {},
): ActivityKind[] {
  const h = hourOf(simTime);
  const evening = h >= 20 || h < 5;
  return ACTIVITY_KINDS.filter((k) => {
    if (k === 'sleep') return evening;
    if (k === 'check_mail') return (opts.mailWaiting ?? 0) > 0;
    if (k === 'browse') return opts.canBrowse === true;
    if (k === 'paint') return opts.canPaint === true;
    // Whether a neighbour is actually there right now is decided by the caller (opening hours).
    if (k === 'chat') return opts.canChat === true;
    if (k === 'post_note') return opts.canPostNote === true;
    if (k === 'visit_workshop') return opts.canVisitWorkshop === true;
    return true;
  });
}

/** Has the oldest letter in the post box waited too long? */
export function mailOverdue(ctx: BrainContext): boolean {
  const { oldestSimTime, oldestAnswerSimTime } = ctx.mail;
  const now = ctx.snapshot.simTime;
  // Answers to Ampli's own questions are worth hurrying for.
  if (oldestAnswerSimTime !== null && now - oldestAnswerSimTime >= ANSWER_OVERDUE_MINUTES) return true;
  return oldestSimTime !== null && now - oldestSimTime >= MAIL_OVERDUE_MINUTES;
}

/** The GyrOS run that has waited longest past the threshold, if any. */
export function longestOverdue(ctx: BrainContext) {
  const overdue = ctx.snapshot.gyros?.connected ? ctx.snapshot.gyros.runs.filter((r) => r.overdue && r.waitingSince) : [];
  return overdue.sort((a, b) => a.waitingSince!.localeCompare(b.waitingSince!))[0];
}

/**
 * Rules that override free choice. Returns null when there's a real choice to make.
 * Overdue mail only counts when Ampli can actually answer it (an LLM is available).
 * The workshop bell is rung even without an LLM: it falls back to plain facts.
 */
export function routineDecision(
  ctx: BrainContext,
  opts: { canAnswerMail?: boolean; canRingBell?: boolean } = {},
  random = Math.random,
): DecisionRequest | null {
  const { simTime, agent } = ctx.snapshot;
  const overdue = opts.canRingBell ? longestOverdue(ctx) : undefined;
  const kind: ActivityKind | null = isNight(simTime)
    ? 'sleep'
    : agent.needs.energy < 15
      ? 'nap'
      : agent.needs.satiety < 20
        ? 'eat'
        : overdue
          ? 'visit_workshop'
          : opts.canAnswerMail && mailOverdue(ctx)
            ? 'check_mail'
            : null;
  if (kind === 'visit_workshop' && overdue) {
    const who = overdue.ticketKey ?? 'A GyrOS run';
    const text = `${who} has been waiting ${waitedFor(overdue.waitingSince!)} for ${overdue.pendingLabel ?? 'a human'}. I'll go ring the workshop bell.`;
    return decision(kind, text, 'routine');
  }
  return kind ? decision(kind, pick(ROUTINE_THOUGHTS[kind]!, random), 'routine') : null;
}

export function leastReadBook(ctx: BrainContext): string | undefined {
  return [...ctx.books].sort((a, b) => a.timesRead - b.timesRead)[0]?.id;
}

/** What was the character doing last? Used to avoid doing the same thing twice in a row. */
export function lastActivity(ctx: BrainContext): ActivityKind | undefined {
  for (let i = ctx.recentEvents.length - 1; i >= 0; i--) {
    const e = ctx.recentEvents[i]!;
    if (e.type === 'activity_started') return e.data.kind;
  }
  return undefined;
}

/** How much an activity would help: gain per need (capped at the deficit), weighted by urgency². */
export function utility(kind: ActivityKind, needs: Needs, simTime: number): number {
  const def = ACTIVITIES[kind];
  const hours = (kind === 'sleep' ? minutesUntilMorning(simTime) : def.minutes) / 60;
  let score = 0;
  for (const key of ['energy', 'satiety', 'fun', 'social'] as const) {
    const deficit = 100 - needs[key];
    const gain = Math.min(deficit, Math.max(0, def.rates[key]) * hours);
    score += gain * (deficit / 100) ** 2;
  }
  return score;
}

/**
 * Utility-based choice with no LLM: used without an API key, over budget,
 * or when the model call fails. Most helpful option wins, with some jitter
 * and a penalty for repeating the last activity.
 */
export function offlineDecision(ctx: BrainContext, random = Math.random): DecisionRequest {
  const { simTime, agent } = ctx.snapshot;
  const previous = lastActivity(ctx);
  const options = availableActivities(simTime).filter((k) => k !== 'read' || ctx.books.length > 0);

  let best: ActivityKind = 'stroll';
  let bestScore = -Infinity;
  for (const kind of options) {
    const score = utility(kind, agent.needs, simTime) + random() * 6 - (kind === previous ? 8 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = kind;
    }
  }
  const bookId = best === 'read' ? leastReadBook(ctx) : undefined;
  return decision(best, pick(OFFLINE_THOUGHTS[best], random), 'offline', bookId);
}
