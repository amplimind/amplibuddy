import type { WebSource } from '@ampli-world/shared';

// Web search for the internet café when the LLM isn't on OpenRouter (whose web plugin
// searches and reads in one call). Here we fetch results ourselves and hand them to
// whatever model is configured. SearXNG runs locally and needs nothing; Ollama's search
// needs credits; Wikipedia needs nothing but only knows encyclopedia topics.

export type SearchProvider = 'openrouter' | 'searxng' | 'ollama' | 'wikipedia';

export interface SearchHit extends WebSource {
  content: string;
}

const TIMEOUT_MS = 20_000;
const MAX_CONTENT_CHARS = 1500;
const USER_AGENT = 'ampli-world/0.1 (internal AI demo; https://github.com/DennisMuellerAM/ampliworld)';

/** Ollama and SearXNG both answer with { results: [{ title, url, content }] }. */
export function parseOllamaResults(data: unknown): SearchHit[] {
  const results = (data as { results?: { title?: string; url?: string; content?: string }[] })?.results ?? [];
  return results
    .filter((r) => typeof r.url === 'string' && /^https?:\/\//.test(r.url))
    .map((r) => ({
      title: r.title || new URL(r.url!).hostname,
      url: r.url!,
      content: (r.content ?? '').slice(0, MAX_CONTENT_CHARS),
    }));
}

export async function ollamaSearch(query: string, apiKey: string, max = 3): Promise<SearchHit[]> {
  const res = await fetch('https://ollama.com/api/web_search', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: max }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Ollama web search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return parseOllamaResults(await res.json());
}

/** A local SearXNG instance (see `npm run search:start`). */
export async function searxngSearch(baseUrl: string, query: string, max = 3): Promise<SearchHit[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/search?${new URLSearchParams({ q: query, format: 'json', language: 'en' })}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`SearXNG ${res.status}: is it running (npm run search:start) with JSON enabled?`);
  return parseOllamaResults(await res.json()).slice(0, max);
}

// --- Reading a page --------------------------------------------------------------

const PAGE_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_PAGE_CHARS = 3000;

/**
 * Only public web pages: no localhost, private networks or link-local addresses, so a
 * search result can't make Ampli poke around the local network.
 */
export function isPublicWebUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  // IPv6 literals: loopback, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host.includes(':') && (host === '::1' || /^f[cd]/.test(host) || host.startsWith('fe80'))) return false;
  return true;
}

/** Visible text of an HTML page: no scripts, styles or tags; entities and whitespace tidied. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Opens a public page and returns its readable text (truncated), or null if that's not possible. */
export async function readPage(url: string): Promise<string | null> {
  if (!isPublicWebUrl(url)) return null;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,text/plain' },
      redirect: 'follow',
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!res.ok || !isPublicWebUrl(res.url)) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/(html|plain)/.test(type)) return null;
    const body = (await res.text()).slice(0, MAX_PAGE_BYTES);
    const text = type.includes('html') ? htmlToText(body) : body.replace(/\s+/g, ' ').trim();
    return text.length > 200 ? text.slice(0, MAX_PAGE_CHARS) : null;
  } catch {
    return null;
  }
}

/** Replace the top hit's snippet with the actual page text, when the page can be read. */
export async function withTopPage(hits: SearchHit[]): Promise<SearchHit[]> {
  const [top, ...rest] = hits;
  if (!top) return hits;
  const page = await readPage(top.url);
  return page ? [{ ...top, content: page }, ...rest] : hits;
}

interface WikiSearch {
  query?: { search?: { pageid: number; title: string }[] };
}
interface WikiExtracts {
  query?: { pages?: Record<string, { pageid: number; title: string; extract?: string }> };
}

/** Search hits in search order, with their intro text. */
export function parseWikipediaResults(search: WikiSearch, extracts: WikiExtracts): SearchHit[] {
  const pages = extracts.query?.pages ?? {};
  return (search.query?.search ?? [])
    .map((hit) => pages[String(hit.pageid)])
    .filter((p): p is { pageid: number; title: string; extract?: string } => !!p && !!p.extract)
    .map((p) => ({
      title: `${p.title} (Wikipedia)`,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`,
      content: p.extract!.slice(0, MAX_CONTENT_CHARS),
    }));
}

export async function wikipediaSearch(query: string, max = 3): Promise<SearchHit[]> {
  const api = 'https://en.wikipedia.org/w/api.php';
  const get = async <T>(params: Record<string, string>): Promise<T> => {
    const res = await fetch(`${api}?${new URLSearchParams({ format: 'json', ...params })}`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Wikipedia ${res.status}`);
    return (await res.json()) as T;
  };
  const search = await get<WikiSearch>({ action: 'query', list: 'search', srsearch: query, srlimit: String(max) });
  const ids = (search.query?.search ?? []).map((h) => h.pageid);
  if (ids.length === 0) return [];
  const extracts = await get<WikiExtracts>({
    action: 'query',
    prop: 'extracts',
    exintro: '1',
    explaintext: '1',
    pageids: ids.join('|'),
  });
  return parseWikipediaResults(search, extracts);
}

/** The results as the model sees them. */
export function resultsBlock(hits: SearchHit[]): string {
  if (hits.length === 0) return '(no results)';
  return hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.content}`).join('\n\n');
}

// --- Not the same search twice -----------------------------------------------------------

const STOPWORDS = new Set(
  'a an and are at be before by can do does for from how in into is it its of on or that the their them this to under what when where which who why with'.split(' '),
);

function searchWords(query: string): Set<string> {
  return new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)),
  );
}

/** Same question in other words? Enough shared words, or one query almost inside the other. */
export function similarQuery(a: string, b: string): boolean {
  const x = searchWords(a);
  const y = searchWords(b);
  if (x.size === 0 || y.size === 0) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared / (x.size + y.size - shared) >= 0.4 || shared / Math.min(x.size, y.size) >= 0.75;
}

/** The earlier search this one repeats, if any. */
export function repeatedSearch<T extends { query: string }>(query: string, earlier: T[]): T | undefined {
  return [...earlier].reverse().find((e) => similarQuery(query, e.query));
}
