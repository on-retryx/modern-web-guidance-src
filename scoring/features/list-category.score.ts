/**
 * Scorecard: `list --category` filtering and `list --categories` summary (#1872).
 *
 * Contract (public CLI behaviour, src/cli/modern-web.ts):
 * - `list --category <slug>` (also `--category=<slug>`) prints the same compact JSON
 *   array as `list`, restricted to guides of that category. Comma-separated slugs
 *   select the union, in catalog order.
 * - An unknown category exits 1 and names the valid categories on stderr; stdout stays empty.
 * - `list --categories` prints a JSON array of `{ "category", "count" }` covering the
 *   catalog (counts sum to the full list length).
 * - Plain `list` output is unchanged.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defineScorecard, mean } from '../lib.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'src/cli/modern-web.ts');

interface Guide {
  id: string;
  category: string;
  description: string;
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

function cli(...args: string[]) {
  guides();
  const r = spawnSync(process.execPath, [CLI, 'list', ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1', DISABLE_TELEMETRY: '1' },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function parseIds(stdout: string): string[] | null {
  try {
    const data = JSON.parse(stdout) as { id: string }[];
    return Array.isArray(data) ? data.map((d) => d.id) : null;
  } catch {
    return null;
  }
}

function idsOf(...categories: string[]): string[] {
  return guides().filter((g) => categories.includes(g.category)).map((g) => g.id);
}

/** Credit for a filtered listing: exact = 1, right set wrong order = 0.8, partial = Jaccard * 0.6. */
function compare(actual: string[] | null, expected: string[]): number {
  if (!actual) return 0;
  if (JSON.stringify(actual) === JSON.stringify(expected)) return 1;
  const a = new Set(actual);
  const e = new Set(expected);
  const inter = [...a].filter((x) => e.has(x)).length;
  const union = new Set([...a, ...e]).size;
  if (inter === e.size && a.size === e.size) return 0.8;
  return union ? (inter / union) * 0.6 : 0;
}

export default defineScorecard({
  feature: 'list-category',
  title: 'list --category filtering and --categories summary',
  cases: [
    {
      id: 'single-category',
      description: '`list --category forms` lists exactly the forms guides',
      weight: 5,
      run: () => {
        const r = cli('--category', 'forms');
        return r.status === 0 ? compare(parseIds(r.stdout), idsOf('forms')) : 0;
      },
    },
    {
      id: 'equals-syntax',
      description: '`--category=css` works the same as `--category css`',
      weight: 2,
      run: () => {
        const r = cli('--category=css');
        return r.status === 0 ? compare(parseIds(r.stdout), idsOf('css')) : 0;
      },
    },
    {
      id: 'multiple-categories',
      description: '`--category forms,performance` lists the union in catalog order',
      weight: 4,
      run: () => {
        const r = cli('--category', 'forms,performance');
        return r.status === 0 ? compare(parseIds(r.stdout), idsOf('forms', 'performance')) : 0;
      },
    },
    {
      id: 'same-shape-as-list',
      description: 'filtered entries keep the compact {id, description} shape',
      weight: 2,
      run: () => {
        const r = cli('--category', 'forms');
        try {
          const data = JSON.parse(r.stdout) as Record<string, unknown>[];
          if (!data.length) return 0;
          return mean(data.map((d) => Object.keys(d).sort().join(',') === 'description,id'));
        } catch {
          return 0;
        }
      },
    },
    {
      id: 'unknown-category-errors',
      description: 'unknown category exits 1, stdout empty, stderr names valid categories',
      weight: 4,
      run: () => {
        const r = cli('--category', 'modals');
        return mean([
          r.status === 1,
          r.stdout.trim() === '',
          /modals/.test(r.stderr),
          r.stderr.includes('forms') && r.stderr.includes('ui-components'),
        ]);
      },
    },
    {
      id: 'categories-summary',
      description: '`list --categories` gives {category, count} for every category; counts match the catalog',
      weight: 4,
      run: () => {
        const r = cli('--categories');
        if (r.status !== 0) return 0;
        try {
          const data = JSON.parse(r.stdout) as { category: string; count: number }[];
          const expected = new Map<string, number>();
          for (const g of guides()) expected.set(g.category, (expected.get(g.category) ?? 0) + 1);
          const got = new Map(data.map((d) => [d.category, d.count]));
          const checks = [...expected].map(([c, n]) => got.get(c) === n);
          checks.push(data.length === expected.size);
          return mean(checks);
        } catch {
          return 0;
        }
      },
    },
    {
      id: 'guard-plain-list-unchanged',
      description: 'guard: plain `list` still lists the whole catalog',
      weight: 3,
      run: () => {
        const r = cli();
        return r.status === 0 && JSON.stringify(parseIds(r.stdout)) === JSON.stringify(guides().map((g) => g.id));
      },
    },
  ],
});
