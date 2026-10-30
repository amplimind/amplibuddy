import { setTimeout as sleep } from 'node:timers/promises';
import {
  MAX_QUERY_CHARS,
  PLACES,
  dayOf,
  formatHours,
  neighborPresent,
  formatTime,
  isActivityKind,
  type ActivityKind,
  type BrainContext,
  type DecisionRequest,
  type ArtworkRequest,
  type BrainLetter,
  type BrowseRequest,
  type DiaryRequest,
  type LlmMeta,
  type MailReplyRequest,
  type PlaceId,
  type Verdict,
  type WorldEvent,
} from '@ampli-world/shared';
import type { config as Config, NeighborPersona } from './config.ts';
import {
  callTool,
  clipToSentence,
  isMissedToolCall,
  isNoVisionError,
  summarizeResults,
  webSearch, type ToolCallRequest, type ToolCallResult, type WebSearchRequest } from './llm.ts';
import {
  ampliChatUser,
  artTool,
  browseSystem,
  chatSystem,
  decideSystem,
  decideTool,
  decideUser,
  diarySystem,
  diaryTool,
  diaryUser,
  moderationSystem,
  moderationTool,
  moderationUser,
  NEIGHBOR_NOTES_LIMIT,
  neighborChatUser,
  neighborNotesSystem,
  neighborNotesTool,
  neighborNotesUser,
  NOTEBOOK_LIMIT,
  MAX_NOTE_CHARS,
  noteSystem,
  noteTool,
  noteUser,
  paintSystem,
  paintUser,
  readingSystem,
  readingUser,
  replySystem,
  replyTool,
  replyUser,
  sayTool,
  takeawayTool,
  bellFallback,
  codePlanSystem,
  codePlanTool,
  codePlanUser,
  codeSystem,
  codeTool,
  codeUser,
  bellSystem,
  bellTool,
  bellUser,
  presentNeighbors,
  rutWords,
  workshopSystem,
  workshopTool,
  workshopUser,
  type ChatTurn,
  type ModerationTarget,
} from './prompts.ts';
import { availableActivities, leastReadBook, offlineDecision, routineDecision } from './routine.ts';
import { contentWords, ollamaSearch, repeatedSearch, resultsBlock, searxngSearch, wikipediaSearch, withTopPage } from './search.ts';
import { SimError, type SimClient } from './sim-client.ts';

/** Sleep that starts before 06:00 still belongs to the previous day's diary. */
export function diaryDay(sleepStartedAt: number): number {
  return dayOf(sleepStartedAt - 6 * 60);
}

/** Turn the model's tool arguments into a decision the sim will accept. Throws if unusable. */
export function toDecision(
  args: Record<string, unknown>,
  meta: LlmMeta,
  ctx: BrainContext,
  allowed: ActivityKind[],
): DecisionRequest {
  const kind = args.activity;
  if (!isActivityKind(kind) || !allowed.includes(kind)) throw new Error(`model chose ${String(kind)}`);
  const text = typeof args.thought === 'string' ? args.thought.trim() : '';
  if (!text) throw new Error('model gave no thought');

  const thought = { text, source: 'llm' as const, llm: meta };
  if (kind === 'read') {
    const wanted = args.book_id;
    const bookId = ctx.books.some((b) => b.id === wanted) ? (wanted as string) : leastReadBook(ctx);
    if (!bookId) throw new Error('read chosen but library is empty');
    return { plan: { kind, bookId }, thought };
  }
  if (kind === 'browse') {
    const query = typeof args.search === 'string' ? args.search.trim().slice(0, MAX_QUERY_CHARS) : '';
    if (!query) throw new Error('browse chosen without a search query');
    return { plan: { kind, query }, thought };
  }
  if (kind === 'chat') {
    const present = presentNeighbors(ctx);
    const wanted = typeof args.with === 'string' ? args.with.trim().toLowerCase() : '';
    const partner = present.find((n) => n.name.toLowerCase() === wanted) ?? present[0];
    if (!partner) throw new Error('chat chosen but nobody is around');
    return { plan: { kind, partnerId: partner.id }, thought };
  }
  return { plan: { kind }, thought };
}

/**
 * The files from a coding session, in whatever shape the model sent them: a list of
 * {path, content} (the asked-for shape), the same list as a JSON string, a {path: content}
 * object, or list items that call the fields name/filename and code/text.
 */
export function codeFilesFrom(value: unknown): { path: string; content: string }[] {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  if (Array.isArray(v)) {
    return v
      .map((f: Record<string, unknown> | null) => ({
        path: f?.path ?? f?.name ?? f?.filename ?? f?.file,
        content: f?.content ?? f?.code ?? f?.text ?? f?.body,
      }))
      .filter((f): f is { path: string; content: string } => typeof f.path === 'string' && typeof f.content === 'string');
  }
  if (v && typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .filter((e): e is [string, string] => typeof e[1] === 'string')
      .map(([path, content]) => ({ path, content }));
  }
  return [];
}

/** Why a search would go round in circles, or null if it's fine. */
export function searchObjection(query: string, ctx: BrainContext): string | null {
  const repeat = repeatedSearch(query, ctx.recentSearches);
  if (repeat) {
    const learned = repeat.takeaway ? ` and found: ${repeat.takeaway.slice(0, 200)}` : '';
    return `you already looked that up as "${repeat.query}"${learned}. Use what you found, or look up something different`;
  }
  const rut = rutWords(ctx)?.words ?? [];
  const stuck = [...contentWords(query)].filter((w) => rut.includes(w));
  if (stuck.length > 0) {
    return `you've been on ${stuck.map((w) => `"${w}"`).join(', ')} for a long while already. Look up something else, or do something else`;
  }
  return null;
}

/** Diary for when the LLM is unavailable: a plain tally of the day, notebook untouched. */
export function offlineDiary(day: number, events: WorldEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.type === 'activity_started') counts.set(e.data.kind, (counts.get(e.data.kind) ?? 0) + 1);
  }
  const parts = [...counts].map(([kind, n]) => (n > 1 ? `${kind} ×${n}` : kind));
  return `Day ${day}. My head was foggy today, so just the facts: ${parts.join(', ') || 'not much'}. Goodnight.`;
}

/** Turn the model's reply_letter arguments into a reply request (before outbound moderation). */
export function toReply(args: Record<string, unknown>): MailReplyRequest {
  const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
  const memory = typeof args.memory === 'string' ? args.memory.trim() : '';
  const caption = typeof args.doodle_caption === 'string' ? args.doodle_caption.trim() : '';
  const extras = { ...(memory ? { memory } : {}), ...(caption ? { doodleCaption: caption } : {}) };
  if (args.decision === 'skip') return { decision: 'skip', ...(reason ? { note: reason } : {}), ...extras };
  const reply = typeof args.reply === 'string' ? args.reply.trim() : '';
  if (!reply) throw new Error('model chose to reply but wrote nothing');
  return { decision: 'reply', reply, ...extras };
}

/** Anything other than a clear "ok" holds the text for a human: fail closed. */
export function toVerdict(args: Record<string, unknown>): { verdict: Verdict; reason: string } {
  const reason = typeof args.reason === 'string' ? args.reason.trim().slice(0, 300) : '';
  return { verdict: args.verdict === 'ok' ? 'ok' : 'hold', reason: reason || 'no reason given' };
}

/** The sim stores at most 600 characters; stay below and end on a full sentence. */
const MAX_TAKEAWAY_CHARS = 580;

const MIN_CHAT_LINES = 4;
const MAX_CHAT_LINES = 6;

/** Where the sim clock is now, estimated from the context's snapshot and the real time since. */
function simNowSince(ctx: BrainContext, startedRealMs: number): number {
  return ctx.snapshot.simTime + ((Date.now() - startedRealMs) / 1000) * ctx.snapshot.minutesPerSecond;
}

/**
 * Has the chat activity ended? Lines that a slow model finishes after that are dropped:
 * otherwise the feed shows Ampli chatting at the counter while it's already at the pond.
 */
export function chatOver(ctx: BrainContext, startedRealMs: number, endsAt: number): boolean {
  return simNowSince(ctx, startedRealMs) >= endsAt;
}

/** Real milliseconds to wait between chat lines: spread over the rest of the activity, 0.8-5 s. */
export function chatPause(ctx: BrainContext, startedRealMs: number, endsAt: number, linesLeft: number): number {
  const mps = ctx.snapshot.minutesPerSecond;
  const simNow = simNowSince(ctx, startedRealMs);
  const remainingSeconds = Math.max(0, (endsAt - simNow) / mps);
  const seconds = remainingSeconds / (linesLeft + 1);
  return Math.round(Math.min(5, Math.max(0.8, seconds)) * 1000);
}

/** After a bell attempt, wait this long (real time) before the bell rule may fire again. */
const BELL_RETRY_MS = 10 * 60_000;

/** No credits, bad key, forbidden: retrying soon won't help. */
export function isAccountError(err: unknown): boolean {
  return err instanceof Error && /\b(401|402|403)\b|credits|unauthori[sz]ed|forbidden/i.test(err.message);
}

/** How long to skip a search provider after it failed: long for account trouble, short for hiccups. */
export function searchSkipMs(err: unknown): number {
  return isAccountError(err) ? 3_600_000 : 300_000;
}

/** After a failed moderation call, wait this long before retrying the queue. */
const MODERATION_BACKOFF_MS = 60_000;

function cost(meta: LlmMeta): string {
  return `$${meta.costUsd.toFixed(4)}, ${meta.latencyMs}ms`;
}

export class Mind {
  private deciding = false;
  private readingFor: number | null = null;
  private reflectedDay: number | null = null;
  private mailFor: number | null = null;
  /** True while replies are being written; slow (local) models must not get a second batch. */
  private answering = false;
  private browseFor: number | null = null;
  private paintFor: number | null = null;
  private chatFor: number | null = null;
  private noteFor: number | null = null;
  private workshopFor: number | null = null;
  private codeFor: number | null = null;
  /** Who the character is, for the content checks ("Ampli, an AI small fox character"). */
  private character = 'Ampli, an AI fox character';
  /** Real time of the last bell attempt, so a failed one doesn't send Ampli back right away. */
  private bellTriedAt = 0;
  /** Cost of the query check, reported together with the search it belongs to. */
  private pendingBrowseMeta: LlmMeta[] = [];
  /** Search providers that failed recently, until when to skip them. */
  private searchDownUntil = new Map<string, number>();
  private moderating = false;
  private moderationPausedUntil = 0;
  private callTimes: number[] = [];
  private lastOfflineReason = '';

  constructor(
    private readonly sim: SimClient,
    private readonly persona: string,
    private readonly cfg: typeof Config,
    private readonly neighbors: NeighborPersona[] = [],
  ) {}

  /** Called on every poll. Starts background work (reading, diary, mail) and decides when idle. */
  async step(ctx: BrainContext): Promise<void> {
    const p = ctx.snapshot.persona;
    this.character = `${p.name}, an AI ${p.species} character`;
    this.observe(ctx);
    void this.moderateQueue(ctx);
    if (ctx.idle && !this.deciding) await this.decide(ctx);
  }

  private observe(ctx: BrainContext): void {
    const activity = ctx.snapshot.agent.activity;
    if (!activity) return;

    if (activity.kind === 'read' && activity.bookId && this.readingFor !== activity.startedAt) {
      this.readingFor = activity.startedAt;
      const noted = ctx.recentEvents.some((e) => e.type === 'reading' && e.simTime >= activity.startedAt);
      if (!noted) void this.read(ctx, activity.bookId);
    }

    if (activity.kind === 'browse' && activity.query && this.browseFor !== activity.startedAt) {
      this.browseFor = activity.startedAt;
      const done = ctx.recentEvents.some((e) => e.type === 'browsed' && e.simTime >= activity.startedAt);
      if (!done) void this.browse(ctx, activity.query);
    }

    if (activity.kind === 'code' && this.codeFor !== activity.startedAt) {
      this.codeFor = activity.startedAt;
      const done = ctx.recentEvents.some((e) => e.type === 'code_committed' && e.simTime >= activity.startedAt);
      if (!done) void this.code(ctx);
    }

    if (activity.kind === 'visit_workshop' && this.workshopFor !== activity.startedAt) {
      this.workshopFor = activity.startedAt;
      const done = ctx.recentEvents.some(
        (e) => (e.type === 'workshop_note' || e.type === 'gyros_nudge') && e.simTime >= activity.startedAt,
      );
      const overdue = ctx.snapshot.gyros?.runs.some((r) => r.overdue) ?? false;
      if (!done) void (overdue ? this.ringBell(ctx) : this.explainWorkshop(ctx));
    }

    if (activity.kind === 'post_note' && this.noteFor !== activity.startedAt) {
      this.noteFor = activity.startedAt;
      const done = ctx.recentEvents.some((e) => e.type === 'note_posted' && e.simTime >= activity.startedAt);
      if (!done) void this.postNote(ctx);
    }

    if (activity.kind === 'chat' && this.chatFor !== activity.startedAt) {
      this.chatFor = activity.startedAt;
      const done = ctx.recentEvents.some((e) => e.type === 'chat_line' && e.simTime >= activity.startedAt);
      if (!done) void this.chat(ctx, activity.startedAt, activity.endsAt, activity.partnerId, activity.place);
    }

    if (activity.kind === 'paint' && this.paintFor !== activity.startedAt) {
      this.paintFor = activity.startedAt;
      const done = ctx.recentEvents.some((e) => e.type === 'artwork_created' && e.simTime >= activity.startedAt);
      if (!done) void this.paint(ctx);
    }

    if (activity.kind === 'check_mail' && this.mailFor !== activity.startedAt) {
      this.mailFor = activity.startedAt;
      void this.answerMail(ctx);
    }

    if (activity.kind === 'sleep') {
      const day = diaryDay(activity.startedAt);
      if (this.reflectedDay !== day && ctx.lastDiary?.day !== day) {
        this.reflectedDay = day;
        void this.reflect(ctx, day);
      }
    }
  }

  private async decide(ctx: BrainContext): Promise<void> {
    this.deciding = true;
    try {
      const decision =
        routineDecision(ctx, {
          canAnswerMail: this.llmAvailable(ctx) && !this.answering,
          canRingBell: Date.now() - this.bellTriedAt > BELL_RETRY_MS,
        }) ??
        (await this.freeChoice(ctx));
      await this.sim.decide(decision);
      const { plan, thought } = decision;
      const extra = thought.llm ? ` (${cost(thought.llm)})` : '';
      console.log(`[brain] ${formatTime(ctx.snapshot.simTime)} ${thought.source} → ${plan.kind}: "${thought.text}"${extra}`);
    } catch (err) {
      // 409 = the world moved on while we were thinking; just try again next poll.
      if (!(err instanceof SimError && err.status === 409)) console.warn('[brain] decide failed:', (err as Error).message);
    } finally {
      this.deciding = false;
    }
  }

  private async freeChoice(ctx: BrainContext): Promise<DecisionRequest> {
    if (!this.llmAvailable(ctx)) return offlineDecision(ctx);
    await this.sim.thinking().catch(() => {});
    const canBrowse = this.cfg.webSearch && ctx.browsesToday < this.cfg.searchesPerDay;
    const canPaint = ctx.artToday < this.cfg.artPerDay;
    const present = presentNeighbors(ctx).filter((n) => this.neighbors.some((p) => p.id === n.id));
    const canChat = ctx.chatsToday < this.cfg.chatsPerDay && present.length > 0;
    const canPostNote = ctx.notesToday < this.cfg.notesPerDay;
    const canVisitWorkshop = ctx.snapshot.gyros?.connected === true;
    const canCode = this.cfg.code && ctx.codeToday < this.cfg.codePerDay;
    const kinds = availableActivities(ctx.snapshot.simTime, {
      canCode,
      mailWaiting: this.answering ? 0 : ctx.mail.waiting,
      canBrowse,
      canPaint,
      canChat,
      canPostNote,
      canVisitWorkshop,
    });
    // Say why something is missing, so Ampli can let go of a plan instead of circling it.
    const unavailable: string[] = [];
    if (!canPostNote) unavailable.push(`post_note: you've pinned ${ctx.notesToday} notes today, the board is full until tomorrow`);
    if (this.neighbors.length > 0 && !canChat) {
      const away = ctx.snapshot.neighbors
        .filter((n) => n.hours)
        .map((n) => `${n.name} is at ${PLACES[n.place].name} ${formatHours(n.hours!)}`);
      unavailable.push(
        present.length === 0
          ? `chat: nobody is around right now${away.length > 0 ? ` (${away.join('; ')})` : ''}`
          : "chat: you've chatted enough for today",
      );
    }
    if (this.cfg.webSearch && !canBrowse) unavailable.push('browse: no more web searches today');
    if (!canPaint) unavailable.push("paint: you've painted enough for today");
    if (this.cfg.code && !canCode) unavailable.push("code: you've coded enough for today");
    try {
      const ask = async (notes: string[]) => {
        const { args, meta } = await this.llm({
          model: this.cfg.brainModel,
          system: decideSystem(this.persona),
          user: decideUser(ctx, kinds, notes),
          tool: decideTool(
            kinds,
            ctx.books.map((b) => b.id),
            present.map((n) => n.name),
          ),
          maxTokens: 300,
        });
        return toDecision(args, meta, ctx, kinds);
      };
      let decision = await ask(unavailable);
      // The same question in other words, or more of the topic it's stuck on: say so once
      // and let it choose again.
      const objection = decision.plan.query ? searchObjection(decision.plan.query, ctx) : null;
      if (objection) {
        console.log(`[brain] search "${decision.plan.query}" refused (${objection}), asking again`);
        decision = await ask([...unavailable, `browse "${decision.plan.query}": ${objection}`]);
        if (decision.plan.query && searchObjection(decision.plan.query, ctx)) {
          throw new Error(`search "${decision.plan.query}" goes round in circles`);
        }
      }
      if (decision.plan.query) {
        // Checked before it becomes public (in the thought and on the map).
        const check = await this.moderate('search', decision.plan.query);
        if (check.verdict === 'hold') throw new Error(`search "${decision.plan.query}" held: ${check.reason}`);
        this.pendingBrowseMeta = [check.meta];
      }
      return decision;
    } catch (err) {
      console.warn('[brain] LLM decision failed, using offline choice:', (err as Error).message);
      return offlineDecision(ctx);
    }
  }

  private async read(ctx: BrainContext, bookId: string): Promise<void> {
    if (!this.llmAvailable(ctx)) return;
    try {
      const book = await this.sim.book(bookId);
      const { args, meta } = await this.llm({
        model: this.cfg.brainModel,
        system: readingSystem(this.persona),
        user: readingUser(book, ctx.notebook),
        tool: takeawayTool,
        maxTokens: 300,
      });
      const takeaway = typeof args.takeaway === 'string' ? args.takeaway.trim() : '';
      if (!takeaway) return;
      await this.sim.reading({ bookId, takeaway, part: book.part, llm: meta });
      const part = book.parts > 1 ? ` (part ${book.part}/${book.parts})` : '';
      console.log(`[brain] read "${book.title}"${part}: ${takeaway} (${cost(meta)})`);
    } catch (err) {
      console.warn('[brain] reading failed:', (err as Error).message);
    }
  }

  /** The nightly consolidation: diary entry + rewritten notebook. */
  private async reflect(ctx: BrainContext, day: number): Promise<void> {
    try {
      const events = await this.sim.eventsSince(ctx.lastDiary?.simTime ?? 0);
      let request: DiaryRequest;
      if (this.llmAvailable(ctx)) {
        const { args, meta } = await this.llm({
          model: this.cfg.reflectModel,
          system: diarySystem(this.persona),
          user: diaryUser(day, events, ctx.notebook, ctx.lastDiary, ctx.snapshot.neighbors),
          tool: diaryTool,
          maxTokens: 1500,
          temperature: 0.8,
        });
        const notebook = Array.isArray(args.notebook)
          ? args.notebook.filter((n): n is string => typeof n === 'string').slice(0, NOTEBOOK_LIMIT)
          : ctx.notebook;
        const text = typeof args.entry === 'string' && args.entry.trim() ? args.entry.trim() : offlineDiary(day, events);
        request = { day, text, notebook, llm: meta };
        console.log(`[brain] diary for day ${day} written, notebook has ${notebook.length} notes (${cost(meta)})`);
      } else {
        request = { day, text: offlineDiary(day, events), notebook: ctx.notebook };
      }
      await this.sim.diary(request);
    } catch (err) {
      this.reflectedDay = null; // retry on next poll
      console.warn('[brain] diary failed:', (err as Error).message);
    }
  }

  /**
   * A conversation at the café counter. Each line is its own call with only that
   * speaker's persona and memory: two separate minds, not one model playing both.
   * Lines are paced over the activity so the speech bubbles can be read.
   */
  private async chat(
    ctx: BrainContext,
    startedAt: number,
    endsAt: number,
    partnerId: string | undefined,
    place: PlaceId,
  ): Promise<void> {
    const neighbor = this.neighbors.find((n) => n.id === partnerId) ?? this.neighbors.find((n) => n.place === place);
    if (!neighbor || !this.llmAvailable(ctx)) return;
    const where = PLACES[place].name;
    const chatId = Math.round(startedAt * 1000);
    const ampli = ctx.snapshot.persona.name;
    const notes = ctx.neighborNotes[neighbor.id] ?? [];
    const transcript: ChatTurn[] = [];
    const t0 = Date.now();
    let spent = 0;
    try {
      for (let i = 0; i < MAX_CHAT_LINES; i++) {
        const isAmpli = i % 2 === 0;
        const { args, meta } = await this.llm({
          model: this.cfg.brainModel,
          system: chatSystem(
            isAmpli ? this.persona : neighbor.prompt,
            isAmpli ? `${neighbor.name} the ${neighbor.species}` : ampli,
            where,
          ),
          user: isAmpli
            ? ampliChatUser(ctx, neighbor.name, transcript, where)
            : neighborChatUser(ctx, ampli, notes, transcript, where),
          tool: sayTool,
          maxTokens: 200,
          temperature: 0.9,
        });
        const text = typeof args.line === 'string' ? args.line.trim() : '';
        if (!text) break;
        spent += meta.costUsd;
        if (chatOver(ctx, t0, endsAt)) break;
        transcript.push({ name: isAmpli ? ampli : neighbor.name, text });
        await this.sim.chatLine({ chatId, speaker: isAmpli ? 'ampli' : neighbor.id, text, llm: meta });
        if (args.end === true && transcript.length >= MIN_CHAT_LINES) break;
        await sleep(chatPause(ctx, t0, endsAt, MAX_CHAT_LINES - i - 1));
      }
      if (transcript.length === 0) return;
      const { args, meta } = await this.llm({
        model: this.cfg.brainModel,
        system: neighborNotesSystem(neighbor.prompt, ampli),
        user: neighborNotesUser(notes, transcript),
        tool: neighborNotesTool,
        maxTokens: 600,
        temperature: 0.7,
      });
      const newNotes = Array.isArray(args.notes)
        ? args.notes.filter((n): n is string => typeof n === 'string').slice(0, NEIGHBOR_NOTES_LIMIT)
        : notes;
      await this.sim.neighborNotes({ neighborId: neighbor.id, notes: newNotes, llm: meta });
      console.log(`[brain] chat with ${neighbor.name}: ${transcript.length} lines ($${(spent + meta.costUsd).toFixed(4)})`);
    } catch (err) {
      console.warn('[brain] chat failed:', (err as Error).message);
    }
  }

  /**
   * At the Code Lab: plan (which website, what idea), then write the files, check what the
   * page shows, and hand it to the sim, which validates, saves, commits and serves it.
   */
  private async code(ctx: BrainContext): Promise<void> {
    if (!this.llmAvailable(ctx)) return;
    try {
      const plan = await this.llm({
        model: this.cfg.brainModel,
        system: codePlanSystem(this.persona),
        user: codePlanUser(ctx),
        tool: codePlanTool(ctx.projects.map((p) => p.slug)),
        maxTokens: 300,
        temperature: 0.9,
      });
      const chosen = ctx.projects.find((p) => p.slug === plan.args.project);
      const name = chosen?.name ?? (typeof plan.args.name === 'string' && plan.args.name.trim() ? plan.args.name.trim().slice(0, 40) : 'My first website');
      const idea = typeof plan.args.idea === 'string' ? plan.args.idea.trim() : '';
      if (!idea) throw new Error('no idea for the session');
      const current = chosen ? await this.sim.projectFiles(chosen.slug) : [];

      const { args, meta } = await this.llm({
        model: this.cfg.brainModel,
        system: codeSystem(this.persona),
        user: codeUser({ name, description: chosen?.description ?? '', idea, isNew: !chosen, problems: chosen?.problems ?? [] }, current),
        tool: codeTool,
        maxTokens: 12_000,
        temperature: 0.7,
      });
      const files = codeFilesFrom(args.files);
      const deleted = (Array.isArray(args.deleted) ? args.deleted : []).filter((d): d is string => typeof d === 'string');
      const message = typeof args.message === 'string' ? args.message.trim() : '';
      if (files.length === 0 && deleted.length === 0) {
        // Tell the town, so the character doesn't believe it built something.
        const shape = Array.isArray(args.files) ? `a list of ${args.files.length}` : typeof args.files;
        console.warn(`[brain] coding produced no usable files (got ${shape})`);
        await this.sim.code({
          project: chosen?.slug ?? name,
          files: [],
          message: idea,
          failed: 'the code came out garbled, no files were written',
          raw: JSON.stringify(args),
          llm: [meta, plan.meta],
        });
        return;
      }

      // What the page shows is public: check it like a painting.
      const check = await this.moderate('code', files.map((f) => `--- ${f.path}\n${f.content}`).join('\n\n').slice(0, 8000));
      await this.sim.code({
        project: chosen?.slug ?? name,
        ...(chosen ? {} : { description: typeof args.description === 'string' ? args.description : idea }),
        files,
        deleted,
        message: message || idea,
        ...(check.verdict === 'hold' ? { held: true } : {}),
        llm: [meta, plan.meta, check.meta],
      });
      const status = check.verdict === 'hold' ? `held (${check.reason})` : `${files.length} files`;
      console.log(`[brain] coded "${name}": ${message || idea} (${status}, ${cost(meta)})`);
    } catch (err) {
      console.warn('[brain] coding failed:', (err as Error).message);
      // Unless the sim already logged why (it refused the files), tell it the session didn't work out.
      if (!(err instanceof SimError)) {
        await this.sim.code({ project: 'a website', files: [], message: 'x', failed: 'the session broke off before anything was saved' }).catch(() => {});
      }
    }
  }

  /** At the workshop: explain in plain words what GyrOS is doing (only whitelisted facts). */
  private async explainWorkshop(ctx: BrainContext): Promise<void> {
    if (!this.llmAvailable(ctx) || !ctx.snapshot.gyros) return;
    try {
      const { args, meta } = await this.llm({
        model: this.cfg.brainModel,
        system: workshopSystem(this.persona),
        user: workshopUser(ctx),
        tool: workshopTool,
        maxTokens: 350,
        temperature: 0.8,
      });
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (!text) throw new Error('the explanation came back empty');
      await this.sim.workshopNote({ text, llm: meta });
      console.log(`[brain] workshop: "${text}" (${cost(meta)})`);
    } catch (err) {
      console.warn('[brain] workshop note failed:', (err as Error).message);
    }
  }

  /**
   * At the workshop with runs that have waited too long: ring the bell. The model words it
   * (checked like a notice-board note); without a model, or if that fails, plain facts do.
   */
  private async ringBell(ctx: BrainContext): Promise<void> {
    this.bellTriedAt = Date.now();
    const runs = (ctx.snapshot.gyros?.runs ?? []).filter((r) => r.overdue).slice(0, 8);
    if (runs.length === 0) return;
    let text = bellFallback(runs);
    const llm: LlmMeta[] = [];
    if (this.llmAvailable(ctx)) {
      try {
        const { args, meta } = await this.llm({
          model: this.cfg.brainModel,
          system: bellSystem(this.persona),
          user: bellUser(ctx, runs),
          tool: bellTool,
          maxTokens: 300,
          temperature: 0.8,
        });
        llm.push(meta);
        const said = typeof args.text === 'string' ? clipToSentence(args.text.trim(), MAX_NOTE_CHARS) : '';
        if (said) {
          const check = await this.moderate('board', said);
          llm.push(check.meta);
          if (check.verdict !== 'hold') text = said;
        }
      } catch (err) {
        console.warn('[brain] bell wording failed, ringing with plain facts:', (err as Error).message);
      }
    }
    try {
      await this.sim.gyrosNudge({ runIds: runs.map((r) => r.runId), text, llm });
      console.log(`[brain] rang the workshop bell: "${text}"`);
    } catch (err) {
      // 409: someone answered meanwhile, or the bell was already rung for this wait.
      if (!(err instanceof SimError && err.status === 409)) console.warn('[brain] bell failed:', (err as Error).message);
    }
  }

  /**
   * At the notice board: a short public note to colleagues, checked before it's pinned. Two
   * tries; if both fail the sim logs that no note was written, so Ampli doesn't believe it was.
   */
  private async postNote(ctx: BrainContext): Promise<void> {
    if (!this.llmAvailable(ctx)) return;
    try {
      const write = () =>
        this.llm({
          model: this.cfg.brainModel,
          system: noteSystem(this.persona),
          user: noteUser(ctx),
          tool: noteTool,
          maxTokens: 400,
          temperature: 0.9,
        }).then(({ args, meta }) => {
          const text = typeof args.text === 'string' ? clipToSentence(args.text.trim(), MAX_NOTE_CHARS) : '';
          if (!text) throw new Error('the note came back empty');
          return { args, meta, text };
        });
      let written: Awaited<ReturnType<typeof write>>;
      try {
        written = await write();
      } catch (err) {
        console.warn('[brain] note failed, trying once more:', (err as Error).message);
        written = await write();
      }
      const { args, meta, text } = written;
      const check = await this.moderate('board', text);
      const held = check.verdict === 'hold';
      const question = args.question === true;
      await this.sim.note({ text, held, question, llm: [meta, check.meta] });
      const what = question ? 'question' : 'note';
      console.log(`[brain] ${what} ${held ? `held (${check.reason})` : `pinned: "${text}"`} (${cost(meta)})`);
    } catch (err) {
      console.warn('[brain] note failed:', (err as Error).message);
      await this.sim.note({ failed: true }).catch(() => {});
    }
  }

  /** At the easel: one SVG artwork, checked before it goes into the gallery. */
  private async paint(ctx: BrainContext): Promise<void> {
    if (!this.llmAvailable(ctx)) return;
    try {
      const { args, meta } = await this.llm({
        model: this.cfg.reflectModel,
        system: paintSystem(this.persona),
        user: paintUser(ctx),
        tool: artTool,
        maxTokens: 6000,
        temperature: 1,
      });
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      const caption = typeof args.caption === 'string' ? args.caption.trim() : '';
      const svg = typeof args.svg === 'string' ? args.svg : '';
      if (!title || !caption || !svg) throw new Error('the artwork came back incomplete');
      const check = await this.moderate('art', `Title: ${title}\nCaption: ${caption}\n\n${svg}`);
      const request: ArtworkRequest = {
        title,
        caption,
        svg,
        ...(check.verdict === 'hold' ? { held: true, note: check.reason } : {}),
        llm: [meta, check.meta],
      };
      await this.sim.art(request);
      const status = request.held ? `held (${check.reason})` : 'in the gallery';
      console.log(`[brain] painted "${title}" (${svg.length} chars, ${status}) (${cost(meta)})`);
    } catch (err) {
      // A 400 means the SVG broke the safety rules; nothing gets hung up.
      console.warn('[brain] painting failed:', (err as Error).message);
    }
  }

  /** At the internet café: search, write a takeaway, check it, report with the sources. */
  private async browse(ctx: BrainContext, query: string): Promise<void> {
    if (!this.llmAvailable(ctx)) return;
    try {
      const result = await this.searchWithFallback(query);
      const takeaway = clipToSentence(result.text, MAX_TAKEAWAY_CHARS);
      const check = await this.moderate('note', takeaway);
      const request: BrowseRequest = {
        query,
        takeaway,
        sources: result.sources,
        held: check.verdict === 'hold',
        llm: [result.meta, ...this.pendingBrowseMeta.splice(0), check.meta],
      };
      await this.sim.browse(request);
      const note = request.held ? `note held (${check.reason})` : `"${takeaway}"`;
      console.log(`[brain] browsed "${query}" (${result.sources.length} sources): ${note} (${cost(result.meta)})`);
    } catch (err) {
      console.warn('[brain] browsing failed:', (err as Error).message);
    }
  }

  /** Check new letters before they reach the post box. Letters wait while no LLM is available. */
  private async moderateQueue(ctx: BrainContext): Promise<void> {
    if (this.moderating || Date.now() < this.moderationPausedUntil || !this.llmAvailable(ctx)) return;
    this.moderating = true;
    try {
      for (const letter of await this.sim.mailChecks()) {
        const { verdict, reason, meta } = await this.moderate('letter', letter.text, letter.doodle);
        await this.sim.mailVerdict(letter.id, { verdict, reason, llm: meta });
        // Logs outlive "forget me", so they never contain anything from private letters.
        const why = letter.visibility === 'public' ? ` (${reason})` : '';
        console.log(`[brain] letter #${letter.id} (${letter.visibility}): ${verdict}${why}`);
      }
    } catch (err) {
      this.moderationPausedUntil = Date.now() + MODERATION_BACKOFF_MS;
      console.warn('[brain] moderation failed, retrying in a minute:', (err as Error).message);
    } finally {
      this.moderating = false;
    }
  }

  private async moderate(target: ModerationTarget, text: string, image?: string) {
    const { args, meta } = await this.llm({
      model: this.cfg.brainModel,
      system: moderationSystem(target, this.character),
      user: moderationUser(text || '(no text, only a drawing)'),
      tool: moderationTool,
      maxTokens: 150,
      temperature: 0,
      ...(image ? { images: [image] } : {}),
    });
    return { ...toVerdict(args), meta };
  }

  /** At the post box: one isolated reply call per letter, public replies checked before posting. */
  private async answerMail(ctx: BrainContext): Promise<void> {
    if (this.answering || !this.llmAvailable(ctx)) return;
    this.answering = true;
    try {
      for (const letter of await this.sim.mailWaiting()) await this.answer(ctx, letter);
    } catch (err) {
      console.warn('[brain] mail failed, letters stay in the post box:', (err as Error).message);
    } finally {
      this.answering = false;
    }
  }

  private async answer(ctx: BrainContext, letter: BrainLetter): Promise<void> {
    const { args, meta } = await this.llm({
      model: this.cfg.reflectModel,
      system: replySystem(this.persona),
      user: replyUser(ctx, letter),
      tool: replyTool,
      maxTokens: 500,
      temperature: 0.8,
      ...(letter.doodle ? { images: [letter.doodle] } : {}),
    });
    const request: MailReplyRequest = { ...toReply(args), llm: [meta] };
    if (request.reply && letter.visibility === 'public') {
      const check = await this.moderate('reply', request.reply);
      request.llm!.push(check.meta);
      if (check.verdict === 'hold') Object.assign(request, { held: true, note: `reply held: ${check.reason}` });
    }
    await this.sim.mailReply(letter.id, request);
    const outcome = request.held
      ? 'reply held for review'
      : request.decision === 'skip'
        ? 'skipped'
        : letter.visibility === 'public'
          ? `"${request.reply}"`
          : 'replied privately';
    console.log(`[brain] letter #${letter.id} (${letter.visibility}): ${outcome} (${cost(meta)})`);
  }

  private llmAvailable(ctx: BrainContext): boolean {
    const hourAgo = Date.now() - 3_600_000;
    this.callTimes = this.callTimes.filter((t) => t > hourAgo);
    const reason =
      this.cfg.llm.openRouter && !this.cfg.llm.apiKey
      ? 'no OPENROUTER_API_KEY set'
      : ctx.usageToday.costUsd >= this.cfg.dailyBudgetUsd
        ? `daily budget of $${this.cfg.dailyBudgetUsd} used up`
        : this.callTimes.length >= this.cfg.maxCallsPerHour
          ? `hourly limit of ${this.cfg.maxCallsPerHour} calls reached`
          : '';
    if (reason !== this.lastOfflineReason) {
      console.log(reason ? `[brain] offline mode: ${reason}` : '[brain] LLM available again');
      this.lastOfflineReason = reason;
    }
    return reason === '';
  }

  /**
   * Tries the configured search providers in order. A provider that fails (no credits,
   * outage) is skipped for an hour, so one bad key doesn't cut Ampli off the web.
   */
  private async searchWithFallback(query: string) {
    let lastError: unknown;
    for (const provider of this.cfg.searchProviderOrder) {
      if ((this.searchDownUntil.get(provider) ?? 0) > Date.now()) continue;
      const attempt = () =>
        provider === 'openrouter'
          ? this.search({
              model: this.cfg.searchModel,
              system: browseSystem(this.persona),
              query,
              maxTokens: 400,
              maxResults: 3,
              excludeDomains: this.cfg.webExcludeDomains,
            })
          : this.searchAndRead(provider, query);
      try {
        return await attempt();
      } catch (first) {
        // One retry: search engines time out now and then.
        if (!isAccountError(first)) {
          await sleep(2000);
          try {
            return await attempt();
          } catch (second) {
            lastError = second;
          }
        } else {
          lastError = first;
        }
        this.searchDownUntil.set(provider, Date.now() + searchSkipMs(lastError));
        console.warn(`[brain] ${provider} search failed, trying the next one: ${(lastError as Error).message}`);
      }
    }
    throw lastError ?? new Error('no search provider available');
  }

  /** Search locally (SearXNG), with Ollama or Wikipedia, open the top page, let the model read. */
  private async searchAndRead(provider: 'searxng' | 'ollama' | 'wikipedia', query: string) {
    const found =
      provider === 'searxng'
        ? await searxngSearch(this.cfg.searxngUrl, query)
        : provider === 'ollama'
          ? await ollamaSearch(query, this.cfg.ollamaApiKey)
          : await wikipediaSearch(query);
    if (found.length === 0 && provider !== 'wikipedia') throw new Error(`${provider} found nothing for "${query}"`);
    // Wikipedia hits already carry the article intro; for web results, read the best page.
    const hits = provider === 'wikipedia' ? found : await withTopPage(found);
    this.callTimes.push(Date.now());
    const { text, meta } = await summarizeResults(this.cfg.llm, {
      model: this.cfg.brainModel,
      system: browseSystem(this.persona),
      query,
      results: resultsBlock(hits),
      maxTokens: 400,
      reasoning: this.cfg.reasoning,
    });
    return { text, sources: hits.map(({ title, url }) => ({ title, url })), meta };
  }

  private search(req: WebSearchRequest) {
    this.callTimes.push(Date.now());
    return webSearch(this.cfg.searchEndpoint, { ...req, reasoning: this.cfg.reasoning });
  }

  /**
   * One tool call with two fallbacks for less reliable (often local) models: a single
   * retry when the model answers in prose, and a retry without images when the model
   * can't see (it's told so, instead of the letter getting stuck).
   */
  private async llm(req: ToolCallRequest): Promise<ToolCallResult> {
    const thinking = this.cfg.reasoning !== 'off';
    const call = (r: ToolCallRequest) => {
      this.callTimes.push(Date.now());
      return callTool(this.cfg.llm, {
        ...r,
        ...(r.images?.length && this.cfg.visionModel ? { model: this.cfg.visionModel } : {}),
        reasoning: this.cfg.reasoning,
        // Thinking tokens count against max_tokens; leave room so the tool call isn't cut off.
        maxTokens: thinking ? r.maxTokens + 2000 : r.maxTokens,
      });
    };
    try {
      return await call(req);
    } catch (err) {
      if (req.images?.length && isNoVisionError(err)) {
        console.warn(`[brain] ${req.model} can't see images; continuing without the drawing`);
        const { images: _images, ...textOnly } = req;
        return call({
          ...textOnly,
          user: `${req.user}\n\n(There is a drawing, but you can't see images, so you don't know what it shows. Say so honestly if it matters.)`,
        });
      }
      if (isMissedToolCall(err)) return call(req);
      throw err;
    }
  }
}
