import { useEffect, useState, type ReactNode } from 'react';
import {
  TIME_CATEGORIES,
  contentWords,
  type Interest,
  type KnowledgeItem,
  type MindDay,
  type MindView,
  type Persona,
} from '@ampli-world/shared';
import { CritterPreview } from './Setup.tsx';

// The Mind page: how the character develops. An overview with the essentials, and a tab
// each for the details: memory night by night, what it learned, its days. Read-only.

const TABS = ['Overview', 'Memory', 'Knowledge', 'Days'] as const;
type MindTab = (typeof TABS)[number];

function hoursLabel(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = minutes / 60;
  return `${h >= 10 ? Math.round(h) : Math.round(h * 2) / 2} h`;
}

function Section({ title, onMore, more, children }: { title: string; onMore?: () => void; more?: string; children: ReactNode }) {
  return (
    <section className="card mind-section">
      <header className="mind-section-head">
        <h2 className="section-title">{title}</h2>
        {onMore && (
          <button type="button" className="link" onClick={onMore}>
            {more ?? 'See all'} →
          </button>
        )}
      </header>
      {children}
    </section>
  );
}

// --- Stats ----------------------------------------------------------------------------------

function Stats({ stats }: { stats: MindView['stats'] }) {
  const tiles: [string, number, string][] = [
    ['📖', stats.booksRead, 'readings'],
    ['🔎', stats.searches, 'searches'],
    ['🎨', stats.paintings, 'paintings'],
    ['⌨️', stats.websites, 'websites'],
    ['🔨', stats.builds, 'built in town'],
    ['✉️', stats.letters, 'letters'],
    ['💬', stats.chats, 'chats'],
  ];
  return (
    <div className="mind-stats">
      {tiles.map(([icon, n, label]) => (
        <div key={label} className="mind-stat">
          <span className="mind-stat-n">
            <span aria-hidden>{icon}</span> {n}
          </span>
          <span className="hint">{label}</span>
        </div>
      ))}
    </div>
  );
}

// --- Interests ------------------------------------------------------------------------------

/** One small line per interest: how often it came up, day by day. */
function Sparkline({ interest, days }: { interest: Interest; days: number[] }) {
  const w = 140;
  const h = 28;
  const max = Math.max(1, ...interest.perDay);
  const x = (i: number) => 4 + (i / Math.max(1, interest.perDay.length - 1)) * (w - 8);
  const y = (v: number) => h - 4 - (v / max) * (h - 8);
  const last = interest.perDay.length - 1;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label={`“${interest.word}” day by day`}>
      <line x1={4} x2={w - 4} y1={h - 4} y2={h - 4} className="spark-base" />
      <polyline points={interest.perDay.map((v, i) => `${x(i)},${y(v)}`).join(' ')} className="spark-line" />
      <circle cx={x(last)} cy={y(interest.perDay[last]!)} r={3} className="spark-dot" />
      {interest.perDay.map((v, i) => (
        // Bigger than the mark, so hovering is easy.
        <rect key={i} x={x(i) - 7} y={0} width={14} height={h} className="spark-hit">
          <title>
            Day {days[i]}: {v} {v === 1 ? 'time' : 'times'}
          </title>
        </rect>
      ))}
    </svg>
  );
}

function Interests({ view, limit }: { view: MindView; limit: number }) {
  if (view.interests.length === 0) return <p className="empty">Too early to tell. Interests show up after a few days.</p>;
  return (
    <>
      <ol className="interests">
        {view.interests.slice(0, limit).map((i) => (
          <li key={i.word}>
            <span className="interest-word">{i.word}</span>
            <Sparkline interest={i} days={view.interestDays} />
            <span className="interest-total">{i.total}×</span>
            <span>{i.rising && <span className="chip chip-rising">rising</span>}</span>
          </li>
        ))}
      </ol>
      <p className="hint">
        How often each comes up in thoughts, searches, notes, paintings and code, day {view.interestDays[0]} to{' '}
        {view.interestDays.at(-1)}.
      </p>
    </>
  );
}

// --- Memory ---------------------------------------------------------------------------------

/** Same note, maybe reworded: enough shared meaningful words. */
function similar(a: string, b: string): boolean {
  const x = contentWords(a);
  const y = contentWords(b);
  if (x.size === 0 || y.size === 0) return false;
  return [...x].filter((w) => y.has(w)).length / Math.min(x.size, y.size) >= 0.5;
}

type NoteState = 'kept' | 'new' | 'changed' | 'forgotten';

/** One night's notebook against the night before. */
function night(view: MindView, index: number) {
  const current = view.memory[index]!;
  const previous = index > 0 ? view.memory[index - 1]!.notes : [];
  const notes = current.notes.map((note): { note: string; state: NoteState } => {
    if (index === 0 || previous.includes(note)) return { note, state: 'kept' };
    return { note, state: previous.some((p) => similar(p, note)) ? 'changed' : 'new' };
  });
  const forgotten = previous
    .filter((p) => !current.notes.includes(p) && !current.notes.some((n) => similar(p, n)))
    .map((note) => ({ note, state: 'forgotten' as const }));
  return { day: current.day, notes, forgotten };
}

const BADGE: Record<Exclude<NoteState, 'kept'>, string> = { new: 'new', changed: 'reworded', forgotten: 'forgotten' };

function NoteList({ items }: { items: { note: string; state: NoteState }[] }) {
  return (
    <ul className="memory-notes">
      {items.map(({ note, state }) => (
        <li key={`${state}-${note}`} className={`memory-${state}`}>
          {state !== 'kept' && <span className={`memory-badge memory-badge-${state}`}>{BADGE[state]}</span>}
          {note}
        </li>
      ))}
    </ul>
  );
}

function ChangeCounts({ n }: { n: ReturnType<typeof night> }) {
  const count = (s: NoteState) => n.notes.filter((x) => x.state === s).length;
  return (
    <span className="hint">
      {count('new')} new · {count('changed')} reworded · {n.forgotten.length} forgotten · {n.notes.length} notes kept in all
    </span>
  );
}

/** Overview: only what changed last night. */
function LastNight({ view }: { view: MindView }) {
  if (view.memory.length < 2) return <p className="empty">The notebook changes after the first nights.</p>;
  const n = night(view, view.memory.length - 1);
  const changes = [...n.notes.filter((x) => x.state !== 'kept'), ...n.forgotten];
  return (
    <>
      <p className="mind-night">
        Night of day {n.day} <ChangeCounts n={n} />
      </p>
      {changes.length === 0 ? <p className="empty">Nothing changed that night.</p> : <NoteList items={changes.slice(0, 5)} />}
      {changes.length > 5 && <p className="hint">and {changes.length - 5} more changes</p>}
    </>
  );
}

function Memory({ view, name }: { view: MindView; name: string }) {
  const [index, setIndex] = useState(Math.max(0, view.memory.length - 1));
  const [whole, setWhole] = useState(false);
  if (view.memory.length === 0) return <p className="empty">The notebook is still empty. The first notes appear after the first night.</p>;
  const n = night(view, index);
  const shown = whole ? [...n.notes, ...n.forgotten] : [...n.notes.filter((x) => x.state !== 'kept'), ...n.forgotten];
  return (
    <>
      <p className="hint">
        The notebook is {name}'s only long-term memory, rewritten every night: things get added, reworded, forgotten.
      </p>
      <div className="memory-slider">
        <input type="range" min={0} max={view.memory.length - 1} value={index} onChange={(e) => setIndex(Number(e.target.value))} aria-label="Night" />
        <div className="row">
          <span className="mind-night">Night of day {n.day}</span>
          {index > 0 && <ChangeCounts n={n} />}
        </div>
      </div>
      <div className="segmented" role="tablist">
        <button type="button" role="tab" aria-selected={!whole} className={!whole ? 'active' : ''} onClick={() => setWhole(false)}>
          Only changes
        </button>
        <button type="button" role="tab" aria-selected={whole} className={whole ? 'active' : ''} onClick={() => setWhole(true)}>
          Whole notebook
        </button>
      </div>
      {shown.length === 0 ? <p className="empty">Nothing changed that night.</p> : <NoteList items={shown} />}
    </>
  );
}

// --- Knowledge ------------------------------------------------------------------------------

const KINDS: { id: KnowledgeItem['kind'] | 'all'; label: string; icon: string }[] = [
  { id: 'all', label: 'Everything', icon: '✨' },
  { id: 'book', label: 'Books', icon: '📖' },
  { id: 'web', label: 'The web', icon: '🔎' },
  { id: 'letter', label: 'Letters', icon: '✉️' },
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function KnowledgeCards({ items, compact }: { items: KnowledgeItem[]; compact?: boolean }) {
  return (
    <div className={compact ? 'knowledge knowledge-compact' : 'knowledge'}>
      {items.map((k, i) => (
        <article key={`${k.kind}-${k.day}-${i}`} className={`knowledge-card knowledge-${k.kind}`}>
          <span className="feed-kicker">
            {KINDS.find((x) => x.id === k.kind)?.icon} {k.title}
          </span>
          <span className="feed-time">day {k.day}</span>
          <p>{k.text}</p>
          {k.sources && k.sources.length > 0 && (
            <ul className="sources">
              {k.sources.map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={s.title}>
                    {hostOf(s.url)}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </div>
  );
}

function Knowledge({ view }: { view: MindView }) {
  const [kind, setKind] = useState<KnowledgeItem['kind'] | 'all'>('all');
  const [shown, setShown] = useState(12);
  const items = view.knowledge.filter((k) => kind === 'all' || k.kind === kind);
  return (
    <>
      <div className="segmented" role="tablist">
        {KINDS.map((k) => {
          const n = k.id === 'all' ? view.knowledge.length : view.knowledge.filter((x) => x.kind === k.id).length;
          return (
            <button
              key={k.id}
              type="button"
              role="tab"
              aria-selected={kind === k.id}
              className={kind === k.id ? 'active' : ''}
              onClick={() => {
                setKind(k.id);
                setShown(12);
              }}
            >
              {k.icon} {k.label} <span className="segmented-n">{n}</span>
            </button>
          );
        })}
      </div>
      {items.length === 0 ? <p className="empty">Nothing here yet.</p> : <KnowledgeCards items={items.slice(0, shown)} />}
      {items.length > shown && (
        <button type="button" className="pill-button" onClick={() => setShown(shown + 24)}>
          Show more ({items.length - shown})
        </button>
      )}
    </>
  );
}

// --- Days -----------------------------------------------------------------------------------

function Legend() {
  return (
    <div className="mind-legend" aria-hidden>
      {TIME_CATEGORIES.map((c) => (
        <span key={c.id}>
          <span className={`swatch cat-${c.id}`} />
          {c.label}
        </span>
      ))}
    </div>
  );
}

function awake(day: MindDay): number {
  return TIME_CATEGORIES.reduce((sum, c) => sum + day.minutes[c.id], 0);
}

function DayBar({ day }: { day: MindDay }) {
  const parts = TIME_CATEGORIES.filter((c) => day.minutes[c.id] > 0);
  if (parts.length === 0) return <span className="day-bar day-bar-empty" />;
  return (
    <span className="day-bar" role="img" aria-label={parts.map((c) => `${c.label} ${hoursLabel(day.minutes[c.id])}`).join(', ')}>
      {parts.map((c) => (
        <span key={c.id} className={`day-seg cat-${c.id}`} style={{ flexGrow: day.minutes[c.id] }} title={`${c.label}: ${hoursLabel(day.minutes[c.id])}`} />
      ))}
    </span>
  );
}

/** "📖2 🎨1": what a day held, at a glance. */
function iconSummary(day: MindDay): string {
  const counts = new Map<string, number>();
  for (const h of day.highlights) counts.set(h.icon, (counts.get(h.icon) ?? 0) + 1);
  return [...counts].map(([icon, n]) => (n > 1 ? `${icon}${n}` : icon)).join(' ');
}

/** The same numbers as the bar, as text: colour is never the only way to read it. */
function splitText(day: MindDay): string {
  return TIME_CATEGORIES.filter((c) => day.minutes[c.id] > 0)
    .map((c) => ({ c, m: day.minutes[c.id] }))
    .sort((a, b) => b.m - a.m)
    .map(({ c, m }) => `${c.label} ${hoursLabel(m)}`)
    .join(' · ');
}

function DayRow({ day, open }: { day: MindDay; open?: boolean }) {
  return (
    <details className="day-row" open={open}>
      <summary>
        <span className="day-label">Day {day.day}</span>
        <DayBar day={day} />
        <span className="day-icons" aria-label={`${day.highlights.length} things that day`}>
          {iconSummary(day)}
        </span>
      </summary>
      <div className="day-detail">
        {awake(day) > 0 && <p className="day-split">{splitText(day)}</p>}
        {day.highlights.length > 0 && (
          <ul className="day-highlights">
            {day.highlights.map((h, i) => (
              <li key={i}>
                <span aria-hidden>{h.icon}</span> {h.text}
              </li>
            ))}
          </ul>
        )}
        {day.diary && (
          <blockquote className="day-diary">
            {day.diary.split(/\n+/).map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </blockquote>
        )}
      </div>
    </details>
  );
}

function DayRows({ days }: { days: MindDay[] }) {
  return (
    <>
      <Legend />
      <div className="day-rows">
        {days.map((d) => (
          <DayRow key={d.day} day={d} />
        ))}
      </div>
      <p className="hint">Awake time only. Click a day for what happened and the diary.</p>
    </>
  );
}

function Days({ view }: { view: MindView }) {
  const [shown, setShown] = useState(14);
  return (
    <>
      <DayRows days={view.days.slice(0, shown)} />
      {view.days.length > shown && (
        <button type="button" className="pill-button" onClick={() => setShown(shown + 14)}>
          Earlier days ({view.days.length - shown})
        </button>
      )}
    </>
  );
}

// --- The page -------------------------------------------------------------------------------

function Overview({ view, name, go }: { view: MindView; name: string; go: (tab: MindTab) => void }) {
  const neighbors = view.neighbors.filter((n) => n.notes.length > 0);
  return (
    <>
      <Stats stats={view.stats} />
      <div className="mind-grid">
        <Section title={`On ${name}'s mind`}>
          <Interests view={view} limit={6} />
        </Section>
        <Section title="Memory: last night" onMore={() => go('Memory')} more="Every night">
          <LastNight view={view} />
        </Section>
      </div>
      <Section title="This week" onMore={() => go('Days')} more="All days">
        <DayRows days={view.days.slice(0, 7)} />
      </Section>
      <div className="mind-grid">
        <Section title="Recently learned" onMore={() => go('Knowledge')} more={`All ${view.knowledge.length}`}>
          {view.knowledge.length === 0 ? <p className="empty">Nothing yet.</p> : <KnowledgeCards items={view.knowledge.slice(0, 3)} compact />}
        </Section>
        {neighbors.map((n) => (
          <Section key={n.id} title={`What ${n.name} remembers about ${name}`}>
            <div className="mind-neighbor">
              <CritterPreview look={n.look} size={44} />
              <ul>
                {n.notes.slice(0, 5).map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </div>
          </Section>
        ))}
      </div>
    </>
  );
}

export function MindPage({ persona, onClose }: { persona: Persona; onClose: () => void }) {
  const [view, setView] = useState<MindView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<MindTab>('Overview');
  useEffect(() => {
    fetch('/api/mind')
      .then((r) => (r.ok ? (r.json() as Promise<MindView>) : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setView)
      .catch((err: Error) => setError(err.message));
  }, []);
  const name = persona.name;
  const go = (t: MindTab) => {
    setTab(t);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="mind">
      <header className="mind-head">
        <div className="mind-who">
          <CritterPreview look={persona.look} size={64} />
          <div>
            <h2>{name}'s mind</h2>
            <p className="hint">
              {view ? `Day ${view.today} in ${persona.town}` : '…'} · a {persona.species}
            </p>
          </div>
        </div>
        <button type="button" className="pill-button" onClick={onClose}>
          ← Back to town
        </button>
      </header>
      <nav className="tabs mind-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'tab tab-active' : 'tab'} onClick={() => go(t)}>
            {t}
          </button>
        ))}
      </nav>
      {error && <p className="error">{error}</p>}
      {!view && !error && <p className="hint">Gathering memories…</p>}
      {view && tab === 'Overview' && <Overview view={view} name={name} go={go} />}
      {view && tab === 'Memory' && (
        <Section title="Memory over time">
          <Memory view={view} name={name} />
        </Section>
      )}
      {view && tab === 'Knowledge' && (
        <Section title={`What ${name} has learned`}>
          <Knowledge view={view} />
        </Section>
      )}
      {view && tab === 'Days' && (
        <Section title={`${name}'s days`}>
          <Days view={view} />
        </Section>
      )}
    </div>
  );
}
