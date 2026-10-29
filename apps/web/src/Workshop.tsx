import { useState, type ReactNode } from 'react';
import { formatClock, GYROS_STATIONS, waitedFor, type GyrosRun, type GyrosState, type WorldEvent } from '@ampli-world/shared';

const MAX_ROWS = 5;
const MAX_RECENT = 6;
const OPEN_KEY = 'ampli-workshop-open';
const BELL_KEY = 'ampli-bell-dismissed';
const MAX_BELL_ROWS = 4;

/** Whether this viewer opened the panel last time. Collapsed by default; storage may be unavailable. */
function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function saveOpen(open: boolean) {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    // Not remembered; fine.
  }
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(BELL_KEY);
  } catch {
    return null;
  }
}

/**
 * Ampli's latest workshop bell, in Ampli's column: who waits for what, with links into GyrOS.
 * Gone once those runs move on; a viewer can also dismiss it for themselves.
 */
export function BellCard({ gyros, name }: { gyros: GyrosState; name: string }) {
  const nudge = gyros.nudge;
  const [dismissed, setDismissed] = useState(readDismissed);
  if (!nudge || dismissed === String(nudge.simTime)) return null;
  // Grouped like the workshop panel; the longest wait of each group is the one shown.
  const groups = groupWaiting([...nudge.runs].sort((a, b) => a.waitingSince.localeCompare(b.waitingSince)));
  const dismiss = () => {
    setDismissed(String(nudge.simTime));
    try {
      localStorage.setItem(BELL_KEY, String(nudge.simTime));
    } catch {
      // Hidden for this visit only.
    }
  };
  return (
    <section className="bell-card" aria-label="Workshop bell">
      <div className="bell-head">
        <span className="feed-kicker">🔔 {name} rang the workshop bell</span>
        <button type="button" className="bell-dismiss" onClick={dismiss} aria-label="Dismiss" title="Dismiss">
          ✕
        </button>
      </div>
      <p className="bell-text">“{nudge.text}”</p>
      <ul className="bell-runs">
        {groups.slice(0, MAX_BELL_ROWS).map(({ run: r, count }) => (
          <li key={r.runId}>
            <span className="gyros-name">
              <RunLink uiUrl={gyros.uiUrl} path="needs-input" runId={r.runId}>
                <strong>{runName(r)}</strong>
              </RunLink>
              {count > 1 && <span className="gyros-count">×{count}</span>}
            </span>
            <span className="bell-wait">
              {r.pendingLabel ?? 'input'} · {waitedFor(r.waitingSince)}
            </span>
          </li>
        ))}
      </ul>
      <More hidden={groups.length - MAX_BELL_ROWS} uiUrl={gyros.uiUrl} />
    </section>
  );
}

type GyrosEvent = Extract<WorldEvent, { type: 'gyros' }>;

const stationIcon = (run: GyrosRun) => GYROS_STATIONS.find((s) => s.id === run.station)?.icon ?? '⚙️';

/** "MP-123", plus the workflow when it isn't the usual ticket-to-PR one ("MP-123 · lessons"). */
const runName = (run: { ticketKey: string | null; workflow: string }) =>
  !run.ticketKey ? run.workflow : run.workflow === 'carplan' ? run.ticketKey : `${run.ticketKey} · ${run.workflow}`;

const base = (uiUrl: string) => uiUrl.replace(/\/+$/, '');

function RunLink({ uiUrl, path, runId, children }: { uiUrl: string | null; path: string; runId: string; children: ReactNode }) {
  if (!uiUrl) return <>{children}</>;
  return (
    <a href={`${base(uiUrl)}/${path}/${encodeURIComponent(runId)}`} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/** What a GyrOS change reads like in the workshop log. */
export function gyrosLine(d: GyrosEvent['data']): string {
  const who = d.ticketKey ?? 'A run';
  switch (d.kind) {
    case 'started':
      return `${who} rolled in`;
    case 'step':
      return `${who} → ${d.stepLabel}`;
    case 'needs_you':
      return `${who} waits for ${d.pendingLabel ?? 'input'}`;
    case 'resumed':
      return `${who} is moving again`;
    case 'published':
      return `${who} left the dock as a PR`;
    case 'stopped':
      return `${who} stopped at ${d.stepLabel}`;
    case 'finished':
      return `${who} is done (${d.status})`;
  }
}

/** Runs waiting for the same thing on the same ticket collapse into one row ("×3"). */
function groupWaiting<T extends { ticketKey: string | null; workflow: string; pendingLabel: string | null }>(
  runs: T[],
): { run: T; count: number }[] {
  const groups = new Map<string, { run: T; count: number }>();
  for (const run of runs) {
    const key = `${run.ticketKey}|${run.workflow}|${run.pendingLabel}`;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { run, count: 1 });
  }
  return [...groups.values()];
}

function More({ hidden, uiUrl }: { hidden: number; uiUrl: string | null }) {
  if (hidden <= 0) return null;
  const text = `+${hidden} more`;
  return (
    <p className="hint workshop-more">
      {uiUrl ? (
        <a href={base(uiUrl)} target="_blank" rel="noopener noreferrer">
          {text} in GyrOS
        </a>
      ) : (
        text
      )}
    </p>
  );
}

/**
 * The GyrOS workshop under the map: what waits for a human, what's moving, and what just
 * happened. Read-only; the links open GyrOS itself, where the decisions are made.
 */
export function WorkshopPanel({ gyros, events }: { gyros: GyrosState; events: WorldEvent[] }) {
  const [open, setOpen] = useState(readOpen);
  const toggle = () => {
    setOpen(!open);
    saveOpen(!open);
  };
  const waiting = groupWaiting(gyros.runs.filter((r) => r.pending));
  const waitingRuns = gyros.runs.filter((r) => r.pending).length;
  const moving = gyros.runs.filter((r) => !r.pending);
  const recent = events.filter((e): e is GyrosEvent => e.type === 'gyros').slice(-MAX_RECENT).reverse();

  return (
    <section className="card workshop" aria-label="GyrOS workshop">
      <header className="workshop-head">
        <button type="button" className="workshop-toggle" aria-expanded={open} aria-controls="workshop-body" onClick={toggle}>
          <span className="workshop-chevron" aria-hidden>
            ▸
          </span>
          <h2>⚙️ GyrOS workshop</h2>
        </button>
        {gyros.connected ? (
          <div className="workshop-chips">
            <span className={`chip ${waitingRuns > 0 ? 'chip-alert' : ''}`}>🔔 {waitingRuns} need you</span>
            <span className="chip">{moving.length} on the line</span>
            {gyros.uiUrl && (
              <a className="chip chip-link" href={base(gyros.uiUrl)} target="_blank" rel="noopener noreferrer">
                Open GyrOS ↗
              </a>
            )}
          </div>
        ) : (
          <span className="chip">offline</span>
        )}
      </header>

      {!open ? null : !gyros.connected ? (
        <p className="hint" id="workshop-body">
          GyrOS isn't reachable right now, so the workshop is dark.
        </p>
      ) : (
        <div className="workshop-cols" id="workshop-body">
          <div>
            <h3 className="workshop-col-title">Needs you</h3>
            {waiting.length === 0 ? (
              <p className="hint">Nothing waiting. 🎉</p>
            ) : (
              <ul className="gyros-runs">
                {waiting.slice(0, MAX_ROWS).map(({ run, count }) => (
                  <li key={run.runId} className="gyros-run gyros-waiting">
                    <span className="gyros-name">
                      <RunLink uiUrl={gyros.uiUrl} path="needs-input" runId={run.runId}>
                        <strong>{runName(run)}</strong>
                      </RunLink>
                      {count > 1 && <span className="gyros-count">×{count}</span>}
                    </span>
                    <span className="gyros-step">{run.pendingLabel ?? 'input'}</span>
                    {run.title && <span className="gyros-title">{run.title}</span>}
                  </li>
                ))}
              </ul>
            )}
            <More hidden={waiting.length - MAX_ROWS} uiUrl={gyros.uiUrl} />
          </div>

          <div>
            <h3 className="workshop-col-title">On the line</h3>
            {moving.length === 0 ? (
              <p className="hint">No tickets moving.</p>
            ) : (
              <ul className="gyros-runs">
                {moving.slice(0, MAX_ROWS).map((run) => (
                  <li key={run.runId} className={`gyros-run ${run.status === 'watching' ? 'gyros-watching' : ''}`}>
                    <span className="gyros-name">
                      <RunLink uiUrl={gyros.uiUrl} path="runs" runId={run.runId}>
                        <strong>{runName(run)}</strong>
                      </RunLink>
                    </span>
                    <span className="gyros-step">
                      {stationIcon(run)} {run.stepLabel}
                      {run.busy && <span className="gyros-busy" title="Working right now" />}
                    </span>
                    {run.title && <span className="gyros-title">{run.title}</span>}
                  </li>
                ))}
              </ul>
            )}
            <More hidden={moving.length - MAX_ROWS} uiUrl={gyros.uiUrl} />
          </div>

          <div>
            <h3 className="workshop-col-title">Just happened</h3>
            {recent.length === 0 ? (
              <p className="hint">Quiet since the town started watching.</p>
            ) : (
              <ol className="workshop-log">
                {recent.map((e) => (
                  <li key={e.id} className={e.data.kind === 'needs_you' ? 'workshop-log-alert' : ''}>
                    <span className="feed-time">{formatClock(e.simTime)}</span> {gyrosLine(e.data)}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
