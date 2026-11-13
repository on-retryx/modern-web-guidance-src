/**
 * Scorecard: `retrieve` command UX — clean errors, "did you mean" suggestions
 * and tolerant id parsing (fork-only tooling, not part of upstream PRs).
 *
 * Everything is measured through the public CLI surface: the scorecard spawns
 * `node src/cli/modern-web.ts retrieve ...` (the same entry point the repo's
 * own CLI tests use) in a fresh temp dir with HOME pointed at that dir (so no
 * `.mwgrc` leaks in), DISABLE_TELEMETRY=1, and inspects exit code, stdout and
 * stderr. No network, no LLM. Guide data is (re)built once per run with
 * `node src/build/build-guides.ts --target=skills-cli` (offline, ~2s), and the
 * guide inventory / expected guide bodies are read from the generated
 * `out/build/skills-cli/gen/guides.json` and `out/build/skills-cli/guides/`.
 *
 * Behavioural contract
 * --------------------
 * 1. Unknown id (`retrieve optimise-image-priority`):
 *    - exit code 1, nothing that looks like a guide on stdout;
 *    - a concise error on stderr that names the requested id and contains NO
 *      stack trace (no `    at ...` frames, no `file://` / `node:internal`
 *      locations), at most ~8 non-empty lines;
 *    - up to 3 "did you mean" suggestions of real guide ids on STDERR, ordered
 *      most-similar first (`optimise-image-priority` -> `optimize-image-priority`,
 *      `dialgo` -> `dialog`, `passkey-registraton` -> `passkey-registration`).
 * 2. Hopeless input (`zzzz-qqq`): exit 1, no stack trace, and no suggestions.
 * 3. Tolerant parsing: ids are case-insensitive and may carry a leading
 *    `guides/<category>/` or `<category>/` prefix and/or a trailing
 *    `/guide.md` or `.md` suffix; such input resolves to the guide (exit 0,
 *    guide body on stdout). Tolerant spellings of a gated guide are still gated.
 *    Tolerant spellings of an unknown id still get suggestions.
 * 4. Mixed requests (`retrieve switch,dialgo` or `retrieve dialgo switch`):
 *    the valid guide is still printed to stdout, exit code 1, and the unknown
 *    id gets suggestions on stderr without a stack trace.
 * 5. No regressions: plain valid ids produce byte-identical stdout
 *    (`\n--- Guide for <id> ---\n<guide.md>\n` per guide) and empty stderr;
 *    origin-trial / volatile feature gates print the same `> [!CAUTION]`
 *    message (no stack trace, no suggestions); `retrieve` with no ids still
 *    fails with "No IDs provided".
 *
 * How suggestions are detected (implementers: format freely, but note this):
 * a "suggestion" is any real guide id that appears in stderr as a standalone
 * token — not preceded by [A-Za-z0-9_-] and not followed by [A-Za-z0-9_/-] —
 * ranked by first appearance. So print suggestions as canonical lowercase ids
 * (a `category/` prefix before the id is fine), and do not mention other guide
 * ids in the error text (beware generic words that are also guide ids, e.g.
 * `css`, `forms`, `dialog`, `menu`, `performance`), or they count as extra or
 * bogus suggestions. Rank credit: 1.0 when the expected id is the first
 * suggestion, 0.5 when it is 2nd or 3rd, 0 otherwise.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineScorecard, lowerIsBetter, mean } from '../lib.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'src/cli/modern-web.ts');
const DATA_DIR = path.join(ROOT, 'out/build/skills-cli');
const CASE_TIMEOUT_MS = 45_000;

interface InventoryEntry {
  id: string;
  category: string;
  tokenCount: number;
  originTrials?: unknown[];
  volatileFeatures?: unknown[];
}

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

let inventoryCache: InventoryEntry[] | undefined;

/** Build guide data once per scorecard run and return the guide inventory. */
function inventory(): InventoryEntry[] {
  if (inventoryCache) return inventoryCache;
  const build = spawnSync(process.execPath, ['src/build/build-guides.ts', '--target=skills-cli'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, DISABLE_TELEMETRY: '1', NO_COLOR: '1' },
    timeout: 120_000,
  });
  const guidesJson = path.join(DATA_DIR, 'gen/guides.json');
  if (build.status !== 0 || !existsSync(guidesJson)) {
    throw new Error(`guide build failed (status ${build.status}): ${(build.stderr || build.stdout).slice(-400)}`);
  }
  inventoryCache = JSON.parse(readFileSync(guidesJson, 'utf8')) as InventoryEntry[];
  return inventoryCache;
}

function guide(id: string): InventoryEntry {
  const entry = inventory().find((u) => u.id === id);
  if (!entry) throw new Error(`fixture guide "${id}" is missing from the inventory`);
  return entry;
}

/** Raw guide markdown exactly as `retrieve` prints it today (no .mwgrc banner). */
function guideBody(id: string): string {
  const { category } = guide(id);
  return readFileSync(path.join(DATA_DIR, 'guides', category, `${id}.md`), 'utf8');
}

/** Exact stdout of a successful plain `retrieve` of these ids (inline output). */
function expectedStdout(ids: string[]): string {
  return ids.map((id) => `\n--- Guide for ${id} ---\n${guideBody(id)}`).join('\n') + '\n';
}

function guideSection(id: string): string {
  return `--- Guide for ${id} ---\n${guideBody(id)}`;
}

function runCli(args: string[], mwgrc?: Record<string, unknown>): CliResult {
  inventory();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mwg-score-retrieve-'));
  try {
    if (mwgrc) writeFileSync(path.join(dir, '.mwgrc'), JSON.stringify(mwgrc));
    const r = spawnSync(process.execPath, [CLI, ...args], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        USERPROFILE: dir,
        DISABLE_TELEMETRY: '1',
        NO_COLOR: '1',
      },
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function hasStackTrace(text: string): boolean {
  return /^\s+at\s+\S/m.test(text) || /file:\/\//.test(text) || /\bnode:internal\b/.test(text);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Real guide ids mentioned as standalone tokens in `text`, by first appearance. */
function mentionedIds(text: string, exclude: string[] = []): string[] {
  const found: Array<{ id: string; index: number }> = [];
  for (const { id } of inventory()) {
    if (exclude.includes(id)) continue;
    const re = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(id)}(?![A-Za-z0-9_/-])`);
    const m = re.exec(text);
    if (m) found.push({ id, index: m.index });
  }
  return found.sort((a, b) => a.index - b.index || b.id.length - a.id.length).map((f) => f.id);
}

/** 1.0 if `expected` is the first suggestion, 0.5 if 2nd/3rd, else 0. */
function rankCredit(suggestions: string[], expected: string): number {
  const idx = suggestions.indexOf(expected);
  if (idx === 0) return 1;
  if (idx > 0 && idx < 3) return 0.5;
  return 0;
}

function nonEmptyLines(text: string): number {
  return text.split('\n').filter((l) => l.trim()).length;
}

/** Resolves to the guide: exit 0, guide body on stdout, no stack trace. */
function resolvesTo(query: string, id: string): boolean {
  const r = runCli(['retrieve', query]);
  return r.status === 0 && r.stdout.includes(guideBody(id)) && !hasStackTrace(r.stderr);
}

/** Unknown id: rank credit of `expected` among stderr suggestions (requires exit 1). */
function suggestionCredit(query: string, expected: string): number {
  guide(expected);
  const r = runCli(['retrieve', query]);
  if (r.status !== 1) return 0;
  return rankCredit(mentionedIds(r.stderr), expected);
}

function firstGuideWith(pred: (u: InventoryEntry) => boolean): InventoryEntry {
  const candidates = inventory().filter(pred).sort((a, b) => a.tokenCount - b.tokenCount);
  if (!candidates.length) throw new Error('no fixture guide matches');
  return candidates[0];
}

const otGuide = (): InventoryEntry => firstGuideWith((u) => (u.originTrials?.length ?? 0) > 0);
const volatileGuide = (): InventoryEntry =>
  firstGuideWith((u) => (u.volatileFeatures?.length ?? 0) > 0 && !(u.originTrials?.length ?? 0));

function isCleanGate(r: CliResult, id: string, command: string): boolean {
  return (
    r.status === 1 &&
    r.stderr.trimStart().startsWith('> [!CAUTION]') &&
    r.stderr.includes(command) &&
    !hasStackTrace(r.stderr) &&
    !r.stdout.includes('--- Guide for') &&
    mentionedIds(r.stderr, [id]).length === 0
  );
}

export default defineScorecard({
  feature: 'retrieve-suggestions',
  title: 'retrieve: clean unknown-id errors, did-you-mean suggestions, tolerant ids',
  cases: [
    {
      id: 'unknown-id-clean-error',
      description:
        'Unknown id exits 1 with no stack trace, names the requested id on stderr and prints no guide on stdout',
      weight: 3,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        mean(
          ['optimise-image-priority', 'dialgo'].map((q) => {
            const r = runCli(['retrieve', q]);
            if (hasStackTrace(r.stderr) || hasStackTrace(r.stdout)) return 0;
            return mean([r.status === 1, r.stderr.includes(q), !r.stdout.includes('--- Guide for')]);
          }),
        ),
    },
    {
      id: 'unknown-id-concise',
      description: 'Unknown-id stderr is concise: <= 8 non-empty lines full credit, >= 16 none (stack trace = 0)',
      weight: 1,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        mean(
          ['optimise-image-priority', 'dialgo'].map((q) => {
            const r = runCli(['retrieve', q]);
            if (hasStackTrace(r.stderr) || r.status !== 1) return 0;
            return lowerIsBetter(nonEmptyLines(r.stderr), 8, 16);
          }),
        ),
    },
    {
      id: 'suggest-optimise-image-priority',
      description: 'optimise-image-priority suggests optimize-image-priority first (spec example)',
      weight: 4,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () => suggestionCredit('optimise-image-priority', 'optimize-image-priority'),
    },
    {
      id: 'suggest-dialgo',
      description: 'dialgo suggests dialog first (1.0), another *dialog* guide first (0.75), dialog in top 3 (0.5)',
      weight: 3,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () => {
        guide('dialog');
        const r = runCli(['retrieve', 'dialgo']);
        if (r.status !== 1) return 0;
        const s = mentionedIds(r.stderr);
        if (s[0] === 'dialog') return 1;
        if (s[0]?.includes('dialog')) return 0.75;
        return rankCredit(s, 'dialog');
      },
    },
    {
      id: 'suggest-typo-battery',
      description:
        'Common typos (missing/extra/transposed chars, plural, missing word, upper case) rank the intended guide first',
      weight: 3,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        mean(
          [
            ['passkey-registraton', 'passkey-registration'],
            ['light-dismiss-dialog', 'light-dismiss-a-dialog'],
            ['css-layouts', 'css-layout'],
            ['DIALGO', 'dialog'],
            ['optimize-script-prioirty', 'optimize-script-priority'],
            ['scrollspi', 'scrollspy'],
            ['acordion', 'accordion'],
          ].map(([q, expected]) => suggestionCredit(q, expected)),
        ),
    },
    {
      id: 'suggest-partial-id',
      description: 'Truncated / partial ids still surface the intended guide (substring/prefix-aware similarity)',
      weight: 1.5,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        mean(
          [
            ['image-priority', 'optimize-image-priority'],
            ['sanitize-html', 'sanitize-untrusted-html'],
            ['passkey-reauth', 'passkey-reauthentication'],
          ].map(([q, expected]) => suggestionCredit(q, expected)),
        ),
    },
    {
      id: 'suggestions-capped-at-three',
      description: 'Near-miss ids get between 1 and 3 suggestions (even when many guides are similar)',
      weight: 2,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        mean(
          ['optimize-priority', 'scroll-snap', 'dialgo', 'passkey-registraton'].map((q) => {
            const r = runCli(['retrieve', q]);
            const n = mentionedIds(r.stderr).length;
            return r.status === 1 && n >= 1 && n <= 3;
          }),
        ),
    },
    {
      id: 'garbage-no-suggestions',
      description: 'Hopeless ids: exit 1, no stack trace (else 0), and no bogus guide-id suggestions',
      weight: 3,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        mean(
          ['zzzz-qqq', 'xqzv-wkjp-ffff'].map((q) => {
            const r = runCli(['retrieve', q]);
            if (hasStackTrace(r.stderr)) return 0;
            const clean = r.status === 1 && !r.stdout.includes('--- Guide for');
            return (clean ? 0.3 : 0) + (mentionedIds(r.stderr).length === 0 ? 0.7 : 0);
          }),
        ),
    },
    {
      id: 'case-insensitive-ids',
      description: 'Ids are case-insensitive (also combined with category prefix and .md suffix)',
      weight: 2,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        mean([
          resolvesTo('OPTIMIZE-IMAGE-PRIORITY', 'optimize-image-priority'),
          resolvesTo('Switch', 'switch'),
          resolvesTo('Break-Up-Long-Tasks', 'break-up-long-tasks'),
          resolvesTo('Forms/Switch.md', 'switch'),
        ]),
    },
    {
      id: 'category-prefix-ids',
      description: 'Leading `<category>/` and `guides/<category>/` prefixes resolve, also in multi-id requests',
      weight: 2,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () => {
        const multi = runCli(['retrieve', 'forms/switch,guides/performance/break-up-long-tasks']);
        return mean([
          resolvesTo('performance/optimize-image-priority', 'optimize-image-priority'),
          resolvesTo('guides/performance/optimize-image-priority', 'optimize-image-priority'),
          resolvesTo('forms/switch', 'switch'),
          resolvesTo('guides/forms/switch', 'switch'),
          multi.status === 0 &&
            multi.stdout.includes(guideBody('switch')) &&
            multi.stdout.includes(guideBody('break-up-long-tasks')),
        ]);
      },
    },
    {
      id: 'file-suffix-ids',
      description: 'Trailing `.md` and `/guide.md` suffixes resolve (alone and with a category prefix)',
      weight: 2,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        mean([
          resolvesTo('optimize-image-priority.md', 'optimize-image-priority'),
          resolvesTo('optimize-image-priority/guide.md', 'optimize-image-priority'),
          resolvesTo('guides/performance/optimize-image-priority/guide.md', 'optimize-image-priority'),
          resolvesTo('forms/switch.md', 'switch'),
          resolvesTo('guides/forms/switch/guide.md', 'switch'),
        ]),
    },
    {
      id: 'tolerant-gated-still-gated',
      description: 'A tolerant spelling of a gated guide is still gated (CAUTION, exit 1, no guide, no stack trace)',
      weight: 2,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () => {
        const ot = otGuide();
        const vol = volatileGuide();
        const otQuery = `${ot.category.toUpperCase()}/${ot.id.toUpperCase()}.md`;
        const volQuery = `guides/${vol.category}/${vol.id}/guide.md`;
        const check = (q: string, command: string): number => {
          const r = runCli(['retrieve', q]);
          return mean([
            r.status === 1,
            r.stderr.trimStart().startsWith('> [!CAUTION]') && r.stderr.includes(command),
            !hasStackTrace(r.stderr),
            !r.stdout.includes('--- Guide for'),
          ]) === 1
            ? 1
            : 0;
        };
        return mean([check(otQuery, 'set-allow-origin-trials'), check(volQuery, 'set-allow-volatile-features')]);
      },
    },
    {
      id: 'tolerant-unknown-suggests',
      description: 'An unknown id wrapped in prefix/suffix/case noise still gets suggestions for the normalized id',
      weight: 1,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        mean([
          suggestionCredit('guides/performance/optimise-image-priority/guide.md', 'optimize-image-priority'),
          suggestionCredit('ui-components/DIALGO.md', 'dialog'),
        ]),
    },
    {
      id: 'mixed-valid-and-unknown',
      description:
        'switch + dialgo (comma or separate args, either order): switch still printed, exit 1; then no stack (0.4) and dialog suggested (0.6, rank credit)',
      weight: 3,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        mean(
          [['switch,dialgo'], ['dialgo', 'switch']].map((args) => {
            const r = runCli(['retrieve', ...args]);
            if (r.status !== 1 || !r.stdout.includes(guideSection('switch'))) return 0;
            const noStack = !hasStackTrace(r.stderr) && !hasStackTrace(r.stdout);
            return 0.4 * (noStack ? 1 : 0) + 0.6 * rankCredit(mentionedIds(r.stderr, ['switch']), 'dialog');
          }),
        ),
    },
    {
      id: 'regression-plain-valid-ids',
      description: 'Regression guard: plain valid ids give byte-identical stdout, empty stderr, exit 0',
      weight: 3,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        mean(
          [
            ['switch'],
            ['optimize-image-priority'],
            ['deprioritize-background-fetches,break-up-long-tasks'],
            ['deprioritize-background-fetches', 'break-up-long-tasks'],
          ].map((args) => {
            const ids = args.flatMap((a) => a.split(','));
            const r = runCli(['retrieve', ...args]);
            return r.status === 0 && r.stdout === expectedStdout(ids) && r.stderr === '';
          }),
        ),
    },
    {
      id: 'regression-feature-gates',
      description:
        'Regression guard: origin-trial / volatile gates unchanged (CAUTION on stderr, exit 1, no stack, no suggestions; opt-in/opt-out honoured; mixed valid+gated)',
      weight: 2,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () => {
        const ot = otGuide();
        const vol = volatileGuide();
        const otRes = runCli(['retrieve', ot.id]);
        const volRes = runCli(['retrieve', vol.id]);
        const optedIn = runCli(['retrieve', vol.id], { allowVolatileFeatures: true });
        const optedOut = runCli(['retrieve', ot.id], { allowOriginTrials: false });
        const mixed = runCli(['retrieve', `switch,${ot.id}`]);
        return mean([
          isCleanGate(otRes, ot.id, 'set-allow-origin-trials'),
          isCleanGate(volRes, vol.id, 'set-allow-volatile-features'),
          optedIn.status === 0 && optedIn.stdout === expectedStdout([vol.id]),
          isCleanGate(optedOut, ot.id, 'set-allow-origin-trials') &&
            optedOut.stderr.includes('"allowOriginTrials": false'),
          mixed.status === 1 &&
            mixed.stdout === expectedStdout(['switch']) &&
            mixed.stderr.trimStart().startsWith('> [!CAUTION]') &&
            !hasStackTrace(mixed.stderr),
        ]);
      },
    },
    {
      id: 'regression-no-ids',
      description: 'Regression guard: `retrieve` with no ids still exits 1 with "No IDs provided for retrieve."',
      weight: 0.5,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () => {
        const r = runCli(['retrieve']);
        return r.status === 1 && r.stderr.includes('No IDs provided for retrieve.') && !hasStackTrace(r.stderr);
      },
    },
  ],
});
