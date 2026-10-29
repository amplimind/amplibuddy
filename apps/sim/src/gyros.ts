import {
  GYROS_ACTIVE_STATUSES,
  gyrosPendingLabel,
  gyrosStation,
  gyrosStepLabel,
  type EventBody,
  type GyrosEventKind,
  type GyrosNudge,
  type GyrosRun,
  type GyrosState,
} from '@ampli-world/shared';

// Read-only bridge to a local GyrOS. Only GETs /runs and listens to /runs/stream;
// never calls anything that changes GyrOS. Only whitelisted fields leave this file.

const POLL_MS = 15_000;
const DEBOUNCE_MS = 500;
const TIMEOUT_MS = 10_000;

type RawRun = Record<string, unknown>;

/** What the bridge remembers across restarts: which wait each run was rung for, and the last bell. */
export interface NudgeMemory {
  nudged: Record<string, string>;
  last: GyrosNudge | null;
}

export interface BridgeOptions {
  /** Ring the bell for runs waiting at least this long (real ms). 0 = never. */
  nudgeAfterMs?: number;
  memory?: { load(): NudgeMemory | null; save(memory: NudgeMemory): void };
  now?: () => number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The whitelist: everything else in GyrOS's run summary (costs, errors, owners, …) is dropped. */
export function toGyrosRun(raw: RawRun): GyrosRun | null {
  const runId = str(raw.run_id);
  const status = str(raw.status);
  if (!runId || !status) return null;
  const node = str(raw.current_node);
  const pending = status === 'waiting' ? str(raw.pending_kind) : null;
  const pr = str(raw.pr_url);
  return {
    runId,
    workflow: str(raw.workflow) ?? 'run',
    ticketKey: str(raw.ticket_key),
    title: str(raw.ticket_summary)?.slice(0, 140) ?? null,
    status,
    node,
    station: gyrosStation(status, node),
    stepLabel: gyrosStepLabel(status, node),
    pending,
    pendingLabel: gyrosPendingLabel(pending),
    round: typeof raw.round === 'number' ? raw.round : 0,
    busy: raw.busy === true,
    prUrl: pr && /^https:\/\//.test(pr) ? pr : null,
    waitingSince: str(raw.waiting_since),
    updatedAt: str(raw.updated_at) ?? '',
    overdue: false,
  };
}

/** What changed between two looks at a run, as at most one event worth telling. */
export function transition(before: GyrosRun | undefined, after: GyrosRun): GyrosEventKind | null {
  const active = GYROS_ACTIVE_STATUSES.includes(after.status);
  if (!before) return active ? 'started' : null;
  if (after.status !== before.status) {
    if (after.status === 'stopped') return 'stopped';
    if (after.status === 'published' || (after.status === 'watching' && before.status !== 'watching')) return 'published';
    if (after.status === 'waiting' && after.pending) return 'needs_you';
    if (before.status === 'waiting' && after.status === 'running') return 'resumed';
    if (!active) return 'finished';
  }
  if (after.pending && after.pending !== before.pending) return 'needs_you';
  if (after.status === 'running' && after.station !== before.station) return 'step';
  return null;
}

export class GyrosBridge {
  private runs = new Map<string, GyrosRun>();
  private connected = false;
  private primed = false;
  private timer: NodeJS.Timeout | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private streamAbort: AbortController | undefined;
  private stopped = false;
  private readonly nudgeAfterMs: number;
  private readonly now: () => number;
  /** runId → the waitingSince of the wait Ampli already rang the bell for. */
  private nudged = new Map<string, string>();
  private lastNudge: GyrosNudge | null = null;

  constructor(
    private readonly apiUrl: string,
    private readonly uiUrl: string | null,
    private readonly log: (body: EventBody) => void,
    private readonly options: BridgeOptions = {},
  ) {
    this.nudgeAfterMs = options.nudgeAfterMs ?? 0;
    this.now = options.now ?? Date.now;
    const memory = options.memory?.load();
    if (memory) {
      this.nudged = new Map(Object.entries(memory.nudged));
      this.lastNudge = memory.last;
    }
  }

  state(): GyrosState {
    const runs = [...this.runs.values()]
      .filter((r) => GYROS_ACTIVE_STATUSES.includes(r.status))
      .map((r) => ({ ...r, overdue: this.isOverdue(r) }))
      .sort((a, b) => Number(!!b.pending) - Number(!!a.pending) || b.updatedAt.localeCompare(a.updatedAt));
    return { connected: this.connected, uiUrl: this.uiUrl, runs, nudge: this.currentNudge() };
  }

  private isOverdue(run: GyrosRun): boolean {
    if (!run.pending || !run.waitingSince || this.nudgeAfterMs <= 0) return false;
    const since = Date.parse(run.waitingSince);
    return Number.isFinite(since) && this.now() - since >= this.nudgeAfterMs && this.nudged.get(run.runId) !== run.waitingSince;
  }

  /** Still-waiting runs of the last bell; once they've all moved on, the bell is over. */
  private currentNudge(): GyrosNudge | null {
    if (!this.lastNudge) return null;
    const runs = this.lastNudge.runs.filter((n) => {
      const run = this.runs.get(n.runId);
      return !!run?.pending && run.waitingSince === n.waitingSince;
    });
    return runs.length > 0 ? { ...this.lastNudge, runs } : null;
  }

  /**
   * Ampli rang the bell. Only runs that are overdue right now count, and each wait is rung
   * for once. Returns null when none of them is (still) overdue.
   */
  nudge(runIds: string[], text: string, simTime: number): GyrosNudge | null {
    const runs = runIds
      .map((id) => this.runs.get(id))
      .filter((r): r is GyrosRun => !!r && this.isOverdue(r))
      .map((r) => ({
        runId: r.runId,
        ticketKey: r.ticketKey,
        workflow: r.workflow,
        title: r.title,
        pendingLabel: r.pendingLabel,
        waitingSince: r.waitingSince!,
      }));
    if (runs.length === 0) return null;
    for (const r of runs) this.nudged.set(r.runId, r.waitingSince);
    this.lastNudge = { text, simTime, runs };
    this.remember();
    return this.lastNudge;
  }

  private remember(): void {
    this.options.memory?.save({ nudged: Object.fromEntries(this.nudged), last: this.lastNudge });
  }

  start(): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), POLL_MS);
    void this.listen();
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.debounce);
    this.streamAbort?.abort();
  }

  /** Fetch /runs and log what changed. The first look only sets the baseline. */
  async refresh(): Promise<void> {
    try {
      const res = await fetch(`${this.apiUrl}/runs`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`GyrOS /runs ${res.status}`);
      const raw = (await res.json()) as unknown;
      this.apply(Array.isArray(raw) ? (raw as RawRun[]) : []);
      if (!this.connected) console.log(`[sim] GyrOS connected at ${this.apiUrl}`);
      this.connected = true;
    } catch (err) {
      if (this.connected) console.warn(`[sim] GyrOS unreachable: ${(err as Error).message}`);
      this.connected = false;
    }
  }

  apply(rawRuns: RawRun[]): void {
    const next = new Map<string, GyrosRun>();
    for (const raw of rawRuns) {
      const run = toGyrosRun(raw);
      if (run) next.set(run.runId, run);
    }
    if (this.primed) {
      for (const run of next.values()) {
        const kind = transition(this.runs.get(run.runId), run);
        if (kind) this.log({ type: 'gyros', data: eventData(kind, run) });
      }
    }
    this.runs = next;
    this.primed = true;
    // A run that stopped waiting (or waits for something new) can be rung for again later.
    let forgot = false;
    for (const [id, since] of this.nudged) {
      const run = next.get(id);
      if (!run?.pending || run.waitingSince !== since) forgot = this.nudged.delete(id) || forgot;
    }
    if (forgot) this.remember();
  }

  /** GyrOS's board stream only says "something changed"; we refetch, debounced. */
  private async listen(): Promise<void> {
    let backoff = 2_000;
    while (!this.stopped) {
      this.streamAbort = new AbortController();
      try {
        const res = await fetch(`${this.apiUrl}/runs/stream`, {
          headers: { accept: 'text/event-stream' },
          signal: this.streamAbort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        backoff = 2_000;
        const decoder = new TextDecoder();
        for await (const chunk of res.body) {
          if (/^event: (?!ping|hello)/m.test(decoder.decode(chunk as Uint8Array, { stream: true }))) this.scheduleRefresh();
        }
      } catch {
        // Stream down: polling keeps things fresh; retry with backoff.
      }
      if (this.stopped) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  private scheduleRefresh(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.refresh(), DEBOUNCE_MS);
  }
}

function eventData(kind: GyrosEventKind, run: GyrosRun) {
  return {
    kind,
    runId: run.runId,
    ticketKey: run.ticketKey,
    title: run.title,
    station: run.station,
    stepLabel: run.stepLabel,
    ...(run.pendingLabel ? { pendingLabel: run.pendingLabel } : {}),
    round: run.round,
    status: run.status,
  };
}
