import type {
  ArtworkRequest,
  BookPart,
  CodeCommitRequest,
  ProjectFile,
  BrainLetter,
  BrainContext,
  BrowseRequest,
  ChatLineRequest,
  CheckLetter,
  DecisionRequest,
  DiaryRequest,
  MailReplyRequest,
  MailVerdictRequest,
  NeighborNotesRequest,
  GyrosNudgeRequest,
  NoteRequest,
  WorkshopNoteRequest,
  ReadingRequest,
  WorldEvent,
} from '@ampli-world/shared';

export class SimError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thin HTTP client for the sim's /api/brain/* endpoints. */
export class SimClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  context(): Promise<BrainContext> {
    return this.request('GET', '/api/brain/context');
  }

  eventsSince(simTime: number): Promise<WorldEvent[]> {
    return this.request('GET', `/api/brain/events-since?simTime=${simTime}`);
  }

  /** The part of a book to read now. */
  book(id: string): Promise<BookPart> {
    return this.request('GET', `/api/brain/books/${encodeURIComponent(id)}`);
  }

  thinking(): Promise<unknown> {
    return this.request('POST', '/api/brain/thinking');
  }

  decide(body: DecisionRequest): Promise<unknown> {
    return this.request('POST', '/api/brain/decision', body);
  }

  reading(body: ReadingRequest): Promise<unknown> {
    return this.request('POST', '/api/brain/reading', body);
  }

  diary(body: DiaryRequest): Promise<unknown> {
    return this.request('POST', '/api/brain/diary', body);
  }

  projectFiles(slug: string): Promise<ProjectFile[]> {
    return this.request('GET', `/api/brain/projects/${encodeURIComponent(slug)}/files`);
  }

  codeCheck(body: Pick<CodeCommitRequest, 'project' | 'files' | 'deleted'>): Promise<{ problems: string[] }> {
    return this.request('POST', '/api/brain/code/check', body);
  }

  code(body: CodeCommitRequest): Promise<unknown> {
    return this.request('POST', '/api/brain/code', body);
  }

  workshopNote(body: WorkshopNoteRequest): Promise<unknown> {
    return this.request('POST', '/api/brain/workshop-note', body);
  }

  gyrosNudge(body: GyrosNudgeRequest): Promise<unknown> {
    return this.request('POST', '/api/brain/gyros-nudge', body);
  }

  note(body: NoteRequest): Promise<unknown> {
    return this.request('POST', '/api/brain/note', body);
  }

  chatLine(body: ChatLineRequest): Promise<unknown> {
    return this.request('POST', '/api/brain/chat-line', body);
  }

  neighborNotes(body: NeighborNotesRequest): Promise<unknown> {
    return this.request('POST', '/api/brain/neighbor-notes', body);
  }

  art(body: ArtworkRequest): Promise<unknown> {
    return this.request('POST', '/api/brain/art', body);
  }

  browse(body: BrowseRequest): Promise<unknown> {
    return this.request('POST', '/api/brain/browse', body);
  }

  mailChecks(): Promise<CheckLetter[]> {
    return this.request('GET', '/api/brain/mail/checks');
  }

  mailVerdict(id: number, body: MailVerdictRequest): Promise<unknown> {
    return this.request('POST', `/api/brain/mail/${id}/verdict`, body);
  }

  mailWaiting(): Promise<BrainLetter[]> {
    return this.request('GET', '/api/brain/mail/waiting');
  }

  mailReply(id: number, body: MailReplyRequest): Promise<unknown> {
    return this.request('POST', `/api/brain/mail/${id}/reply`, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { 'x-brain-token': this.token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new SimError(res.status, `${method} ${path} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}
