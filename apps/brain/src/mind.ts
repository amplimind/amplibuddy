import { setTimeout as sleep } from 'node:timers/promises';
import {
  MAX_QUERY_CHARS,
  dayOf,
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
  type Verdict,
  type WorldEvent,
} from '@ampli-world/shared';
import type { config as Config, NeighborPersona } from './config.ts';
import {
  callTool,
  clipToSentence,
  isMissedToolCall,
  isNoVisionError,
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
  type ChatTurn,
  type ModerationTarget,
} from './prompts.ts';
import { availableActivities, leastReadBook, offlineDecision, routineDecision } from './routine.ts';
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
  return { plan: { kind }, thought };
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

/** Real milliseconds to wait between chat lines: spread over the rest of the activity, 0.8-5 s. */
export function chatPause(ctx: BrainContext, startedRealMs: number, endsAt: number, linesLeft: number): number {
  const mps = ctx.snapshot.minutesPerSecond;
  const simNow = ctx.snapshot.simTime + ((Date.now() - startedRealMs) / 1000) * mps;
  const remainingSeconds = Math.max(0, (endsAt - simNow) / mps);
  const seconds = remainingSeconds / (linesLeft + 1);
  return Math.round(Math.min(5, Math.max(0.8, seconds)) * 1000);
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
  /** Cost of the query check, reported together with the search it belongs to. */
  private pendingBrowseMeta: LlmMeta[] = [];
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

    if (activity.kind === 'post_note' && this.noteFor !== activity.startedAt) {
      this.noteFor = activity.startedAt;
      const done = ctx.recentEvents.some((e) => e.type === 'note_posted' && e.simTime >= activity.startedAt);
      if (!done) void this.postNote(ctx);
    }

    if (activity.kind === 'chat' && this.chatFor !== activity.startedAt) {
      this.chatFor = activity.startedAt;
      const done = ctx.recentEvents.some((e) => e.type === 'chat_line' && e.simTime >= activity.startedAt);
      if (!done) void this.chat(ctx, activity.startedAt, activity.endsAt);
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
        routineDecision(ctx, { canAnswerMail: this.llmAvailable(ctx) && !this.answering }) ??
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
    const canChat = ctx.chatsToday < this.cfg.chatsPerDay && this.neighbors.some((n) => n.place === 'cafe');
    const canPostNote = ctx.notesToday < this.cfg.notesPerDay;
    const kinds = availableActivities(ctx.snapshot.simTime, {
      mailWaiting: this.answering ? 0 : ctx.mail.waiting,
      canBrowse,
      canPaint,
      canChat,
      canPostNote,
    });
    try {
      const { args, meta } = await this.llm({
        model: this.cfg.brainModel,
        system: decideSystem(this.persona),
        user: decideUser(ctx, kinds),
        tool: decideTool(kinds, ctx.books.map((b) => b.id)),
        maxTokens: 300,
      });
      const decision = toDecision(args, meta, ctx, kinds);
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
      await this.sim.reading({ bookId, takeaway, llm: meta });
      console.log(`[brain] read "${book.title}": ${takeaway} (${cost(meta)})`);
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
          user: diaryUser(day, events, ctx.notebook, ctx.lastDiary),
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
  private async chat(ctx: BrainContext, startedAt: number, endsAt: number): Promise<void> {
    const neighbor = this.neighbors.find((n) => n.place === 'cafe');
    if (!neighbor || !this.llmAvailable(ctx)) return;
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
          system: chatSystem(isAmpli ? this.persona : neighbor.prompt, isAmpli ? `${neighbor.name} the ${neighbor.species}` : ampli),
          user: isAmpli
            ? ampliChatUser(ctx, neighbor.name, transcript)
            : neighborChatUser(ctx, ampli, notes, transcript),
          tool: sayTool,
          maxTokens: 200,
          temperature: 0.9,
        });
        const text = typeof args.line === 'string' ? args.line.trim() : '';
        if (!text) break;
        spent += meta.costUsd;
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

  /** At the notice board: a short public note to colleagues, checked before it's pinned. */
  private async postNote(ctx: BrainContext): Promise<void> {
    if (!this.llmAvailable(ctx)) return;
    try {
      const { args, meta } = await this.llm({
        model: this.cfg.brainModel,
        system: noteSystem(this.persona),
        user: noteUser(ctx),
        tool: noteTool,
        maxTokens: 250,
        temperature: 0.9,
      });
      const text = typeof args.text === 'string' ? args.text.trim().slice(0, MAX_NOTE_CHARS) : '';
      if (!text) throw new Error('the note came back empty');
      const check = await this.moderate('board', text);
      const held = check.verdict === 'hold';
      await this.sim.note({ text, held, llm: [meta, check.meta] });
      console.log(`[brain] note ${held ? `held (${check.reason})` : `pinned: "${text}"`} (${cost(meta)})`);
    } catch (err) {
      console.warn('[brain] note failed:', (err as Error).message);
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
      const result = await this.search({
        model: this.cfg.brainModel,
        system: browseSystem(this.persona),
        query,
        maxTokens: 400,
        maxResults: 3,
        excludeDomains: this.cfg.webExcludeDomains,
      });
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
      system: moderationSystem(target),
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

  private search(req: WebSearchRequest) {
    this.callTimes.push(Date.now());
    return webSearch(this.cfg.llm, { ...req, reasoning: this.cfg.reasoning });
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
