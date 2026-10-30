import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { cleanProjectPath } from '@ampli-world/shared';
import type { Projects } from './projects.ts';

// The character's websites, on their own port, each page in a sandbox. The code is
// written by a model, so it gets no network (no fetch, no forms, nothing loaded from
// elsewhere) and an opaque origin: it can't talk to the town or to anything else.

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
};

export const SITE_CSP = [
  // Opaque origin: no cookies, no storage, and any request it makes carries Origin: null.
  'sandbox allow-scripts',
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

// No Cross-Origin-Resource-Policy: the sandbox gives each page an opaque origin, so to the
// browser even its own style.css is "cross-origin", and CORP: same-origin would block it.
const SECURITY_HEADERS = {
  'content-security-policy': SITE_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cache-control': 'no-cache',
};

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A few lines put in front of every page: when it stops with an error, the browser tells the
 * sites server, as a tiny image request (the one way out the sandbox allows), so the character
 * hears about it. Put on the same line as <head>, so the page's line numbers stay the same.
 */
function withReporter(html: string, reportUrl: string): string {
  const script =
    `<script>(()=>{const seen=new Set();const send=(m,f,l)=>{const k=m+'|'+f+'|'+l;if(seen.has(k)||seen.size>=5)return;seen.add(k);` +
    `new Image().src=${JSON.stringify(reportUrl)}+'?m='+encodeURIComponent(String(m).slice(0,300))+'&f='+encodeURIComponent(f||'')+'&l='+(l|0)};` +
    `addEventListener('error',(e)=>send(e.message,e.filename,e.lineno));` +
    `addEventListener('unhandledrejection',(e)=>send('Uncaught (in promise) '+((e.reason&&e.reason.message)||e.reason),'',0))})();</script>`;
  const at = /<head\b[^>]*>/i.exec(html) ?? /<html\b[^>]*>/i.exec(html) ?? /<!doctype[^>]*>/i.exec(html);
  const i = at ? at.index + at[0].length : 0;
  // In the sandbox even the page's own script files count as cross-origin: without
  // `crossorigin` (and the header on .js below) their errors arrive as "Script error.", no line.
  return (html.slice(0, i) + script + html.slice(i)).replace(/<script\b(?![^>]*\bcrossorigin)(?=[^>]*\bsrc\s*=)/gi, '<script crossorigin');
}

/** "index.html, line 190: ReferenceError: …", from what the browser sent. Null when there's nothing to say. */
export function reportedProblem(slug: string, report: { m?: string; f?: string; l?: string }): string | null {
  const message = (report.m ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^Uncaught (?!\(in promise\))/, '')
    .trim()
    .slice(0, 200);
  if (!message) return null;
  let file: string | null = null;
  try {
    const path = decodeURIComponent(new URL(report.f ?? '').pathname);
    const rest = path.startsWith(`/${slug}/`) ? path.slice(slug.length + 2) : null;
    if (rest !== null) file = cleanProjectPath(rest === '' || rest.endsWith('/') ? `${rest}index.html` : rest);
  } catch {
    // No file, or not one of this site's.
  }
  const line = Math.floor(Number(report.l));
  const where = file ? `${file}${line > 0 ? `, line ${line}` : ''}: ` : '';
  const what = message === 'Script error.' ? 'a script stopped with an error (no details)' : message;
  return `${where}${what} (it stopped there when someone opened the page)`;
}

export function createSitesApp(
  projects: Projects,
  ownerName: () => string,
  /** A page broke in someone's browser, and it's news (not reported before). */
  onError?: (project: { slug: string; name: string }, problem: string) => void,
): Hono {
  const app = new Hono();
  // Only pages this server handed out can report: the key is tied to the site and its version.
  const secret = randomBytes(32);
  const reportKey = (slug: string, version: string) => createHmac('sha256', secret).update(`${slug}\n${version}`).digest('hex').slice(0, 32);
  const sameKey = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  /** A plain index of all sites; only names and descriptions, escaped. */
  app.get('/', (c) => {
    const items = projects
      .list()
      .map((p) => `<li><a href="/${p.slug}/">${escape(p.name)}</a>${p.description ? ` — ${escape(p.description)}` : ''}</li>`)
      .join('');
    const name = escape(ownerName());
    return c.body(
      `<!doctype html><meta charset="utf-8"><title>${name}'s websites</title>` +
        `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#3b3127;background:#f6efe3}a{color:#c0632b}</style>` +
        `<h1>${name}'s websites</h1>${items ? `<ul>${items}</ul>` : '<p>Nothing here yet.</p>'}`,
      200,
      { ...SECURITY_HEADERS, 'content-type': TYPES.html! },
    );
  });

  // Browsers ask for one on their own; an empty answer keeps the console clean.
  app.get('/favicon.ico', (c) => c.body(null, 204));

  app.get('/__errors/:slug/:key', (c) => {
    const slug = c.req.param('slug');
    const version = projects.version(slug);
    if (version && sameKey(c.req.param('key'), reportKey(slug, version))) {
      const problem = reportedProblem(slug, c.req.query());
      if (problem && projects.reportError(slug, problem)) onError?.({ slug, name: projects.project(slug)?.name ?? slug }, problem);
    }
    return c.body(null, 204, SECURITY_HEADERS);
  });

  app.get('*', (c) => {
    const notFound = () => c.body('Not found', 404, { ...SECURITY_HEADERS, 'content-type': TYPES.txt! });
    let segments: string[];
    try {
      segments = c.req.path.split('/').slice(1).map(decodeURIComponent);
    } catch {
      return notFound();
    }
    const [slug = '', ...rest] = segments;
    if (!projects.project(slug)) return notFound();
    // "/my-site" -> "/my-site/", so relative links in its pages work.
    if (segments.length === 1) return c.redirect(`/${encodeURIComponent(slug)}/`, 301);
    const path = rest.join('/') || 'index.html';
    const clean = cleanProjectPath(path.endsWith('/') ? `${path}index.html` : path);
    const content = clean ? projects.file(slug, clean) : null;
    if (!clean || content === null) return notFound();
    const ext = clean.slice(clean.lastIndexOf('.') + 1).toLowerCase();
    const version = projects.version(slug);
    const body = ext === 'html' && version ? withReporter(content, `/__errors/${slug}/${reportKey(slug, version)}`) : content;
    return c.body(body, 200, {
      ...SECURITY_HEADERS,
      'content-type': TYPES[ext] ?? TYPES.txt!,
      // Lets the page see its own scripts' errors (see withReporter); the files are public anyway.
      ...(ext === 'js' ? { 'access-control-allow-origin': '*' } : {}),
    });
  });

  return app;
}
