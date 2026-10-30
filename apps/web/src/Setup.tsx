import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  LOOKS,
  LOOK_INFO,
  MAX_PERSONALITY_CHARS,
  MAX_SETUP_NAME_CHARS,
  MAX_SETUP_SPECIES_CHARS,
  GYROS_DEFAULTS,
  PLACES,
  RESIDENT_PLACES,
  localAlias,
  type GitProbe,
  type GyrosProbe,
  type Look,
  type OllamaStatus,
  type PersonaDraft,
  type PersonalityTemplate,
  type ResidentDraft,
  type SetupApply,
  type SetupState,
} from '@ampli-world/shared';
import { drawCritter } from './critters.ts';
import { LibraryEditor } from './Library.tsx';

// The setup wizard (first start) and the settings page (⚙️ later). Both edit the same
// things and save them in one go; the town then restarts with the new setup.

const SPEEDS = [
  { value: 0.1, label: 'Calm: a day takes 4 hours' },
  { value: 1, label: 'Lively: a day takes 24 minutes' },
  { value: 1 / 60, label: 'Real time: a day takes a day' },
];

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Saves, then waits for the town to come back after its restart and reloads the page. */
async function applyAndReload(body: SetupApply): Promise<void> {
  await postJson('/api/setup/apply', body);
  await new Promise((r) => setTimeout(r, 2500));
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch('/api/state')).ok) break;
    } catch {
      // Still restarting.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  location.reload();
}

// --- Small pieces ------------------------------------------------------------------------

export function CritterPreview({ look, size = 56, sleeping = false }: { look: Look; size?: number; sleeping?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.height = Math.round(size * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const scale = size / 40;
    drawCritter(ctx, look, size / 2 + 2 * scale, size / 2 + 3 * scale, { scale, sleeping });
  }, [look, size, sleeping]);
  return <canvas ref={ref} style={{ width: size, height: size }} aria-hidden />;
}

function LookPicker({ value, onChange }: { value: Look; onChange: (look: Look) => void }) {
  return (
    <div className="look-grid" role="radiogroup" aria-label="Animal">
      {LOOKS.map((look) => (
        <button
          key={look}
          type="button"
          role="radio"
          aria-checked={value === look}
          className={`look-option ${value === look ? 'selected' : ''}`}
          onClick={() => onChange(look)}
        >
          <CritterPreview look={look} />
          <span>{LOOK_INFO[look].label}</span>
        </button>
      ))}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

function TemplatePicker({
  templates,
  current,
  onPick,
}: {
  templates: PersonalityTemplate[];
  /** The personality text in use: its template shows as picked. */
  current?: string;
  onPick: (t: PersonalityTemplate) => void;
}) {
  return (
    <div className="template-grid">
      {templates.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`template-card ${current && current.trim() === t.personality.trim() ? 'selected' : ''}`}
          onClick={() => onPick(t)}
        >
          {t.look && <CritterPreview look={t.look} size={36} />}
          <strong>{t.title}</strong>
          <span className="hint">{t.description}</span>
        </button>
      ))}
    </div>
  );
}

function PersonalityEditor({ value, onChange }: { value: string; onChange: (text: string) => void }) {
  return (
    <Field label="Personality" hint="This is the character's system prompt. Write it like you'd describe someone to an actor.">
      <textarea
        className="personality"
        value={value}
        maxLength={MAX_PERSONALITY_CHARS}
        rows={12}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

// --- Character ---------------------------------------------------------------------------

function CharacterForm({ persona, onChange }: { persona: PersonaDraft; onChange: (p: PersonaDraft) => void }) {
  const pickLook = (look: Look) => {
    // Keep a custom species text; replace the default one of the previous animal.
    const isDefault = LOOKS.some((l) => LOOK_INFO[l].species === persona.species);
    onChange({ ...persona, look, species: isDefault || !persona.species ? LOOK_INFO[look].species : persona.species });
  };
  return (
    <div className="setup-form">
      <LookPicker value={persona.look} onChange={pickLook} />
      <div className="field-row">
        <Field label="Name">
          <input value={persona.name} maxLength={MAX_SETUP_NAME_CHARS} onChange={(e) => onChange({ ...persona, name: e.target.value })} required />
        </Field>
        <Field label="Species" hint="In your own words, e.g. “small fox” or “very old cat”.">
          <input
            value={persona.species}
            maxLength={MAX_SETUP_SPECIES_CHARS}
            onChange={(e) => onChange({ ...persona, species: e.target.value })}
          />
        </Field>
      </div>
      <Field label="Name of the town">
        <input value={persona.town} maxLength={MAX_SETUP_NAME_CHARS} onChange={(e) => onChange({ ...persona, town: e.target.value })} />
      </Field>
    </div>
  );
}

function PersonalityStep({
  persona,
  templates,
  onChange,
}: {
  persona: PersonaDraft;
  templates: PersonalityTemplate[];
  onChange: (p: PersonaDraft) => void;
}) {
  return (
    <div className="setup-form">
      <p className="hint">Start from a template and change whatever you like.</p>
      <TemplatePicker
        templates={templates}
        current={persona.personality}
        onPick={(t) => onChange({ ...persona, personality: t.personality })}
      />
      <PersonalityEditor value={persona.personality} onChange={(personality) => onChange({ ...persona, personality })} />
    </div>
  );
}

// --- Brain -------------------------------------------------------------------------------

export interface BrainChoice {
  mode: 'local' | 'cloud' | null;
  model: string;
  visionModel: string;
  openrouterKey: string;
}

/** Downloads (or just prepares) one model, with progress. */
function useModelPull(onReady: () => void) {
  const [progress, setProgress] = useState<{ model: string; status: string; share: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function pull(models: string[]) {
    setError(null);
    try {
      for (const model of models) {
        const res = await fetch('/api/setup/ollama/pull', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines.filter(Boolean)) {
            const p = JSON.parse(line) as { status: string; completed?: number; total?: number; error?: string };
            if (p.status === 'error') throw new Error(p.error);
            setProgress({ model, status: p.status, share: p.total ? (p.completed ?? 0) / p.total : 0 });
          }
        }
      }
      setProgress(null);
      onReady();
    } catch (err) {
      setProgress(null);
      setError((err as Error).message);
    }
  }
  return { progress, error, pull };
}

function LocalBrain({ choice, onChange }: { choice: BrainChoice; onChange: (c: BrainChoice) => void }) {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const refresh = () =>
    fetch('/api/setup/ollama')
      .then((r) => r.json() as Promise<OllamaStatus>)
      .then(setStatus)
      .catch(() => setStatus(null));
  const { progress, error, pull } = useModelPull(() => void refresh());
  useEffect(() => {
    void refresh();
  }, []);

  const rec = status?.recommended;
  const wanted = rec ? [...new Set([rec.model, rec.visionModel])] : [];
  const ready = !!status && wanted.length > 0 && wanted.every((m) => status.models.includes(localAlias(m)));
  // Once the recommended models are ready, use them (unless something else was picked).
  useEffect(() => {
    if (!ready || !rec || choice.model) return;
    onChange({ ...choice, model: localAlias(rec.model), visionModel: rec.visionModel === rec.model ? '' : localAlias(rec.visionModel) });
  }, [ready, rec, choice, onChange]);

  if (!status) return <p className="hint">Checking this Mac…</p>;
  if (!status.installed) {
    return (
      <div className="brain-steps">
        <p>
          Thinking on this Mac needs <strong>Ollama</strong>, a free app that runs AI models locally.
        </p>
        <ol>
          <li>
            <a href="https://ollama.com/download/mac" target="_blank" rel="noopener noreferrer">
              Download Ollama ↗
            </a>{' '}
            and move it to your Applications folder.
          </li>
          <li>Open it once.</li>
          <li>
            <button type="button" className="secondary" onClick={() => void refresh()}>
              Check again
            </button>
          </li>
        </ol>
      </div>
    );
  }
  if (!status.running) {
    return (
      <div className="brain-steps">
        <p>Ollama is installed but not running.</p>
        <button
          type="button"
          onClick={() => void postJson('/api/setup/ollama/start', {}).then(() => setTimeout(() => void refresh(), 3000))}
        >
          Start Ollama
        </button>
      </div>
    );
  }
  const installed = status.models.filter((m) => !/embed/i.test(m));
  return (
    <div className="brain-steps">
      {rec && (
        <div className={`model-card ${ready ? 'ready' : ''}`}>
          <div>
            <strong>Recommended for your Mac: {rec.model === rec.visionModel ? rec.model : `${rec.model} + ${rec.visionModel}`}</strong>
            <p className="hint">{rec.note}</p>
          </div>
          {ready ? (
            <span className="chip">Ready ✓</span>
          ) : progress ? (
            <div className="progress" role="progressbar" aria-valuenow={Math.round(progress.share * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="progress-fill" style={{ width: `${Math.round(progress.share * 100)}%` }} />
              <span>
                {progress.model}: {progress.status} {progress.share > 0 && `${Math.round(progress.share * 100)}%`}
              </span>
            </div>
          ) : (
            <button type="button" onClick={() => void pull(wanted)}>
              {wanted.every((m) => status.models.includes(m)) ? 'Prepare' : `Download (~${rec.downloadGb} GB)`}
            </button>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {installed.length > 0 && (
        <Field label="Model" hint="The ampli-… versions are tuned for this town (smaller memory, faster).">
          <select value={choice.model} onChange={(e) => onChange({ ...choice, model: e.target.value })}>
            <option value="">Choose…</option>
            {installed.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}

function CloudBrain({ choice, hasKey, onChange }: { choice: BrainChoice; hasKey: boolean; onChange: (c: BrainChoice) => void }) {
  const [check, setCheck] = useState<{ ok: boolean; error?: string } | null>(null);
  return (
    <div className="brain-steps">
      <p>
        Uses models in the cloud through{' '}
        <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">
          OpenRouter ↗
        </a>
        . Faster and smarter than most local models; costs about $2–3 a month at the calm speed, paid directly to
        OpenRouter.
      </p>
      <Field label="OpenRouter key" hint={hasKey ? 'A key is saved. Enter a new one only to replace it.' : 'Stored only on this Mac.'}>
        <input
          type="password"
          autoComplete="off"
          value={choice.openrouterKey}
          placeholder={hasKey ? '••••••••' : 'sk-or-…'}
          onChange={(e) => {
            setCheck(null);
            onChange({ ...choice, openrouterKey: e.target.value });
          }}
        />
      </Field>
      {choice.openrouterKey && (
        <div className="row">
          <button
            type="button"
            className="secondary"
            onClick={() => void postJson<{ ok: boolean; error?: string }>('/api/setup/openrouter/check', { key: choice.openrouterKey }).then(setCheck)}
          >
            Check key
          </button>
          {check && <span className={check.ok ? 'ok' : 'error'}>{check.ok ? 'Works ✓' : check.error}</span>}
        </div>
      )}
    </div>
  );
}

function BrainForm({ choice, hasKey, onChange }: { choice: BrainChoice; hasKey: boolean; onChange: (c: BrainChoice) => void }) {
  return (
    <div className="setup-form">
      <div className="mode-grid" role="radiogroup" aria-label="Where the character thinks">
        <button
          type="button"
          role="radio"
          aria-checked={choice.mode === 'local'}
          className={`mode-card ${choice.mode === 'local' ? 'selected' : ''}`}
          onClick={() => onChange({ ...choice, mode: 'local' })}
        >
          <strong>💻 On this Mac</strong>
          <span className="hint">Free and private. Needs a one-time download and a Mac with 16 GB memory or more.</span>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={choice.mode === 'cloud'}
          className={`mode-card ${choice.mode === 'cloud' ? 'selected' : ''}`}
          onClick={() => onChange({ ...choice, mode: 'cloud' })}
        >
          <strong>☁️ In the cloud</strong>
          <span className="hint">Quick to set up with an OpenRouter key. A few dollars a month.</span>
        </button>
      </div>
      {choice.mode === 'local' && <LocalBrain choice={choice} onChange={onChange} />}
      {choice.mode === 'cloud' && <CloudBrain choice={choice} hasKey={hasKey} onChange={onChange} />}
    </div>
  );
}

function brainReady(choice: BrainChoice, hasKey: boolean): boolean {
  if (choice.mode === 'local') return !!choice.model;
  if (choice.mode === 'cloud') return hasKey || !!choice.openrouterKey;
  return false;
}

function brainApply(choice: BrainChoice): SetupApply['brain'] | undefined {
  if (!choice.mode) return undefined;
  return choice.mode === 'local'
    ? { mode: 'local', model: choice.model, visionModel: choice.visionModel }
    : { mode: 'cloud', ...(choice.openrouterKey ? { openrouterKey: choice.openrouterKey } : {}) };
}

// --- Residents ---------------------------------------------------------------------------

const HOURS = Array.from({ length: 25 }, (_, h) => h);

function ResidentForm({
  resident,
  templates,
  onSave,
  onCancel,
}: {
  resident: ResidentDraft;
  templates: PersonalityTemplate[];
  onSave: (r: ResidentDraft) => void;
  onCancel: () => void;
}) {
  const [r, setR] = useState(resident);
  const allDay = r.hours === null;
  return (
    <div className="resident-form">
      <LookPicker value={r.look} onChange={(look) => setR({ ...r, look, species: LOOK_INFO[look].species })} />
      <div className="field-row">
        <Field label="Name">
          <input value={r.name} maxLength={MAX_SETUP_NAME_CHARS} onChange={(e) => setR({ ...r, name: e.target.value })} />
        </Field>
        <Field label="Species">
          <input value={r.species} maxLength={MAX_SETUP_SPECIES_CHARS} onChange={(e) => setR({ ...r, species: e.target.value })} />
        </Field>
      </div>
      <div className="field-row">
        <Field label="Where they are">
          <select value={r.place} onChange={(e) => setR({ ...r, place: e.target.value as ResidentDraft['place'] })}>
            {RESIDENT_PLACES.map((p) => (
              <option key={p} value={p}>
                {PLACES[p].name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="When" hint="In town time.">
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={allDay} onChange={(e) => setR({ ...r, hours: e.target.checked ? null : { from: 8, to: 18 } })} />
              all day
            </label>
            {!allDay && r.hours && (
              <>
                <select value={r.hours.from} onChange={(e) => setR({ ...r, hours: { ...r.hours!, from: Number(e.target.value) } })} aria-label="From">
                  {HOURS.slice(0, 24).map((h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
                –
                <select value={r.hours.to} onChange={(e) => setR({ ...r, hours: { ...r.hours!, to: Number(e.target.value) } })} aria-label="Until">
                  {HOURS.slice(1).map((h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        </Field>
      </div>
      <Field label="Start from a template">
        <select value="" onChange={(e) => {
          const t = templates.find((x) => x.id === e.target.value);
          if (t) setR({ ...r, personality: t.personality });
        }}>
          <option value="">Choose a personality…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}: {t.description}
            </option>
          ))}
        </select>
      </Field>
      <PersonalityEditor value={r.personality} onChange={(personality) => setR({ ...r, personality })} />
      <label className="check">
        <input type="checkbox" checked={r.active} onChange={(e) => setR({ ...r, active: e.target.checked })} />
        Lives in town (untick to keep them on file but away)
      </label>
      {r.hours && r.hours.from >= r.hours.to && <p className="error">“Until” has to be after “from”.</p>}
      <div className="row">
        <button type="button" disabled={!r.name.trim() || !!(r.hours && r.hours.from >= r.hours.to)} onClick={() => onSave(r)}>
          Done
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function fromTemplate(t: PersonalityTemplate): ResidentDraft {
  const look = t.look ?? 'cat';
  return {
    name: t.name ?? '',
    species: t.species ?? LOOK_INFO[look].species,
    look,
    place: t.place ?? 'cafe',
    hours: t.hours ?? null,
    personality: t.personality,
    active: true,
  };
}

const BLANK: PersonalityTemplate = { id: 'blank', title: 'Start from scratch', description: 'An empty personality to write yourself.', personality: '' };

function ResidentsEditor({
  residents,
  templates,
  onChange,
  onBusy,
}: {
  residents: ResidentDraft[];
  templates: PersonalityTemplate[];
  onChange: (r: ResidentDraft[]) => void;
  /** True while a neighbour is being picked or edited, so nothing saves a half-done one. */
  onBusy: (busy: boolean) => void;
}) {
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<ResidentDraft | null>(null);
  const [adding, setAdding] = useState(false);
  const busy = editing !== null || adding;
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);

  if (editing !== null && draft) {
    return (
      <ResidentForm
        resident={draft}
        templates={templates}
        onCancel={() => setEditing(null)}
        onSave={(r) => {
          onChange(editing === 'new' ? [...residents, r] : residents.map((x, i) => (i === editing ? r : x)));
          setEditing(null);
        }}
      />
    );
  }
  if (adding) {
    return (
      <div className="setup-form">
        <p className="hint">Who moves in? Pick a template; you can change everything next.</p>
        <TemplatePicker
          templates={[...templates, BLANK]}
          onPick={(t) => {
            setAdding(false);
            setDraft(fromTemplate(t));
            setEditing('new');
          }}
        />
        <button type="button" className="secondary" onClick={() => setAdding(false)}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="setup-form">
      <p className="hint">
        Neighbours are separate AI characters with their own personality and memory. Your character can chat with
        whoever is around. Nobody else lives in town unless you add them.
      </p>
      {residents.length === 0 && <p className="empty">Nobody else lives in town yet.</p>}
      <ul className="resident-list">
        {residents.map((r, i) => (
          <li key={r.id ?? `new-${i}`} className={r.active ? '' : 'inactive'}>
            <CritterPreview look={r.look} size={44} />
            <div>
              <span>
                <strong>{r.name || 'Unnamed'}</strong> the {r.species}
              </span>
              <span className="hint">
                {PLACES[r.place].name} · {r.hours ? `${String(r.hours.from).padStart(2, '0')}:00–${String(r.hours.to).padStart(2, '0')}:00` : 'all day'}
                {!r.active && ' · away'}
              </span>
            </div>
            <button type="button" className="secondary" onClick={() => {
              setDraft(r);
              setEditing(i);
            }}>
              Edit
            </button>
            <button type="button" className="secondary remove" onClick={() => onChange(residents.filter((_, j) => j !== i))} aria-label={`Remove ${r.name}`}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      {residents.length < 12 && (
        <button type="button" onClick={() => setAdding(true)}>
          + Add a neighbour
        </button>
      )}
    </div>
  );
}

// --- Extras ------------------------------------------------------------------------------

function ExtrasForm({
  speed,
  gyros,
  onSpeed,
  onGyros,
}: {
  speed: number;
  gyros: { url: string; uiUrl: string };
  onSpeed: (s: number) => void;
  onGyros: (g: { url: string; uiUrl: string }) => void;
}) {
  return (
    <div className="setup-form">
      <Field label="How fast time goes" hint="Faster means more thoughts per hour, which costs more in the cloud.">
        <select value={SPEEDS.find((s) => Math.abs(s.value - speed) < 1e-6)?.value ?? speed} onChange={(e) => onSpeed(Number(e.target.value))}>
          {SPEEDS.map((s) => (
            <option key={s.label} value={s.value}>
              {s.label}
            </option>
          ))}
          {!SPEEDS.some((s) => Math.abs(s.value - speed) < 1e-6) && <option value={speed}>Custom: {speed} town minutes per second</option>}
        </select>
      </Field>
      <GitStatus />
      <GyrosConnect gyros={gyros} onGyros={onGyros} />
    </div>
  );
}

/** The Code Lab's Git server: optional, set up from the terminal because it needs Docker. */
function GitStatus() {
  const [probe, setProbe] = useState<GitProbe | null>(null);
  const check = () =>
    fetch('/api/setup/git')
      .then((r) => r.json() as Promise<GitProbe>)
      .then(setProbe)
      .catch(() => setProbe(null));
  useEffect(() => {
    void check();
  }, []);
  return (
    <div className="gyros-connect">
      <span className="field-label">Code Lab Git server (optional)</span>
      <p className="hint">
        Websites built at the Code Lab are always saved and online in town. With a local Git server (Forgejo) every
        change also becomes a real commit you can browse, with history and diffs.
      </p>
      {!probe && <p className="hint">Looking for it…</p>}
      {probe && (
        <div className={`model-card ${probe.running && probe.connected ? 'ready' : ''}`}>
          <div>
            <strong>
              {probe.running ? (probe.connected ? `Connected to Forgejo ${probe.version ?? ''}` : 'Forgejo runs, but the town isn\'t connected') : 'No Git server running'}
            </strong>
            <p className="hint">
              {probe.running && probe.connected ? (
                <a href={probe.url} target="_blank" rel="noopener noreferrer">
                  {probe.url} ↗
                </a>
              ) : (
                <>
                  Needs Docker Desktop. In the Terminal, in the Ampli World folder: <code>npm run git:start</code>
                </>
              )}
            </p>
          </div>
          <button type="button" className="secondary" onClick={() => void check()}>
            Check again
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The workshop shows GyrOS only when it already runs on this Mac: we look for it and offer
 * to connect; otherwise there's nothing to set up.
 */
function GyrosConnect({
  gyros,
  onGyros,
}: {
  gyros: { url: string; uiUrl: string };
  onGyros: (g: { url: string; uiUrl: string }) => void;
}) {
  const [probe, setProbe] = useState<GyrosProbe | null>(null);
  const check = (url = gyros.url) =>
    fetch(`/api/setup/gyros${url ? `?url=${encodeURIComponent(url)}` : ''}`)
      .then((r) => r.json() as Promise<GyrosProbe>)
      .then(setProbe)
      .catch(() => setProbe(null));
  // Once on opening; "Check again" looks again.
  useEffect(() => {
    void check();
  }, []);
  const connected = !!gyros.url;

  return (
    <div className="gyros-connect">
      <span className="field-label">GyrOS workshop (optional)</span>
      <p className="hint">
        If you use GyrOS, the workshop in town shows its tickets moving through the pipeline. This only works when GyrOS
        already runs on this Mac; the town just reads its run list.
      </p>
      {!probe && <p className="hint">Looking for GyrOS…</p>}
      {probe && !probe.running && (
        <div className="model-card">
          <div>
            <strong>GyrOS isn't running on this Mac</strong>
            <p className="hint">
              Start GyrOS first, then check again. Without it the workshop stays closed{connected ? ' (the old connection is kept)' : ''}.
            </p>
          </div>
          <button type="button" className="secondary" onClick={() => void check()}>
            Check again
          </button>
        </div>
      )}
      {probe?.running && (
        <div className={`model-card ${connected ? 'ready' : ''}`}>
          <div>
            <strong>GyrOS found at {probe.url}</strong>
            <p className="hint">{probe.runs} runs. {connected ? 'Connected: the workshop shows them.' : 'Not connected yet.'}</p>
          </div>
          {connected ? (
            <button type="button" className="secondary" onClick={() => onGyros({ url: '', uiUrl: '' })}>
              Disconnect
            </button>
          ) : (
            <button type="button" onClick={() => onGyros({ url: probe.url, uiUrl: gyros.uiUrl || GYROS_DEFAULTS.uiUrl })}>
              Connect
            </button>
          )}
        </div>
      )}
      {connected && (
        <Field label="GyrOS web page" hint="Where the links in the workshop panel open, e.g. http://localhost:3200.">
          <input value={gyros.uiUrl} placeholder={GYROS_DEFAULTS.uiUrl} onChange={(e) => onGyros({ ...gyros, uiUrl: e.target.value })} />
        </Field>
      )}
    </div>
  );
}

// --- Wizard ------------------------------------------------------------------------------

function useSetupState() {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/setup')
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${r.status}`);
        return r.json() as Promise<SetupState>;
      })
      .then(setState)
      .catch((err: Error) => setError(err.message));
  }, []);
  return { state, error };
}

const STEPS = ['Welcome', 'Your character', 'Personality', 'Brain', 'Neighbours', 'Move in'] as const;

export function SetupWizard() {
  const { state, error } = useSetupState();
  if (error) return <p className="error">{error}</p>;
  if (!state) return <p className="hint">Loading…</p>;
  return <Wizard state={state} />;
}

function Wizard({ state }: { state: SetupState }) {
  const [step, setStep] = useState(0);
  const [persona, setPersona] = useState(state.persona);
  const [residents, setResidents] = useState(state.residents);
  const [brain, setBrain] = useState<BrainChoice>({ mode: state.brain.mode, model: '', visionModel: '', openrouterKey: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingNeighbour, setEditingNeighbour] = useState(false);

  const canNext =
    step === 1
      ? !!persona.name.trim()
      : step === 2
        ? !!persona.personality.trim()
        : step === 3
          ? brainReady(brain, state.brain.hasKey)
          : step === 4
            ? !editingNeighbour
            : true;

  async function finish() {
    setSaving(true);
    setError(null);
    try {
      await applyAndReload({ persona, residents, brain: brainApply(brain), complete: true });
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <div className="setup">
      <ol className="setup-steps" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'current' : i < step ? 'done' : ''}>
            {s}
          </li>
        ))}
      </ol>
      <section className="card setup-card">
        {step === 0 && (
          <div className="setup-welcome">
            <CritterPreview look={persona.look} size={96} />
            <h2>Welcome to your own little town</h2>
            <p>
              You're about to create an AI character that lives here on its own: it gets hungry and tired, reads, paints,
              looks things up and writes to you. You can watch every thought it has and how it's made.
            </p>
            <p className="hint">Takes about five minutes. You can change everything later with ⚙️.</p>
          </div>
        )}
        {step === 1 && (
          <>
            <h2>Who lives here?</h2>
            <CharacterForm persona={persona} onChange={setPersona} />
          </>
        )}
        {step === 2 && (
          <>
            <h2>What is {persona.name || 'your character'} like?</h2>
            <PersonalityStep persona={persona} templates={state.templates.characters} onChange={setPersona} />
          </>
        )}
        {step === 3 && (
          <>
            <h2>Where does {persona.name || 'it'} think?</h2>
            <BrainForm choice={brain} hasKey={state.brain.hasKey} onChange={setBrain} />
          </>
        )}
        {step === 4 && (
          <>
            <h2>Neighbours</h2>
            <ResidentsEditor
              residents={residents}
              templates={state.templates.residents}
              onChange={setResidents}
              onBusy={setEditingNeighbour}
            />
          </>
        )}
        {step === 5 && (
          <div className="setup-welcome">
            <CritterPreview look={persona.look} size={96} />
            <h2>
              {persona.name} the {persona.species} is ready to move into {persona.town}
            </h2>
            <p className="hint">
              {residents.filter((r) => r.active).length > 0
                ? `Neighbours: ${residents.filter((r) => r.active).map((r) => r.name).join(', ')}.`
                : 'No neighbours yet.'}{' '}
              Thinking {brain.mode === 'cloud' ? 'in the cloud' : `on this Mac with ${brain.model}`}.
            </p>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="setup-nav">
          {step > 0 && (
            <button type="button" className="secondary" onClick={() => setStep(step - 1)} disabled={saving}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button type="button" onClick={() => setStep(step + 1)} disabled={!canNext}>
              {step === 0 ? "Let's start" : 'Next'}
            </button>
          ) : (
            <button type="button" onClick={() => void finish()} disabled={saving}>
              {saving ? 'Moving in…' : 'Move in!'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

// --- Settings ----------------------------------------------------------------------------

const TABS = ['Character', 'Personality', 'Brain', 'Neighbours', 'Library', 'Extras'] as const;
type SettingsTab = (typeof TABS)[number];

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { state, error } = useSetupState();
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Settings" onClick={onClose}>
      <div className="modal card" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <h2>⚙️ Settings</h2>
          <button type="button" className="bell-dismiss" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {error && <p className="error">{error}</p>}
        {!state && !error && <p className="hint">Loading…</p>}
        {state && <Settings state={state} />}
      </div>
    </div>
  );
}

function Settings({ state }: { state: SetupState }) {
  const [tab, setTab] = useState<SettingsTab>('Character');
  const [persona, setPersona] = useState(state.persona);
  const [residents, setResidents] = useState(state.residents);
  const [brain, setBrain] = useState<BrainChoice>({
    mode: state.brain.mode,
    model: state.brain.model,
    visionModel: state.brain.visionModel,
    openrouterKey: '',
  });
  const [speed, setSpeed] = useState(state.speed);
  const [gyros, setGyros] = useState(state.gyros);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingNeighbour, setEditingNeighbour] = useState(false);
  const [editingBook, setEditingBook] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await applyAndReload({
        persona,
        residents,
        ...(brainReady(brain, state.brain.hasKey) ? { brain: brainApply(brain) } : {}),
        speed,
        gyros,
      });
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  }

  return (
    <>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'tab tab-active' : 'tab'} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      <div className="modal-body">
        {tab === 'Character' && <CharacterForm persona={persona} onChange={setPersona} />}
        {tab === 'Personality' && <PersonalityStep persona={persona} templates={state.templates.characters} onChange={setPersona} />}
        {tab === 'Brain' && <BrainForm choice={brain} hasKey={state.brain.hasKey} onChange={setBrain} />}
        {tab === 'Neighbours' && (
          <ResidentsEditor
            residents={residents}
            templates={state.templates.residents}
            onChange={setResidents}
            onBusy={setEditingNeighbour}
          />
        )}
        {tab === 'Library' && <LibraryEditor name={persona.name || 'your character'} onBusy={setEditingBook} />}
        {tab === 'Extras' && <ExtrasForm speed={speed} gyros={gyros} onSpeed={setSpeed} onGyros={setGyros} />}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="setup-nav">
        <span className="hint">Saving restarts the town for a few seconds. Memories and the diary stay.</span>
        <button type="button" onClick={() => void save()} disabled={saving || editingNeighbour || editingBook || !persona.name.trim()}>
          {saving ? 'Restarting…' : 'Save'}
        </button>
      </div>
    </>
  );
}
