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

export function createSitesApp(projects: Projects, ownerName: () => string): Hono {
  const app = new Hono();

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
    return c.body(content, 200, { ...SECURITY_HEADERS, 'content-type': TYPES[ext] ?? TYPES.txt! });
  });

  return app;
}
