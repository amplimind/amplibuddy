import {
  ART_VERSION,
  ACTIVITIES,
  PLACES,
  formatClock,
  formatTime,
  type DiaryEntry,
  type LlmMeta,
  type Neighbor,
  type PlaceId,
  type Thought,
  type UsageToday,
  type WorldEvent,
  type WorldSnapshot,
} from '@ampli-world/shared';

/** "home" reads better without an article: "walked from home to the Park". */
function placeRef(id: PlaceId): string {
  return id === 'home' ? 'home' : `the ${PLACES[id].name}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function shortModel(model: string): string {
  return model.split('/').pop() ?? model;
}

export function SourceBadge({ source, llm }: { source: Thought['source']; llm?: LlmMeta }) {
  if (llm) {
    return (
      <span
        className="badge badge-llm"
        title={`${llm.model} · ${llm.promptTokens} tokens in, ${llm.completionTokens} out`}
      >
        AI · {shortModel(llm.model)} · ${llm.costUsd.toFixed(4)} · {(llm.latencyMs / 1000).toFixed(1)}s
      </span>
    );
  }
  return source === 'routine' ? (
    <span className="badge" title="A fixed rule handled this: no AI involved">
      routine · no AI
    </span>
  ) : (
    <span className="badge" title="No model available: picked by a simple scoring rule">
      offline · no AI
    </span>
  );
}

function currentBook(events: WorldEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === 'activity_started') return e.data.bookTitle;
  }
  return undefined;
}

export function statusLine(snapshot: WorldSnapshot, events: WorldEvent[]): string {
  const { agent } = snapshot;
  if (agent.thinking) return 'is pondering what to do next…';
  if (agent.walk) {
    const next = agent.next ? ` (${ACTIVITIES[agent.next.kind].verb} next)` : '';
    return `is walking ${agent.walk.to === 'home' ? 'home' : `to ${placeRef(agent.walk.to)}`}${next}`;
  }
  if (agent.activity) {
    const book = agent.activity.kind === 'read' ? currentBook(events) : undefined;
    const query = agent.activity.query;
    const partner = snapshot.neighbors.find((n) => n.id === agent.activity!.partnerId)?.name;
    const what = book
      ? `reading “${book}”`
      : query
        ? `looking up “${query}” online`
        : partner
          ? `chatting with ${partner} at ${placeRef(agent.activity.place)}`
          : ACTIVITIES[agent.activity.kind].verb;
    return `is ${what} until ${formatTime(agent.activity.endsAt)}`;
  }
  return `is standing around at ${placeRef(agent.place ?? 'plaza')}`;
}

function NeedBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="need">
      <span className="need-label">{label}</span>
      <div className="need-track" role="meter" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
        <div className="need-fill" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="need-value">{Math.round(value)}</span>
    </div>
  );
}

export function StatusCard({ snapshot, events }: { snapshot: WorldSnapshot; events: WorldEvent[] }) {
  const { agent, persona } = snapshot;
  return (
    <section className="card status">
      <div className="status-head">
        <p className="status-line">
          <strong>{persona.name}</strong> {statusLine(snapshot, events)}
        </p>
        <span className="chip" title="Mood">
          {agent.mood.label}
        </span>
      </div>
      <div className="needs">
        <NeedBar label="Energy" value={agent.needs.energy} color="var(--energy)" />
        <NeedBar label="Fed" value={agent.needs.satiety} color="var(--satiety)" />
        <NeedBar label="Fun" value={agent.needs.fun} color="var(--fun)" />
        <NeedBar label="Company" value={agent.needs.social} color="var(--social)" />
      </div>
    </section>
  );
}

function FeedItem({ event }: { event: WorldEvent }) {
  const time = <span className="feed-time">{formatClock(event.simTime)}</span>;
  switch (event.type) {
    case 'thought':
      return (
        <li className="feed-item feed-thought">
          {time}
          <p className="thought-text">“{event.data.text}”</p>
          <SourceBadge source={event.data.source} llm={event.data.llm} />
        </li>
      );
    case 'reading':
      return (
        <li className="feed-item feed-reading">
          {time}
          <p>
            <span className="feed-kicker">
              Notes on “{event.data.title}”{event.data.part ? `, part ${event.data.part} of ${event.data.parts}` : ''}
            </span>
            {event.data.takeaway}
          </p>
          <SourceBadge source="llm" llm={event.data.llm} />
        </li>
      );
    case 'walk_started':
      return (
        <li className="feed-item feed-minor">
          {time} walked from {placeRef(event.data.from)} {event.data.to === 'home' ? 'home' : `to ${placeRef(event.data.to)}`}
        </li>
      );
    case 'activity_started':
      return (
        <li className="feed-item feed-minor">
          {time} started{' '}
          {event.data.bookTitle
            ? `reading “${event.data.bookTitle}”`
            : event.data.query
              ? `looking up “${event.data.query}”`
              : event.data.with
                ? `chatting with ${event.data.with}`
                : ACTIVITIES[event.data.kind].verb}
        </li>
      );
    case 'diary_written':
      return (
        <li className="feed-item feed-minor">
          {time} wrote the diary for day {event.data.day} and rewrote the notebook
        </li>
      );
    case 'browsed':
      return (
        <li className="feed-item feed-browse">
          {time}
          <p>
            <span className="feed-kicker">Looked up “{event.data.query}”</span>
            {event.data.takeaway ?? 'Notes withheld by the content check.'}
          </p>
          {event.data.sources.length > 0 && (
            <ul className="sources">
              {event.data.sources.map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" title={s.title}>
                    {hostOf(s.url)}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {event.data.llm && <SourceBadge source="llm" llm={event.data.llm} />}
        </li>
      );
    case 'note_posted':
      if (event.data.held) {
        return <li className="feed-item feed-minor">{time} wrote a note, but it didn't pass the content check</li>;
      }
      if (event.data.failed || !event.data.text) {
        return <li className="feed-item feed-minor">{time} went to the notice board, but the note didn't get written</li>;
      }
      return (
        <li className="feed-item pinned-note">
          {time}
          <p>
            <span className="feed-kicker">{event.data.question ? '❓ Asked everyone' : '📌 Pinned a note on the notice board'}</span>
            “{event.data.text}”
          </p>
          {event.data.llm && <SourceBadge source="llm" llm={event.data.llm} />}
        </li>
      );
    case 'chat_line':
      return (
        <li className={`feed-item feed-chat ${event.data.speaker === 'ampli' ? 'chat-ampli' : 'chat-neighbor'}`}>
          <span className="feed-time">
            {formatClock(event.simTime)} · {event.data.name}
          </span>
          <p>“{event.data.text}”</p>
        </li>
      );
    case 'artwork_created':
      return (
        <li className="feed-item feed-art">
          {time}
          <img src={`/api/art/${event.data.artworkId}.svg?v=${ART_VERSION}`} alt={event.data.title} loading="lazy" />
          <p>
            <span className="feed-kicker">Made “{event.data.title}”</span>
            {event.data.caption}
          </p>
          {event.data.llm && <SourceBadge source="llm" llm={event.data.llm} />}
        </li>
      );
    case 'mail_read':
      return event.data.from ? (
        <li className="feed-item feed-letter">
          {time}
          <p>
            <span className="feed-kicker">
              {event.data.question ? `${event.data.from} answered “${event.data.question}”` : `Letter from ${event.data.from}`}
            </span>
            {event.data.text && `“${event.data.text}”`}
          </p>
          {event.data.doodle && (
            <img
              className="doodle"
              src={`/api/mail/${event.data.letterId}/doodle`}
              alt={event.data.doodleCaption ? `Doodle: ${event.data.doodleCaption}` : 'A doodle'}
              loading="lazy"
            />
          )}
          {event.data.reply ? <p className="letter-reply">↳ {event.data.reply}</p> : <p className="hint">Read, no reply.</p>}
        </li>
      ) : (
        <li className="feed-item feed-minor">{time} read a private letter</li>
      );
    case 'gyros':
      return null;
    case 'gyros_nudge':
      return (
        <li className="feed-item feed-bell">
          {time}
          <p>
            <span className="feed-kicker">🔔 Rang the workshop bell</span>
            {event.data.text}
          </p>
          {event.data.llm && <SourceBadge source="llm" llm={event.data.llm} />}
        </li>
      );
    case 'workshop_note':
      return (
        <li className="feed-item feed-workshop">
          {time}
          <p>
            <span className="feed-kicker">⚙️ In the GyrOS workshop</span>
            {event.data.text}
          </p>
          {event.data.llm && <SourceBadge source="llm" llm={event.data.llm} />}
        </li>
      );
    case 'activity_finished':
      return null;
  }
}

export function Feed({ events }: { events: WorldEvent[] }) {
  // Only what Ampli does; GyrOS changes have their own log in the workshop panel.
  const own = events.filter((e) => e.type !== 'gyros' && e.type !== 'activity_finished');
  if (own.length === 0) return <p className="empty">Nothing has happened yet. Give it a moment.</p>;
  return (
    <ol className="feed">
      {[...own].reverse().map((e) => (
        <FeedItem key={e.id} event={e} />
      ))}
    </ol>
  );
}

export function DiaryView({ diary, name }: { diary: DiaryEntry[]; name: string }) {
  if (diary.length === 0) {
    return <p className="empty">{name} writes a diary entry every night before falling asleep. None yet.</p>;
  }
  return (
    <div className="diary">
      {diary.map((d) => (
        <article key={d.day} className="diary-entry">
          <h3>Day {d.day}</h3>
          {d.text.split(/\n+/).map((p, i) => (
            <p key={i}>{p}</p>
          ))}
          {d.llm && <SourceBadge source="llm" llm={d.llm} />}
        </article>
      ))}
    </div>
  );
}

export function NotebookView({ notebook, name }: { notebook: string[]; name: string }) {
  return (
    <div className="notebook">
      <p className="hint">
        This is {name}’s only long-term memory. Every night it gets rewritten: new things are added, old ones merged or
        dropped.
      </p>
      {notebook.length === 0 ? (
        <p className="empty">Still empty. The first entries appear after the first night.</p>
      ) : (
        <ul>
          {notebook.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Both kinds of memory in one place: the notebook it carries and the diary it wrote. */
export function MemoryView({ diary, notebook, name }: { diary: DiaryEntry[]; notebook: string[]; name: string }) {
  return (
    <div className="memory-tab">
      <h2 className="section-title">Notebook</h2>
      <NotebookView notebook={notebook} name={name} />
      <h2 className="section-title">Diary</h2>
      <DiaryView diary={diary} name={name} />
    </div>
  );
}

export function HowItWorks({ name, usage, neighbors }: { name: string; usage: UsageToday; neighbors: Neighbor[] }) {
  return (
    <div className="how">
      <p>
        {name} is an AI character. Nothing here is scripted, and nothing is hidden: this is how it works.
      </p>
      <h3>1. The world keeps running</h3>
      <p>
        A small simulation runs all the time, whether anyone is watching or not. It has a clock, places, and four needs
        that slowly drain: energy, hunger, fun and company. Mood follows from those.
      </p>
      <h3>2. The brain decides</h3>
      <p>
        When {name} finishes something, the brain picks what comes next. Urgent things (bed at night, food when
        starving) are simple rules with no AI involved. Everything else goes to a language model: it gets a written
        description of the situation (needs, mood, notebook, recent events, options) and answers with a choice and a
        thought explaining why. That thought is what you see in the feed.
      </p>
      <h3>3. Memory is just text</h3>
      <p>
        A language model remembers nothing between calls. {name}’s memory is three pieces of text: the recent event
        log, the nightly diary, and a short notebook that {name} rewrites each night, keeping what matters.
      </p>
      <h3>4. Reading is real</h3>
      <p>
        The library books are real texts, and you can add your own (⚙️ → Library, also as PDF). When {name} reads, the
        model gets the actual text and writes down what stuck. Long books are read in parts, one per visit, with the notes
        on the earlier parts at hand. Those notes can end up in the notebook and shape later choices.
      </p>
      <h3>5. Every thought has a price tag</h3>
      <p>
        Each AI badge shows the model, the cost and how long it took. Today so far:{' '}
        <strong>
          {usage.calls} model calls, ${usage.costUsd.toFixed(3)}
        </strong>
        .
      </p>
      <h3>6. Letters</h3>
      <p>
        When you write to {name}, a small model first checks the letter. {name} decides when to walk to the post box
        (or goes once letters have waited too long). Each letter gets its own model call that sees only that letter.
        Public replies are checked again before they appear. Private letters never reach the feed, the diary or the
        notebook: the model writing those simply never sees them.
      </p>
      <h3>7. The internet café</h3>
      <p>
        At the internet café {name} searches the real web: the model chooses what to look up, a search engine returns
        a few pages, and the model writes down what it found. The feed shows the query, the note and the sources, so you
        can check whether the note matches what the pages actually say. Queries and notes are checked before they appear,
        and web pages can only inform the note, never trigger an action.
      </p>
      <h3>8. Doodles and the art studio</h3>
      <p>
        Doodles you send are images the model actually looks at, both for the content check and when {name} replies. In
        the studio, {name} paints by writing SVG code: shapes, colours and gradients, chosen by the model from its mood
        and recent days. There's no image generator involved, just a language model writing a picture as text.
      </p>
      <h3>9. Company</h3>
      <p>
        {name} has a fourth need: company. It drains when {name} is alone and fills up through others: your letters,
        the notes {name} pins on the notice board to invite them{neighbors.length > 0 ? ', and chats with the neighbours' : ''}.{' '}
        {neighbors.length > 0 ? 'Neighbours help' : 'Nobody else lives in town'}, but if you want {name} to feel less
        lonely, write.
      </p>
      <h3>10. The GyrOS workshop</h3>
      <p>
        If GyrOS runs on the same machine, the glass-roofed workshop shows its pipeline: every ticket in flight is a
        little robot at the station it's working on, from the ticket desk through draft, workbench, gates and review to
        the dock. A bell rings when a run waits for a human. If a run waits too long, {name} walks over, rings the bell
        and says who is waiting for what, with links into GyrOS, once per wait. {name} only watches: the town reads
        GyrOS's run list and never presses a button there. When {name} visits, the model gets ticket keys, titles and steps (no ticket text,
        code or logs) and explains what's going on in plain words.
      </p>
      {neighbors.length > 0 && (
        <section>
          <h3>Several minds: the neighbours</h3>
          <p>
            {neighbors.map((n) => `${n.name} the ${n.species}`).join(', ')}{' '}
            {neighbors.length === 1 ? 'is a separate AI character' : 'are separate AI characters'}, each with their own
            persona, place, hours and notes. In a conversation, every line is its own model call that only sees that
            speaker's context: {name}'s notebook and days, or the neighbour's notes about {name}. That's what
            “multi-agent” means: separate minds, each with its own memory, talking through a shared channel.
          </p>
        </section>
      )}
      <h3>Things to watch for</h3>
      <ul>
        <li>How the same model makes different choices when its context changes.</li>
        <li>How the notebook drifts over days, and what gets forgotten.</li>
        <li>Moments where it repeats itself or gets something wrong. That happens too.</li>
      </ul>
    </div>
  );
}
