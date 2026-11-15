/**
 * Scorecard v2: `list --category` filtering and `list --categories` summary (#1872).
 *
 * Stricter successor of the locked `list-category` scorecard (round-2 review found
 * v1 too lenient). Everything is specified through public surfaces only: the CLI
 * (`node src/cli/modern-web.ts list ...`: exit code, stdout, stderr, `--help`), the
 * built catalog (`out/build/skills-cli/gen/guides.json`, i.e. what plain `list`
 * prints), the category registry `CATEGORIES` (src/core/categories.ts) for
 * tie-breaking, and the command snippets in guides/modern-web-guidance/SKILL.md.
 *
 * Contract
 * - "Catalog order" below means the order in which plain `list` prints guides.
 * - `list --category <slugs>` / `--category=<slugs>` / `-c <slugs>` (issue: "--category
 *   (or -c), supporting comma-separated values") prints the same compact JSON as `list`
 *   (array of `{id, description}`, one entry per line, issue item 4), restricted to the
 *   union of the given categories, in catalog order (independent of the order the slugs
 *   are given in), without duplicates (`forms,forms` == `forms`).
 * - Unknown slug(s), alone or mixed with valid ones: exit 1, stdout empty, stderr names
 *   each unknown slug and lists every valid category slug (issue item 3). No stack trace.
 * - Missing or empty value (`--category` with nothing after it, `--category=`,
 *   `--category ""`, `--category ,`, `--category=,`, bare `-c`) is an error, not a
 *   silent full listing: exit 1, stdout empty, stderr lists every valid slug.
 * - Case: `Forms` may either be matched case-insensitively (exact `forms` listing) or be
 *   rejected like any unknown slug (exit 1 + valid list). Anything else scores 0.
 * - `--category` combined with `--categories` (issue does not specify): error, exit 1,
 *   stdout empty, stderr names both flags.
 * - Extra positionals after `list --category forms` (e.g. `performance`) must not be
 *   silently dropped: either treat them as more categories (union) or fail (non-zero
 *   exit, stdout empty, stderr non-empty).
 * - `list --categories` prints a JSON array of exactly `{category, count}` objects, one
 *   per line, one per category in the catalog with its exact guide count, ordered by
 *   count descending (as in the issue's example output), ties broken by `CATEGORIES`
 *   registry order (catalog-order fallback from the round-2 decisions).
 * - `--help` documents `--category`, `-c` and `--categories`; SKILL.md documents them and
 *   every `list` invocation it shows with these flags runs successfully (placeholders
 *   such as `<category>` are substituted with a real slug).
 * - Regression guards: plain `list` output is byte-for-byte unchanged; `search` and
 *   `retrieve` still work.
 *
 * Grading: per-case partial credit is the fraction of variants (or sub-checks) that pass;
 * each error variant is all-or-nothing (exit code, empty stdout and stderr content
 * together). Deterministic and offline; whole run takes a few seconds.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defineScorecard, mean, ratio } from '../lib.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'src/cli/modern-web.ts');
const SKILL_MD = path.join(ROOT, 'guides/modern-web-guidance/SKILL.md');

interface Guide {
  id: string;
  category: string;
  description: string;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

let catalog: Guide[] | null = null;
function guides(): Guide[] {
  if (catalog) return catalog;
  const r = spawnSync(process.execPath, ['src/build/build-guides.ts', '--target=skills-cli'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`build-guides failed: ${r.stderr.slice(0, 300)}`);
  const file = path.join(ROOT, 'out/build/skills-cli/gen/guides.json');
  catalog = JSON.parse(fs.readFileSync(file, 'utf8')) as Guide[];
  return catalog;
}

function run(...args: string[]): Run {
  guides();
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1', DISABLE_TELEMETRY: '1' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const list = (...args: string[]) => run('list', ...args);

/** Category slugs present in the catalog, in first-seen order. */
function slugs(): string[] {
  return [...new Set(guides().map((g) => g.category))];
}

function idsOf(...categories: string[]): string[] {
  return guides().filter((g) => categories.includes(g.category)).map((g) => g.id);
}

function parseArray(stdout: string): Record<string, unknown>[] | null {
  try {
    const data: unknown = JSON.parse(stdout);
    return Array.isArray(data) ? (data as Record<string, unknown>[]) : null;
  } catch {
    return null;
  }
}

function parseIds(stdout: string): string[] | null {
  const data = parseArray(stdout);
  return data ? data.map((d) => String(d.id)) : null;
}

/** Exact listing (order + no duplicates) = 1, right set but wrong order/duplicates = 0.5, else 0. */
function listingCredit(r: Run, expected: string[]): number {
  if (r.status !== 0) return 0;
  const actual = parseIds(r.stdout);
  if (!actual) return 0;
  if (JSON.stringify(actual) === JSON.stringify(expected)) return 1;
  const a = new Set(actual);
  const sameSet = a.size === expected.length && expected.every((id) => a.has(id));
  return sameSet ? 0.5 : 0;
}

const hasStackTrace = (s: string) => /\n\s+at\s/.test(s);
const namesAllSlugs = (s: string) => slugs().every((slug) => new RegExp(`(^|[^a-z0-9-])${slug}([^a-z0-9-]|$)`).test(s));

/** A clean usage error: exit 1, nothing on stdout, stderr lists every valid slug, no stack trace. */
function isCategoryError(r: Run): boolean {
  return r.status === 1 && r.stdout.trim() === '' && namesAllSlugs(r.stderr) && !hasStackTrace(r.stderr);
}

/** True when every JSON array entry sits on its own single line (issue item 4: compact output). */
function oneEntryPerLine(stdout: string): boolean {
  const data = parseArray(stdout);
  if (!data) return false;
  let count = 0;
  for (const line of stdout.split('\n')) {
    const t = line.trim().replace(/^\[/, '').replace(/\]$/, '').replace(/,$/, '').trim();
    if (t === '') continue;
    try {
      const obj: unknown = JSON.parse(t);
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
      count++;
    } catch {
      return false;
    }
  }
  return count === data.length;
}

function expectedCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const g of guides()) counts.set(g.category, (counts.get(g.category) ?? 0) + 1);
  return counts;
}

/** Split a shell-ish argument string (handles simple single/double quotes). */
function shellSplit(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** `list` invocations with category flags shown in code (fenced or inline) in SKILL.md. */
function skillListInvocations(md: string): string[][] {
  const segments: string[] = [];
  const withoutFences = md.replace(/```[^\n]*\n([\s\S]*?)```/g, (_, body: string) => {
    segments.push(...body.split('\n'));
    return '';
  });
  for (const m of withoutFences.matchAll(/`([^`\n]+)`/g)) segments.push(m[1]);
  const invocations: string[][] = [];
  for (const seg of segments) {
    const m = seg.match(/(?:^|\s)list(\s.*)?$/);
    if (!m || !m[1]) continue;
    const tokens: string[] = [];
    for (const tok of shellSplit(m[1].split(/\s(?:\||&&|;|#)\s?/)[0])) tokens.push(tok);
    const isFlag = (t: string) => /^(--category|--categories|-c)(=|$)/.test(t);
    if (!tokens.some(isFlag)) continue;
    const args: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '--skill-version') { i++; continue; }
      if (tokens[i].startsWith('--skill-version=')) continue;
      args.push(tokens[i].replace(/<[^>]*>|\{[^}]*\}/g, 'forms'));
    }
    invocations.push(args);
  }
  return invocations;
}

export default defineScorecard({
  feature: 'list-category-v2',
  title: 'list --category / -c filtering and --categories summary (strict v2)',
  cases: [
    {
      id: 'single-category',
      description: '`list --category forms` lists exactly the forms guides, in catalog order',
      weight: 5,
      run: () => listingCredit(list('--category', 'forms'), idsOf('forms')),
    },
    {
      id: 'equals-syntax',
      description: '`--category=css` behaves like `--category css`',
      weight: 2,
      run: () => listingCredit(list('--category=css'), idsOf('css')),
    },
    {
      id: 'short-alias',
      description: '`-c` is an alias of `--category` (issue): `-c forms`, `-c ui-behaviors,ui-components`',
      weight: 3,
      run: () => mean([
        listingCredit(list('-c', 'forms'), idsOf('forms')),
        listingCredit(list('-c', 'ui-behaviors,ui-components'), idsOf('ui-behaviors', 'ui-components')),
      ]),
    },
    {
      id: 'multi-category-catalog-order',
      description: 'comma-separated slugs give the union in catalog order, regardless of argument order',
      weight: 4,
      run: () => mean([
        listingCredit(list('--category', 'performance,forms'), idsOf('forms', 'performance')),
        listingCredit(list('--category=ui-components,ui-behaviors'), idsOf('ui-behaviors', 'ui-components')),
        listingCredit(list('--category', 'webmcp,accessibility,css'), idsOf('accessibility', 'css', 'webmcp')),
      ]),
    },
    {
      id: 'duplicate-slugs-deduped',
      description: 'repeated slugs (`forms,forms`, `css,forms,css`) never duplicate entries',
      weight: 3,
      run: () => mean([
        listingCredit(list('--category', 'forms,forms'), idsOf('forms')),
        listingCredit(list('--category', 'css,forms,css'), idsOf('css', 'forms')),
      ]),
    },
    {
      id: 'every-category-filters-exactly',
      description: 'for every catalog category X, `list --category X` lists exactly X\'s guides (fraction of categories)',
      weight: 4,
      run: () => {
        const all = slugs();
        return ratio(all.filter((c) => listingCredit(list('--category', c), idsOf(c)) === 1).length, all.length);
      },
    },
    {
      id: 'filtered-entry-shape',
      description: 'filtered entries are exactly {id, description} with the catalog description',
      weight: 2,
      run: () => {
        const r = list('--category', 'forms,css');
        const data = r.status === 0 ? parseArray(r.stdout) : null;
        if (!data || data.length === 0) return 0;
        const byId = new Map(guides().map((g) => [g.id, g.description]));
        return mean(data.map((d) =>
          Object.keys(d).sort().join(',') === 'description,id' && byId.has(String(d.id)) && byId.get(String(d.id)) === d.description));
      },
    },
    {
      id: 'compact-output',
      description: 'issue item 4: filtered list and --categories print one JSON entry per line',
      weight: 2,
      run: () => mean([['--category', 'forms,performance'], ['--categories']].map((args) => {
        const r = list(...args);
        return r.status === 0 && oneEntryPerLine(r.stdout);
      })),
    },
    {
      id: 'unknown-category-errors',
      description: 'unknown slug: exit 1, empty stdout, stderr names the slug and every valid category, no stack trace',
      weight: 4,
      run: () => {
        const r = list('--category', 'modals');
        if (r.status === 0) return 0;
        return mean([isCategoryError(r), /\bmodals\b/.test(r.stderr)]);
      },
    },
    {
      id: 'mixed-unknown-errors',
      description: 'any unknown slug fails the whole call (`forms,modals`; `modals,widgets` names both)',
      weight: 3,
      run: () => {
        const a = list('--category', 'forms,modals');
        const b = list('--category=modals,widgets');
        return mean([
          isCategoryError(a) && /\bmodals\b/.test(a.stderr),
          isCategoryError(b) && /\bmodals\b/.test(b.stderr) && /\bwidgets\b/.test(b.stderr),
        ]);
      },
    },
    {
      id: 'missing-or-empty-value-errors',
      description: 'missing/empty value is an error (exit 1 + valid categories), never a silent full listing',
      weight: 5,
      run: () => {
        const variants: string[][] = [
          ['--category'],
          ['--category='],
          ['--category', ''],
          ['--category', ','],
          ['--category=,'],
          ['-c'],
        ];
        return ratio(variants.filter((v) => isCategoryError(list(...v))).length, variants.length);
      },
    },
    {
      id: 'case-handling',
      description: 'uppercase slugs are either matched case-insensitively or rejected cleanly; never empty or full output',
      weight: 2,
      run: () => {
        const variants: [string, string[]][] = [['Forms', ['forms']], ['FORMS,css', ['forms', 'css']]];
        return mean(variants.map(([arg, cats]) => {
          const r = list('--category', arg);
          if (r.status === 0) return listingCredit(r, idsOf(...cats)) === 1;
          return isCategoryError(r);
        }));
      },
    },
    {
      id: 'category-with-categories-errors',
      description: '`--category` together with `--categories` is an error: exit 1, empty stdout, stderr names both flags',
      weight: 3,
      run: () => {
        const variants: string[][] = [
          ['--category', 'forms', '--categories'],
          ['--categories', '--category=forms'],
          ['--categories', '-c', 'forms'],
        ];
        return ratio(variants.filter((v) => {
          const r = list(...v);
          return r.status === 1 && r.stdout.trim() === '' && !hasStackTrace(r.stderr) &&
            /--categories\b/.test(r.stderr) && /--category(?!s)/.test(r.stderr);
        }).length, variants.length);
      },
    },
    {
      id: 'trailing-positional-not-dropped',
      description: '`list --category forms performance` either unions both or fails; never silently lists forms only',
      weight: 2,
      run: () => {
        const r = list('--category', 'forms', 'performance');
        if (r.status === 0) return listingCredit(r, idsOf('forms', 'performance')) === 1;
        return r.stdout.trim() === '' && r.stderr.trim() !== '' && !hasStackTrace(r.stderr);
      },
    },
    {
      id: 'categories-summary-content',
      description: '`list --categories`: exactly {category, count} per catalog category with exact counts, no extras/duplicates',
      weight: 4,
      run: () => {
        const r = list('--categories');
        const data = r.status === 0 ? parseArray(r.stdout) : null;
        if (!data) return 0;
        const expected = expectedCounts();
        const shapeOk = data.every((d) => Object.keys(d).sort().join(',') === 'category,count' && Number.isInteger(d.count));
        const got = new Map(data.map((d) => [String(d.category), d.count]));
        const countsOk = ratio([...expected].filter(([c, n]) => got.get(c) === n).length, expected.size);
        const noExtras = data.length === expected.size && got.size === data.length;
        return mean([shapeOk, countsOk, noExtras]);
      },
    },
    {
      id: 'categories-summary-order',
      description: '--categories ordered by count descending (issue example), ties in CATEGORIES registry order',
      weight: 3,
      run: async () => {
        const { CATEGORIES } = await import('../../src/core/categories.ts');
        const registry = CATEGORIES.map((c: { slug: string }) => c.slug);
        const r = list('--categories');
        const data = r.status === 0 ? parseArray(r.stdout) : null;
        if (!data || data.length === 0) return 0;
        const expected = [...expectedCounts()]
          .sort((a, b) => b[1] - a[1] || registry.indexOf(a[0]) - registry.indexOf(b[0]))
          .map(([c]) => c);
        const actual = data.map((d) => String(d.category));
        if (JSON.stringify(actual) === JSON.stringify(expected)) return 1;
        const counts = data.map((d) => Number(d.count));
        const nonIncreasing = counts.every((n, i) => i === 0 || counts[i - 1] >= n);
        return nonIncreasing ? 0.6 : 0;
      },
    },
    {
      id: 'help-documents-flags',
      description: '`--help` documents `--category`, its `-c` alias and `--categories`',
      weight: 2,
      run: () => {
        const r = run('--help');
        const text = r.stdout + r.stderr;
        return mean([/--category(?!s)/.test(text), /(^|[\s,|[(])-c\b(?!-)/m.test(text), /--categories\b/.test(text)]);
      },
    },
    {
      id: 'skill-md-documents-flags',
      description: 'issue item 5: SKILL.md mentions --category and --categories, and its list snippets using them run',
      weight: 3,
      run: () => {
        const md = fs.readFileSync(SKILL_MD, 'utf8');
        const mentionsCategory = /--category(?!s)/.test(md);
        const mentionsCategories = /--categories\b/.test(md);
        const invocations = skillListInvocations(md);
        const snippetsRun = invocations.length > 0 && invocations.every((args) => {
          const r = list(...args);
          const data = r.status === 0 ? parseArray(r.stdout) : null;
          return !!data && data.length > 0;
        });
        return mean([mentionsCategory, mentionsCategories, snippetsRun]);
      },
    },
    {
      id: 'guard-plain-list-unchanged',
      description: 'guard: plain `list` output is byte-identical to before (0.7 if only semantically identical)',
      weight: 4,
      run: () => {
        const r = list();
        if (r.status !== 0) return 0;
        const expected = '[' + guides().map(({ id, description }) => JSON.stringify({ id, description })).join(',\n') + ']\n';
        if (r.stdout === expected) return 1;
        const data = parseArray(r.stdout);
        return JSON.stringify(data) === JSON.stringify(guides().map(({ id, description }) => ({ id, description }))) ? 0.7 : 0;
      },
    },
    {
      id: 'guard-other-commands',
      description: 'guard: `search` and `retrieve` still work',
      weight: 2,
      run: () => {
        const s = run('search', 'light dismiss dialog');
        // Smallest guide, so retrieve prints inline instead of spilling to a temp file.
        const first = [...guides() as (Guide & { tokenCount?: number })[]]
          .sort((a, b) => (a.tokenCount ?? 0) - (b.tokenCount ?? 0) || a.id.localeCompare(b.id))[0].id;
        const r = run('retrieve', first);
        const searchOk = s.status === 0 && (parseArray(s.stdout)?.length ?? 0) > 0;
        const retrieveOk = r.status === 0 && r.stdout.includes(first);
        return mean([searchOk, retrieveOk]);
      },
    },
  ],
});
