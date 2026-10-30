import { useEffect, useState } from 'react';
import { formatClock } from '@ampli-world/shared';
import { AskCard } from './AskCard.tsx';
import { CodeTab } from './Code.tsx';
import { Gallery } from './Gallery.tsx';
import { Mailbox } from './Mailbox.tsx';
import { MindPage } from './Mind.tsx';
import { CritterPreview, SettingsPanel, SetupWizard } from './Setup.tsx';
import { Feed, HowItWorks, MemoryView, StatusCard } from './Panel.tsx';
import { TownCanvas } from './TownCanvas.tsx';
import { useWorld } from './useWorld.ts';
import { BellCard, WorkshopPanel } from './Workshop.tsx';

const TABS = ['Thoughts', 'Mail', 'Art', 'Code', 'Memory'] as const;
type Tab = (typeof TABS)[number] | 'How it works';

/** Whether the town still needs setting up, and whether this viewer may change settings. */
function useSetupStatus() {
  const [status, setStatus] = useState<{ complete: boolean; canConfigure: boolean } | null>(null);
  useEffect(() => {
    fetch('/api/setup/status')
      .then((r) => r.json() as Promise<{ complete: boolean; canConfigure: boolean }>)
      .then(setStatus)
      .catch(() => setStatus({ complete: true, canConfigure: false }));
  }, []);
  return status;
}

export function App() {
  const setup = useSetupStatus();
  if (!setup) return null;
  // `?setup` runs the wizard again (on this Mac only).
  if ((!setup.complete || new URLSearchParams(location.search).has('setup')) && setup.canConfigure) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden>
              🏡
            </span>
            <div>
              <h1>AmpliBuddy</h1>
              <p className="subtitle">set up your town</p>
            </div>
          </div>
        </header>
        <SetupWizard />
      </div>
    );
  }
  return <Town canConfigure={setup.canConfigure} />;
}

function Town({ canConfigure }: { canConfigure: boolean }) {
  const { snapshot, events, diary, notebook, usage, connected, live, bubble, mailVersion, artVersion, codeVersion } = useWorld();
  const [tab, setTab] = useState<Tab>('Thoughts');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mindOpen, setMindOpen] = useState(false);
  const name = snapshot?.persona.name ?? 'Ampli';

  if (mindOpen && snapshot) {
    return (
      <div className="app app-scroll">
        <MindPage persona={snapshot.persona} onClose={() => setMindOpen(false)} />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            {snapshot ? <CritterPreview look={snapshot.persona.look} size={40} /> : '🏡'}
          </span>
          <div>
            <h1>{snapshot ? `${snapshot.persona.town}` : 'AmpliBuddy'}</h1>
            <p className="subtitle">
              {snapshot
                ? `home of ${snapshot.persona.name}, a ${snapshot.persona.species} with an AI for a mind`
                : 'connecting…'}
            </p>
          </div>
        </div>
        <div className="topbar-right">
          <button
            type="button"
            className={`pill-button ${tab === 'How it works' ? 'active' : ''}`}
            aria-pressed={tab === 'How it works'}
            onClick={() => setTab(tab === 'How it works' ? 'Thoughts' : 'How it works')}
          >
            How it works
          </button>
          <button type="button" className="pill-button" onClick={() => setMindOpen(true)} disabled={!snapshot}>
            🧠 Mind
          </button>
          {canConfigure && (
            <button type="button" className="pill-button" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
              ⚙️
            </button>
          )}
          <div className="clock">
            <span className={`dot ${connected ? 'dot-on' : 'dot-off'}`} title={connected ? 'live' : 'reconnecting'} />
            {snapshot ? formatClock(snapshot.simTime) : '—'}
          </div>
        </div>
      </header>

      <main className="layout">
        <div className="main-col">
          <div className="stage">
            <TownCanvas live={live} bubble={bubble} />
          </div>
          {snapshot?.gyros && <WorkshopPanel gyros={snapshot.gyros} events={events} />}
        </div>

        <aside className="side" aria-label={name}>
          {snapshot && <StatusCard snapshot={snapshot} events={events} />}
          {snapshot && <AskCard snapshot={snapshot} />}
          {snapshot?.gyros && <BellCard gyros={snapshot.gyros} name={name} />}

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
            {tab === 'Code' && <CodeTab name={name} codeVersion={codeVersion} />}
            {tab === 'Memory' && <MemoryView diary={diary} notebook={notebook} name={name} />}
            {tab === 'How it works' && <HowItWorks name={name} usage={usage} neighbors={snapshot?.neighbors ?? []} />}
          </section>
        </aside>
      </main>
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
