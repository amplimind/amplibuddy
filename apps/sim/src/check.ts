import { Script } from 'node:vm';
import { cleanProjectPath, type ProjectFile } from '@ampli-world/shared';

// A look over a website after each commit, so the character hears what's wrong instead of
// never knowing. Scripts are only compiled, never run: `new Script()` parses the code and
// stops there.

const MAX_PROBLEMS = 8;

/** The line of a syntax error, from V8's stack ("file.js:12"). */
function errorLine(err: Error, filename: string): number | null {
  const m = new RegExp(`${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`).exec(err.stack ?? '');
  return m ? Number(m[1]) : null;
}

function syntaxProblem(code: string, filename: string, lineOffset = 0): string | null {
  try {
    new Script(code, { filename });
    return null;
  } catch (err) {
    if (!(err instanceof SyntaxError)) return null;
    const line = errorLine(err, filename);
    return `${filename.replace(/#inline$/, '')}${line ? `, line ${line + lineOffset}` : ''}: ${err.message}`;
  }
}

/** Things the glass house blocks, so the page would quietly fail. */
const SANDBOX_BLOCKS: [RegExp, string][] = [
  [/\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bEventSource\b/, 'talks to the network, which the sandbox blocks'],
  [/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie/, 'stores data in the browser, which the sandbox blocks (everything starts fresh each visit)'],
  [/\b(alert|confirm|prompt)\s*\(/, 'uses alert/confirm/prompt, which the sandbox blocks; show messages on the page instead'],
];

/** Problems with a website as a whole, as short plain sentences. Empty when all looks fine. */
export function checkProject(files: ProjectFile[]): string[] {
  const problems: string[] = [];
  const paths = new Set(files.map((f) => f.path));
  if (!paths.has('index.html')) problems.push('there is no index.html, so the site has no start page');

  for (const file of files) {
    if (file.path.endsWith('.js')) {
      const problem = syntaxProblem(file.content, file.path);
      if (problem) problems.push(problem);
    }
    if (file.path.endsWith('.json')) {
      try {
        JSON.parse(file.content);
      } catch (err) {
        problems.push(`${file.path}: ${(err as Error).message}`);
      }
    }
    if (!file.path.endsWith('.html')) {
      if (file.path.endsWith('.js')) {
        for (const [pattern, why] of SANDBOX_BLOCKS) if (pattern.test(file.content)) problems.push(`${file.path} ${why}`);
      }
      continue;
    }

    // HTML: inline scripts, references to other files, and what the sandbox won't do.
    const html = file.content;
    const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      const attrs = m[1] ?? '';
      if (/\btype\s*=\s*["']?module/i.test(attrs)) problems.push(`${file.path} uses <script type="module">, which can't load in the sandbox; use a plain <script src="…" defer>`);
      if (/\bsrc\s*=/.test(attrs) || /\btype\s*=\s*["']?(application\/json|text\/template)/i.test(attrs)) continue;
      const startLine = html.slice(0, m.index).split('\n').length - 1;
      const problem = syntaxProblem(m[2] ?? '', `${file.path}#inline`, startLine);
      if (problem) problems.push(problem.replace(/^([^,:]+)/, '$1 (inline script)'));
      for (const [pattern, why] of SANDBOX_BLOCKS) if (pattern.test(m[2] ?? '')) problems.push(`${file.path} ${why}`);
    }
    for (const m of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"'#?]+)[^"']*["']/gi)) {
      const ref = m[1]!.trim();
      if (/^(data:|mailto:|javascript:)/i.test(ref)) continue;
      if (/^(https?:)?\/\//i.test(ref)) {
        problems.push(`${file.path} loads ${ref} from the internet, which the sandbox blocks`);
        continue;
      }
      if (ref.startsWith('/')) {
        problems.push(`${file.path} links to "${ref}" with a leading slash; write it relative ("${ref.slice(1)}") or it won't be found`);
        continue;
      }
      const target = cleanProjectPath(`${dir}${ref}`.replace(/\/[^/]+\/\.\.\//g, '/'));
      if (target && !paths.has(target) && !ref.endsWith('/')) problems.push(`${file.path} links to ${ref}, which isn't in the project`);
    }
    if (/<form\b/i.test(html)) problems.push(`${file.path} has a <form>; sending forms is blocked, so handle the input with JavaScript instead`);
  }
  return [...new Set(problems)].slice(0, MAX_PROBLEMS);
}
