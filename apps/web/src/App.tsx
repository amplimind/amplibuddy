import { useState } from 'react';
import { formatClock } from '@ampli-world/shared';
import { Gallery } from './Gallery.tsx';
import { Mailbox } from './Mailbox.tsx';
import { DiaryView, Feed, HowItWorks, NotebookView, StatusCard } from './Panel.tsx';
import { TownCanvas } from './TownCanvas.tsx';
import { useWorld } from './useWorld.ts';

const TABS = ['Thoughts', 'Mail', 'Art', 'Diary', 'Notebook', 'How it works'] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const { snapshot, events, diary, notebook, usage, connected, live, bubble, mailVersion, artVersion } = useWorld();
  const [tab, setTab] = useState<Tab>('Thoughts');
  const name = snapshot?.persona.name ?? 'Ampli';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            🦊
          </span>
          <div>
            <h1>{snapshot ? `${snapshot.persona.town}` : 'Ampli World'}</h1>
            <p className="subtitle">
              {snapshot
                ? `home of ${snapshot.persona.name}, a ${snapshot.persona.species} with an AI for a mind`
                : 'connecting…'}
            </p>
          </div>
        </div>
        <div className="clock">
          <span className={`dot ${connected ? 'dot-on' : 'dot-off'}`} title={connected ? 'live' : 'reconnecting'} />
          {snapshot ? formatClock(snapshot.simTime) : '—'}
        </div>
      </header>

      <main className="layout">
        <div className="stage">
          <TownCanvas live={live} bubble={bubble} />
        </div>

        <aside className="side">
          {snapshot && <StatusCard snapshot={snapshot} events={events} />}

          <nav className="tabs" role="tablist">
            {TABS.map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                className={tab === t ? 'tab tab-active' : 'tab'}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </nav>

          <section className="card tab-body" role="tabpanel">
            {tab === 'Thoughts' && <Feed events={events} />}
            {tab === 'Mail' && <Mailbox snapshot={snapshot} mailVersion={mailVersion} />}
            {tab === 'Art' && <Gallery name={name} artVersion={artVersion} />}
            {tab === 'Diary' && <DiaryView diary={diary} name={name} />}
            {tab === 'Notebook' && <NotebookView notebook={notebook} name={name} />}
            {tab === 'How it works' && <HowItWorks name={name} usage={usage} neighbors={snapshot?.neighbors ?? []} />}
          </section>
        </aside>
      </main>
    </div>
  );
}
