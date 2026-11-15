/**
 * Scorecard v2 (stricter): `legacy-scan --max-files <n>` (#3596).
 *
 * Written by an independent test author after the round-1 review found the v1
 * scorecard (`max-files.score.ts`, locked, untouched) too lenient: one flat
 * fixture of identical `.html` files, no git repo, no nesting, no cap above the
 * file count, no single-file target, and "reject" cases that only checked that
 * the message mentioned the option.
 *
 * Contract, observed only through public surfaces (`runAnalyzeCli` exit code,
 * stdout/stderr, `--json` output, `--help`, the README options table, the
 * `src/analyzing/cli.ts` entry point (bundled as legacy-scan) run as a
 * subprocess, and the repo dev CLI's `gd --help`):
 *
 * 1. `--max-files <n>` / `--max-files=<n>` caps how many files a DIRECTORY scan
 *    collects and scans, replacing the built-in default cap (5000).
 *    - The cap counts files, not findings: every scanned file keeps all of its
 *      findings (a "slice the findings after scanning" implementation fails).
 *    - It is one cap for the whole tree (nested directories, every scannable
 *      extension), in both enumeration modes: a plain directory walk and a git
 *      work tree (`git ls-files` incl. untracked, honouring `.gitignore`).
 *    - Scannable files without findings still consume the cap (the cap limits
 *      work done, not reported files). Files that are never scanned (ignored
 *      directories such as node_modules/dist, non-source files, docs/tests
 *      unless `--include-docs-and-tests`, gitignored files) do NOT consume it.
 *    - Selection is deterministic and prefix-stable: the files scanned with cap
 *      n are a subset of those scanned with cap n+1. Which files come first is
 *      NOT specified (any fixed order is fine).
 *    - A cap at or above the number of scannable files changes nothing; a cap
 *      above 5000 lifts the default limit (the issue's real scenario).
 * 2. A single-file target is never truncated by the cap (it still is one file
 *    with all its findings), but the value is still validated.
 * 3. The value must be a strictly positive DECIMAL integer (decision from the
 *    review: keep the strict validation). `0`, `-3`, `abc`, `1.5`, `3abc`,
 *    `1e3`, `0x10`, `Infinity` and the empty string are rejected with exit 1,
 *    no scan output, and an ACTIONABLE error that names `--max-files`, echoes
 *    the offending value and states what is expected (a positive integer). In
 *    `--json` mode the error is JSON on stdout (`error`, zero findings) and its
 *    `targetDir` is the real target, not the option value. A missing value
 *    (`--max-files` last, or followed by another flag, or `--max-files <dir>`
 *    eating the target) is an error too. Leading zeros (`007`) are either read
 *    as decimal 7 or rejected; anything else is wrong. A repeated flag either
 *    lets the last occurrence win or is rejected with an error naming the flag.
 * 4. The flag wins over the programmatic `maxFiles` option in both directions;
 *    the programmatic option still applies without the flag. Without the flag
 *    behaviour is unchanged (default cap 5000).
 * 5. The flag composes with `--guide` and `--include-docs-and-tests`, and may
 *    appear before or after the positional path.
 * 6. `--help`, the README and the dev CLI help (`gd --help`, which lists every
 *    other legacy-scan flag) document the option.
 *
 * Fixtures are generated in os.tmpdir() (removed on exit); the git fixtures
 * need a `git` binary but no network or commits. Runtime is a few seconds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineScorecard, mean } from '../lib.ts';
import type { AnalyzeCliExecutionOptions, AnalyzeJsonOutput } from '../../src/analyzing/cli.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Fixture content. Each "dirty" snippet produces findings with the shipped
// rules; the uncapped guard cases verify that, so fixtures cannot silently rot.
// ---------------------------------------------------------------------------
const C = {
  /** 1 finding (autofill-sign-in-form). */
  form: (i: number) => `<form action="/login${i}" method="POST">\n  <input type="password" name="password">\n</form>\n`,
  /** 2 findings (two sign-in forms). */
  twoForms: (i: number) =>
    `<form action="/a${i}" method="POST">\n  <input type="password" name="password">\n</form>\n<p>or</p>\n` +
    `<form action="/b${i}" method="POST">\n  <input type="password" name="pw">\n</form>\n`,
  accordionCss: `.panel {\n  max-height: 0;\n  overflow: hidden;\n  transition: max-height 0.3s ease-out;\n}\n.panel.open {\n  max-height: 500px;\n}\n`,
  darkCss: `body { color: #333; }\n@media (prefers-color-scheme: dark) {\n  body { color: #eee; }\n}\n`,
  enterJs: `textarea.addEventListener('keydown', (event) => {\n  if (event.key === 'Enter' && !event.shiftKey) {\n    event.preventDefault();\n    form.requestSubmit();\n  }\n});\n`,
  enterTs: `const t = document.querySelector('textarea')!;\nt.addEventListener('keydown', (event) => {\n  if (event.key === 'Enter') {\n    event.preventDefault();\n    form.requestSubmit();\n  }\n});\n`,
  formJsx: `export function Login() {\n  return (\n    <form action="/x" method="POST">\n      <input type="password" name="password" />\n    </form>\n  );\n}\n`,
  formVue: `<template>\n  <form action="/v" method="POST">\n    <input type="password" name="password">\n  </form>\n</template>\n`,
  /** Scannable, but no findings. */
  clean: (i: number) => `<main>\n  <h1>Welcome ${i}</h1>\n  <p>Nothing legacy here.</p>\n</main>\n`,
};

const MIXED: Record<string, string> = {
  'a.html': C.form(1),
  'b.html': C.twoForms(2),
  'c.css': C.accordionCss,
  'd.css': C.darkCss,
  'e.js': C.enterJs,
  'f.jsx': C.formJsx,
  'g.ts': C.enterTs,
  'h.vue': C.formVue,
};

const NESTED: Record<string, string> = {
  'index.html': C.form(1),
  'pages/login.html': C.form(2),
  'pages/account/signin.html': C.form(3),
  'pages/account/deep/reauth.html': C.form(4),
  'admin/login.html': C.form(5),
  'admin/tools/su.html': C.form(6),
  'components/LoginForm.jsx': C.formJsx,
  'components/auth/Modal.vue': C.formVue,
  'legacy/old/form.html': C.form(9),
};

const MULTI: Record<string, string> = Object.fromEntries(
  [1, 2, 3, 4, 5, 6].map((i) => [`p${i}/login.html`, C.twoForms(i)]),
);

const GIT_TRACKED: Record<string, string> = {
  'index.html': C.twoForms(1),
  'src/app/login.html': C.form(2),
  'src/app/styles.css': C.accordionCss,
  'src/lib/enter.js': C.enterJs,
};
const GIT_UNTRACKED: Record<string, string> = {
  'src/components/Form.jsx': C.formJsx,
  'pages/signin.vue': C.formVue,
  'generated/out.html': C.form(7), // gitignored
  'src/app/page.gen.html': C.form(8), // gitignored
  '.gitignore': 'generated/\n*.gen.html\n',
};
const GIT_SCANNABLE = ['index.html', 'src/app/login.html', 'src/app/styles.css', 'src/lib/enter.js', 'src/components/Form.jsx', 'pages/signin.vue'];
const GIT_IGNORED = ['generated/out.html', 'src/app/page.gen.html'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const created: string[] = [];
process.on('exit', () => {
  for (const d of created) fs.rmSync(d, { recursive: true, force: true });
});

function writeTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

const cache = new Map<string, string>();
function fixture(name: string, files: Record<string, string | Buffer>): string {
  const hit = cache.get(name);
  if (hit) return hit;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mwg-maxfiles2-${name}-`));
  created.push(root);
  writeTree(root, files);
  cache.set(name, root);
  return root;
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  });
}

/** A git work tree: `tracked` files are `git add`ed, `untracked` are left untracked. */
function gitFixture(name: string, tracked: Record<string, string>, untracked: Record<string, string>): string {
  const hit = cache.get(name);
  if (hit) return hit;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mwg-maxfiles2-${name}-`));
  created.push(root);
  git(root, ['init', '-q']);
  writeTree(root, tracked);
  git(root, ['add', '--', ...Object.keys(tracked)]);
  writeTree(root, untracked);
  cache.set(name, root);
  return root;
}

interface Scan {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Parsed --json output, or null. */
  data: AnalyzeJsonOutput | null;
  /** file -> number of findings in that file (from --json output). */
  perFile: Map<string, number>;
}

async function cli(args: string[], options?: AnalyzeCliExecutionOptions): Promise<Scan> {
  const { runAnalyzeCli } = await import('../../src/analyzing/cli.ts');
  const res = await runAnalyzeCli(args, options);
  const stdout = res.stdout ?? (res.exitCode === 0 ? res.output : '');
  const stderr = res.stderr ?? (res.exitCode === 0 ? '' : res.output);
  let data: AnalyzeJsonOutput | null = null;
  if (args.includes('--json')) {
    try {
      data = JSON.parse(stdout || res.output) as AnalyzeJsonOutput;
    } catch {
      data = null;
    }
  }
  const perFile = new Map<string, number>();
  for (const g of data?.guides ?? []) {
    for (const r of g.rules) {
      for (const f of r.findings) perFile.set(f.file, (perFile.get(f.file) ?? 0) + 1);
    }
  }
  return { exitCode: res.exitCode, stdout, stderr, data, perFile };
}

/** JSON scan of `dir`; returns null unless it exited 0 with parseable JSON. */
async function scan(dir: string, extra: string[] = [], options?: AnalyzeCliExecutionOptions): Promise<Scan | null> {
  const s = await cli([dir, '--json', ...extra], options);
  return s.exitCode === 0 && s.data && typeof s.data.totalFindings === 'number' ? s : null;
}

function files(s: Scan | null): Set<string> {
  return new Set(s?.perFile.keys() ?? []);
}

/** Scanned files keep exactly the findings they have in an uncapped scan. */
function findingsIntact(capped: Scan | null, full: Scan | null): boolean {
  if (!capped || !full || capped.perFile.size === 0) return false;
  for (const [file, n] of capped.perFile) if (full.perFile.get(file) !== n) return false;
  return true;
}

function isSubset<T>(a: Set<T>, b: Set<T>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function errorText(s: Scan): string {
  return `${s.data?.error ?? ''}\n${s.stderr}\n${s.data ? '' : s.stdout}`;
}

/** The error is about --max-files (not strict parseArgs rejecting an unknown flag). */
function namesOption(msg: string): boolean {
  return /--max-files/.test(msg) && !/unknown option/i.test(msg);
}

const EXPECTATION_RE =
  /(?:positive|whole|natural)\s+(?:integer|number)|integer\b[^\n]*\b(?:at least|>=|≥|greater than(?: or equal to)?)\s*[01]\b|>=\s*1\b|≥\s*1\b/i;

/** Text mode and JSON mode both reject `value` with an actionable error. */
async function rejectsValue(dir: string, value: string): Promise<number> {
  const textArgs = value === '' || value.startsWith('-') ? [`--max-files=${value}`] : ['--max-files', value];
  const text = await cli([dir, ...textArgs]);
  const json = await cli([dir, '--json', `--max-files=${value}`]);
  const textMsg = text.stderr || text.stdout;
  const jsonMsg = json.data?.error ?? '';
  const echoes = (msg: string) => value === '' || msg.includes(value);
  return mean([
    text.exitCode === 1,
    !/Found \d+|modernization opportunit/i.test(text.stdout),
    namesOption(textMsg),
    echoes(textMsg),
    EXPECTATION_RE.test(textMsg),
    json.exitCode === 1,
    json.data !== null && json.data.totalFindings === 0 && json.data.guides.length === 0,
    namesOption(jsonMsg),
    echoes(jsonMsg),
    EXPECTATION_RE.test(jsonMsg),
    json.data?.targetDir === dir,
  ]);
}

/** A non-scan error about --max-files (any reasonable wording). */
function rejectedNamingOption(s: Scan): boolean {
  return s.exitCode === 1 && s.perFile.size === 0 && namesOption(errorText(s));
}

function runPublishedCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', DISABLE_TELEMETRY: '1' };
  delete env.ENABLE_FILE_LOGGING;
  delete env.FORCE_COLOR;
  const res = spawnSync(process.execPath, [path.join(ROOT, 'src/analyzing/cli.ts'), ...args], {
    encoding: 'utf8',
    env,
    timeout: 60_000,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------
export default defineScorecard({
  feature: 'max-files-v2',
  title: 'legacy-scan --max-files <n> (stricter v2)',
  cases: [
    {
      id: 'caps-mixed-extensions',
      description:
        'one cap across .html/.css/.js/.jsx/.ts/.vue: caps 1,3,5,7 scan exactly that many files, each keeping all its findings',
      weight: 4,
      run: async () => {
        const dir = fixture('mixed', MIXED);
        const full = await scan(dir);
        if (files(full).size !== Object.keys(MIXED).length) return 0;
        const results: boolean[] = [];
        for (const n of [1, 3, 5, 7]) {
          const s = await scan(dir, ['--max-files', String(n)]);
          results.push(files(s).size === n && findingsIntact(s, full));
        }
        return mean(results);
      },
    },
    {
      id: 'caps-whole-nested-tree',
      description: 'the cap is global across nested directories (not per directory): caps 1,4,7 on a 9-file, 4-level tree',
      weight: 4,
      run: async () => {
        const dir = fixture('nested', NESTED);
        const full = await scan(dir);
        if (files(full).size !== Object.keys(NESTED).length) return 0;
        const results: boolean[] = [];
        for (const n of [1, 4, 7]) {
          const s = await scan(dir, [`--max-files=${n}`]);
          results.push(files(s).size === n && isSubset(files(s), files(full)) && findingsIntact(s, full));
        }
        return mean(results);
      },
    },
    {
      id: 'caps-files-not-findings',
      description: 'files with 2 findings each: `--max-files 3` scans 3 files and reports all 6 of their findings (not 3)',
      weight: 4,
      run: async () => {
        const dir = fixture('multi', MULTI);
        const full = await scan(dir);
        if (full?.data?.totalFindings !== 12) return 0;
        const s = await scan(dir, ['--max-files', '3']);
        return mean([files(s).size === 3, s?.data?.totalFindings === 6, findingsIntact(s, full)]);
      },
    },
    {
      id: 'clean-files-consume-cap',
      description:
        'scannable files without findings count toward the cap (mirror fixtures with dirty-first vs clean-first names; plain dir and git repo)',
      weight: 5,
      run: async () => {
        const dirtyFirst: Record<string, string> = {};
        const cleanFirst: Record<string, string> = {};
        for (const i of [1, 2, 3]) {
          dirtyFirst[`a-dirty-${i}.html`] = C.form(i);
          dirtyFirst[`z-clean-${i}.html`] = C.clean(i);
          cleanFirst[`a-clean-${i}.html`] = C.clean(i);
          cleanFirst[`z-dirty-${i}.html`] = C.form(i);
        }
        const modes: [string, string][] = [
          [fixture('mirror-a', dirtyFirst), fixture('mirror-b', cleanFirst)],
          [gitFixture('git-mirror-a', dirtyFirst, {}), gitFixture('git-mirror-b', cleanFirst, {})],
        ];
        const results: number[] = [];
        for (const [a, b] of modes) {
          const [fullA, fullB, capA, capB] = await Promise.all([
            scan(a),
            scan(b),
            scan(a, ['--max-files', '3']),
            scan(b, ['--max-files', '3']),
          ]);
          if (files(fullA).size !== 3 || files(fullB).size !== 3 || !capA || !capB) {
            results.push(0);
            continue;
          }
          // With any fixed, content-blind order, clean files take some of the 3 slots in
          // at least one of the two mirrors. Selecting "the first 3 files WITH findings"
          // would report 3 + 3.
          results.push(Number(files(capA).size + files(capB).size < 6 && files(capA).size <= 3 && files(capB).size <= 3));
        }
        return mean(results);
      },
    },
    {
      id: 'unscanned-files-dont-consume-cap',
      description:
        'files that are never scanned (.txt/.md/.png, node_modules, dist, hidden dirs, tests) do not use up the cap',
      weight: 3,
      run: async () => {
        const dir = fixture('junk', {
          'a-notes.txt': C.form(1),
          'a-image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
          'README.md': C.form(2),
          '.cache/a.html': C.form(3),
          'dist/a.html': C.form(4),
          'node_modules/pkg/index.html': C.form(5),
          'tests/a.html': C.form(6),
          'm-1.html': C.form(7),
          'm-2.html': C.form(8),
          'm-3.html': C.form(9),
        });
        const want = new Set(['m-1.html', 'm-2.html', 'm-3.html']);
        const full = await scan(dir);
        if (files(full).size !== 3 || !isSubset(files(full), want)) return 0;
        const capped = await scan(dir, ['--max-files', '3']);
        const two = await scan(dir, ['--max-files', '2']);
        return mean([
          files(capped).size === 3 && isSubset(files(capped), want),
          files(two).size === 2 && isSubset(files(two), want),
        ]);
      },
    },
    {
      id: 'git-repo-cap',
      description:
        'git work tree (tracked + untracked, .gitignore honoured): caps 2/4/6/11 give 2/4/6/6 files, never ignored ones; a subdirectory target is capped too',
      weight: 5,
      run: async () => {
        const repo = gitFixture('git', GIT_TRACKED, GIT_UNTRACKED);
        const scannable = new Set(GIT_SCANNABLE);
        const noIgnored = (s: Scan | null) => !GIT_IGNORED.some((f) => files(s).has(f));
        const full = await scan(repo);
        if (files(full).size !== scannable.size || !isSubset(files(full), scannable)) return 0;
        const results: boolean[] = [];
        for (const [n, want] of [
          [2, 2],
          [4, 4],
          [6, 6],
          [11, 6],
        ] as const) {
          const s = await scan(repo, ['--max-files', String(n)]);
          results.push(files(s).size === want && isSubset(files(s), scannable) && noIgnored(s) && findingsIntact(s, full));
        }
        const sub = path.join(repo, 'src');
        const subFull = await scan(sub);
        const subCapped = await scan(sub, ['--max-files', '2']);
        results.push(files(subFull).size === 4 && files(subCapped).size === 2 && isSubset(files(subCapped), files(subFull)));
        return mean(results);
      },
    },
    {
      id: 'cap-at-or-above-count-is-noop',
      description: 'a cap equal to or above the number of files gives output identical to an uncapped scan',
      weight: 3,
      run: async () => {
        const dir = fixture('mixed', MIXED);
        const full = await scan(dir);
        if (!full) return 0;
        const same = (s: Scan | null) =>
          s !== null &&
          s.data?.totalFindings === full.data?.totalFindings &&
          JSON.stringify(s.data?.guides) === JSON.stringify(full.data?.guides);
        return mean([
          same(await scan(dir, ['--max-files', String(Object.keys(MIXED).length)])),
          same(await scan(dir, ['--max-files', '50'])),
          same(await scan(dir, ['--max-files=100000'])),
        ]);
      },
    },
    {
      id: 'raises-default-limit',
      description:
        '5010 files: no flag stops at the 5000 default; --max-files 5010 / 6000 scan all 5010; --max-files 2500 scans 2500',
      weight: 4,
      timeoutMs: 90_000,
      run: async () => {
        const big: Record<string, string> = {};
        for (let i = 0; i < 5010; i++) big[`d${i % 10}/f${i}.html`] = C.form(i);
        const dir = fixture('big', big);
        const counts = await Promise.all(
          [[], ['--max-files', '5010'], ['--max-files=6000'], ['--max-files', '2500']].map(async (extra) => files(await scan(dir, extra)).size),
        );
        return mean([counts[0] === 5000, counts[1] === 5010, counts[2] === 5010, counts[3] === 2500]);
      },
    },
    {
      id: 'single-file-target-unaffected',
      description: 'a file target keeps all its findings with --max-files 1 / 5, but an invalid value is still rejected',
      weight: 3,
      run: async () => {
        const dir = fixture('single', { 'login.html': C.twoForms(1) });
        const file = path.join(dir, 'login.html');
        const full = await scan(file);
        if (full?.data?.totalFindings !== 2) return 0;
        const same = (s: Scan | null) =>
          s !== null && JSON.stringify(s.data?.guides) === JSON.stringify(full.data?.guides);
        const invalid = await cli([file, '--json', '--max-files=0']);
        return mean([
          same(await scan(file, ['--max-files', '1'])),
          same(await scan(file, ['--max-files=5'])),
          rejectedNamingOption(invalid),
        ]);
      },
    },
    {
      id: 'flag-overrides-programmatic',
      description: 'flag beats programmatic maxFiles both ways (2→6 gives 6, 6→2 gives 2); programmatic 4 alone gives 4',
      weight: 3,
      run: async () => {
        const dir = fixture('nested', NESTED);
        return mean([
          files(await scan(dir, ['--max-files', '6'], { maxFiles: 2 })).size === 6,
          files(await scan(dir, ['--max-files', '2'], { maxFiles: 6 })).size === 2,
          files(await scan(dir, [], { maxFiles: 4 })).size === 4,
        ]);
      },
    },
    {
      id: 'rejects-invalid-actionably',
      description:
        'strict decimal validation: 0, -3, abc, 1.5, 3abc, 1e3, 0x10, Infinity, "" exit 1 (text + JSON) with an error naming --max-files, echoing the value and saying a positive integer is expected',
      weight: 6,
      run: async () => {
        const dir = fixture('mixed', MIXED);
        const values = ['0', '-3', 'abc', '1.5', '3abc', '1e3', '0x10', 'Infinity', ''];
        const credits: number[] = [];
        for (const v of values) credits.push(await rejectsValue(dir, v));
        return mean(credits);
      },
    },
    {
      id: 'leading-zeros-decimal',
      description: '`--max-files 007` is read as decimal 7 or rejected; never another count',
      weight: 1,
      run: async () => {
        const dir = fixture('nested', NESTED);
        const s = await cli([dir, '--json', '--max-files', '007']);
        return (s.exitCode === 0 && files(s).size === 7) || rejectedNamingOption(s);
      },
    },
    {
      id: 'missing-value-rejected',
      description:
        'missing value (`--max-files` last, followed by `--json`, or swallowing the path) exits 1 with an error about --max-files and scans nothing',
      weight: 3,
      run: async () => {
        const dir = fixture('mixed', MIXED);
        const cases = [
          [dir, '--max-files'],
          [dir, '--json', '--max-files'],
          [dir, '--max-files', '--json'],
          ['--json', '--max-files', dir],
          ['--max-files', dir],
        ];
        const results: boolean[] = [];
        for (const args of cases) {
          const s = await cli(args);
          results.push(s.exitCode === 1 && s.perFile.size === 0 && namesOption(errorText(s)) && !/Found \d+/.test(s.stdout));
        }
        return mean(results);
      },
    },
    {
      id: 'repeated-flag',
      description: 'a repeated flag lets the last value win (5 then 2 → 2; 2 then 5 → 5) or is rejected naming --max-files',
      weight: 2,
      run: async () => {
        const dir = fixture('nested', NESTED);
        const a = await cli([dir, '--json', '--max-files', '5', '--max-files', '2']);
        const b = await cli([dir, '--json', '--max-files=2', '--max-files=5']);
        return mean([
          (a.exitCode === 0 && files(a).size === 2) || rejectedNamingOption(a),
          (b.exitCode === 0 && files(b).size === 5) || rejectedNamingOption(b),
        ]);
      },
    },
    {
      id: 'flag-position-and-target',
      description:
        'flag before the path works and the value is never taken as the target; JSON errors report the real targetDir',
      weight: 2,
      run: async () => {
        const dir = fixture('nested', NESTED);
        const before = await cli(['--max-files', '2', dir, '--json']);
        const eq = await cli(['--json', '--max-files=3', dir]);
        const parseErr = await cli(['--max-files', '3', '--bogus-flag', dir, '--json']);
        const valueErr = await cli(['--max-files', 'zero', dir, '--json']);
        return mean([
          before.exitCode === 0 && before.data?.targetDir === dir && files(before).size === 2,
          eq.exitCode === 0 && eq.data?.targetDir === dir && files(eq).size === 3,
          parseErr.exitCode === 1 && parseErr.data?.targetDir === dir,
          valueErr.exitCode === 1 && valueErr.data?.targetDir === dir && namesOption(valueErr.data?.error ?? ''),
        ]);
      },
    },
    {
      id: 'composes-with-guide-and-docs-flags',
      description:
        '--guide + --max-files filters and caps; --include-docs-and-tests makes docs/tests count toward the cap, without it they do not',
      weight: 2,
      run: async () => {
        const mixed = fixture('mixed', MIXED);
        const guide = 'autofill-sign-in-form';
        const guideOnly = await scan(mixed, ['--guide', guide]);
        const guideAll = await scan(mixed, ['--guide', guide, '--max-files', '8']);
        const guideOne = await scan(mixed, ['--max-files', '1', '--guide', guide]);
        const onlyGuide = (s: Scan | null) => s !== null && s.data!.guides.every((g) => g.guideId === guide);

        const docs = fixture('docs', {
          'src/a.html': C.form(1),
          'src/b.html': C.form(2),
          'tests/t1.html': C.form(3),
          'tests/t2.html': C.form(4),
          'docs/d1.html': C.form(5),
        });
        const withDocs = await scan(docs, ['--include-docs-and-tests', '--max-files', '4']);
        const withoutDocs = await scan(docs, ['--max-files', '4']);
        return mean([
          guideOnly !== null &&
            files(guideOnly).size >= 2 &&
            JSON.stringify(guideAll?.data?.guides) === JSON.stringify(guideOnly.data?.guides),
          onlyGuide(guideOne) && files(guideOne).size <= 1,
          files(withDocs).size === 4,
          files(withoutDocs).size === 2 && isSubset(files(withoutDocs), new Set(['src/a.html', 'src/b.html'])),
        ]);
      },
    },
    {
      id: 'deterministic-prefix-selection',
      description: 'the same cap always selects the same files, and the selection for cap n is contained in the one for n+1',
      weight: 2,
      run: async () => {
        const dir = fixture('nested', NESTED);
        const repo = gitFixture('git', GIT_TRACKED, GIT_UNTRACKED);
        const key = (s: Scan | null) => [...files(s)].sort().join('|');
        const repeat = [
          key(await scan(dir, ['--max-files', '4'])) === key(await scan(dir, ['--max-files', '4'])),
          key(await scan(repo, ['--max-files', '3'])) === key(await scan(repo, ['--max-files', '3'])),
        ];
        let nested = true;
        let prev = new Set<string>();
        for (let n = 1; n <= Object.keys(NESTED).length; n++) {
          const cur = files(await scan(dir, ['--max-files', String(n)]));
          if (cur.size !== n || !isSubset(prev, cur)) nested = false;
          prev = cur;
        }
        return mean([...repeat, nested]);
      },
    },
    {
      id: 'documented',
      description: '--help lists `--max-files <n>` (with a value placeholder, describing files) and the README options table lists it',
      weight: 2,
      run: async () => {
        const help = await cli(['--help']);
        const line = help.stdout.split('\n').find((l) => /--max-files\b/.test(l)) ?? '';
        let readme = '';
        try {
          readme = fs.readFileSync(path.join(ROOT, 'src/analyzing/README.md'), 'utf8');
        } catch {
          /* missing */
        }
        return mean([
          help.exitCode === 0 && /--max-files(?:\s+|=)<[^>]+>/.test(line),
          /\bfiles?\b/i.test(line.replace(/--max-files/g, '')),
          readme.split('\n').some((l) => /^\|.*--max-files/.test(l)),
        ]);
      },
    },
    {
      id: 'dev-cli-help-lists-flag',
      description: 'the repo dev CLI (`gd --help`) lists --max-files under legacy-scan, like the other legacy-scan flags',
      weight: 1,
      timeoutMs: 60_000,
      run: () => {
        const res = spawnSync(process.execPath, [path.join(ROOT, 'bin/gd.ts'), '--help'], {
          encoding: 'utf8',
          env: { ...process.env, NO_COLOR: '1', DISABLE_TELEMETRY: '1' },
          timeout: 60_000,
        });
        // eslint-disable-next-line no-control-regex
        const lines = (res.stdout ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n');
        const start = lines.findIndex((l) => /^\s{2}legacy-scan\b/.test(l));
        if (res.status !== 0 || start < 0) return 0;
        const section: string[] = [];
        for (const l of lines.slice(start + 1)) {
          if (!/^\s{4,}--/.test(l)) break;
          section.push(l);
        }
        return section.some((l) => /--max-files\b/.test(l));
      },
    },
    {
      id: 'published-cli-end-to-end',
      description:
        'the legacy-scan entry point as a subprocess: cap honoured in JSON and text output; invalid value exits 1 (stderr in text, JSON on stdout)',
      weight: 3,
      timeoutMs: 90_000,
      run: () => {
        const dir = fixture('mixed', MIXED);
        const ok = runPublishedCli(['legacy-scan', dir, '--max-files', '3', '--json']);
        let okFiles = -1;
        try {
          const data = JSON.parse(ok.stdout) as AnalyzeJsonOutput;
          okFiles = new Set(data.guides.flatMap((g) => g.rules.flatMap((r) => r.findings.map((f) => f.file)))).size;
        } catch {
          /* not JSON */
        }
        const text = runPublishedCli(['legacy-scan', dir, '--max-files=2']);
        const textFiles = new Set([...text.stdout.matchAll(/^\s*- (\S+):\d+\s*$/gm)].map((m) => m[1])).size;
        const bad = runPublishedCli(['legacy-scan', dir, '--max-files', '0']);
        const badJson = runPublishedCli(['legacy-scan', dir, '--json', '--max-files=abc']);
        let badJsonError = '';
        try {
          badJsonError = (JSON.parse(badJson.stdout) as AnalyzeJsonOutput).error ?? '';
        } catch {
          /* not JSON */
        }
        return mean([
          ok.status === 0 && okFiles === 3,
          text.status === 0 && textFiles === 2,
          bad.status === 1 && namesOption(bad.stderr) && !/Found \d+/.test(bad.stdout),
          badJson.status === 1 && namesOption(badJsonError),
        ]);
      },
    },
    {
      id: 'guard-default-unchanged',
      description: 'guard: without the flag every scannable file is scanned with all findings (mixed, nested, git fixtures)',
      weight: 2,
      run: async () => {
        const mixed = await scan(fixture('mixed', MIXED));
        const nested = await scan(fixture('nested', NESTED));
        const repo = await scan(gitFixture('git', GIT_TRACKED, GIT_UNTRACKED));
        return mean([
          files(mixed).size === 8 && mixed?.data?.totalFindings === 9,
          files(nested).size === 9 && nested?.data?.totalFindings === 9,
          files(repo).size === 6 && repo?.data?.totalFindings === 7,
        ]);
      },
    },
  ],
});
