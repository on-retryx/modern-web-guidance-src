/**
 * Scorecard v2 (stricter, written by an independent test author before the
 * round-2 fixes): `install` / `update` / `uninstall` must report the result of
 * the delegated `npx skills ...` child faithfully.
 *
 * Contract (public CLI behaviour of `src/cli/modern-web.ts`, observed only
 * through exit codes, stdout/stderr and the argv a fake `npx` receives):
 *
 * 1. Exact status passthrough: when the `npx skills ...` child exits with
 *    status N (1, 2, 3, 42, 127, 255 are probed), `install`, `update` and
 *    `uninstall` exit with exactly N. Hard-coding 1 for "any failure" is wrong.
 * 2. Killed by a signal (SIGTERM, SIGKILL): the CLI exits with exactly 1 for
 *    all three commands. In particular `install` must not report success
 *    (round-2 DECISION: keep `install` exiting 1 in this case).
 * 3. npx cannot be spawned (not on PATH): the CLI exits with exactly 1 and
 *    prints a non-empty diagnostic on stderr, for all three commands
 *    (`install` already did this; it is a regression guard).
 * 4. Success is unchanged: child exits 0 -> CLI exits 0, with the same npx
 *    argv as before (`-y skills update|remove <adjacent skill ids...>`,
 *    `-y skills add GoogleChrome/modern-web-guidance --skill modern-web-guidance
 *    <extra args>`; `--choose` drops `--skill ...` and is not forwarded).
 * 5. Skill ids adjacent to the shipped CLI are passed through: in the shipped
 *    layout (`skills/<id>/SKILL.md` next to `skills/modern-web-guidance/
 *    modern-web.mjs`, bundled with esbuild like build-dist) `update` and
 *    `uninstall` append exactly the ids of sibling folders that hold a
 *    SKILL.md (order-insensitive), and still propagate the child status.
 * 6. The child keeps inherited stdio: its stdout/stderr reach the CLI's
 *    stdout/stderr and it can read the CLI's stdin.
 * 7. Repo unit tests guard the round-2 fixes (round-2 DECISIONS): the repo's
 *    own CLI tests (every `src/cli/**\/*.test.ts` that references
 *    `modern-web.ts`) must fail against behavioural mutants of the CLI:
 *      - `install` exits 0 when npx was killed by a signal;
 *      - `update` (resp. `uninstall`) exits 0 when npx cannot be spawned.
 *    The mutants are black-box wrappers around an unmodified copy of the CLI
 *    (an npx proxy observes whether the child was signalled), so this does
 *    not depend on how the CLI or its tests are written, only on what the
 *    tests assert.
 *
 * All runs use a fake `npx` shim on PATH (as src/cli/modern-web.test.ts does),
 * DISABLE_TELEMETRY=1 and no network. POSIX shell required.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineScorecard, mean, ratio } from '../lib.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'src/cli/modern-web.ts');
const NODE_DIR = path.dirname(process.execPath);
const STATUSES = [1, 2, 3, 42, 127, 255];
const SIGNALS = ['TERM', 'KILL'];
const INSTALL_BASE = ['-y', 'skills', 'add', 'GoogleChrome/modern-web-guidance'];

let built = false;
/** The CLI loads out/build/skills-cli/gen/guides.json at import time; build it once (offline). */
function ensureBuilt(): void {
  if (built) return;
  const r = spawnSync(process.execPath, ['src/build/build-guides.ts', '--target=skills-cli'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`build-guides failed: ${r.stderr.slice(0, 300)}`);
  built = true;
}

function baseEnv(pathValue: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: pathValue, NO_COLOR: '1', DISABLE_TELEMETRY: '1' };
}

interface Run {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** argv received by the fake npx, or null if it never ran. */
  argv: string[] | null;
}

interface RunOptions {
  cli?: string;
  args: string[];
  /** Shell body executed by the fake npx after it logs its argv; null = no npx on PATH. */
  shim: string | null;
  input?: string;
}

function runCli({ cli = CLI, args, shim, input }: RunOptions): Run {
  ensureBuilt();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwg-exit-v2-'));
  const log = path.join(binDir, 'argv.json');
  try {
    if (shim !== null) {
      fs.writeFileSync(
        path.join(binDir, 'npx'),
        `#!/bin/sh\n"${process.execPath}" -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "${log}" "$@"\n${shim}\n`,
        { mode: 0o755 },
      );
    }
    const r = spawnSync(process.execPath, [cli, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      input: input ?? '',
      // No shim: PATH holds only an empty dir, so `npx` cannot be found.
      env: baseEnv(shim === null ? binDir : `${binDir}:${NODE_DIR}:/usr/bin:/bin`),
    });
    const argv = fs.existsSync(log) ? (JSON.parse(fs.readFileSync(log, 'utf8')) as string[]) : null;
    return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '', argv };
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

const sameArray = (a: readonly string[] | null, b: readonly string[]): boolean =>
  a !== null && a.length === b.length && a.every((v, i) => v === b[i]);

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  sameArray([...a].sort(), [...b].sort());

function exactStatusRatio(command: string): number {
  const hits = STATUSES.filter((s) => runCli({ args: [command], shim: `exit ${s}` }).status === s).length;
  return ratio(hits, STATUSES.length);
}

function signalExitsOne(command: string): number {
  const hits = SIGNALS.filter((sig) => {
    const r = runCli({ args: [command], shim: `kill -${sig} $$\nsleep 5` });
    return r.status === 1 && r.argv !== null;
  }).length;
  return ratio(hits, SIGNALS.length);
}

function spawnErrorCredit(command: string): number {
  const r = runCli({ args: [command], shim: null });
  if (r.status !== 1) return 0;
  return r.stderr.trim().length > 0 ? 1 : 0.5;
}

/** Ids of sibling skill folders holding a SKILL.md (the existing contract). */
function adjacentSkillIds(skillsDir: string): string[] {
  if (!fs.existsSync(skillsDir)) return [];
  return fs.readdirSync(skillsDir).filter((n) => fs.existsSync(path.join(skillsDir, n, 'SKILL.md')));
}

// ---------------------------------------------------------------------------
// Shipped-layout bundle (contract 5)
// ---------------------------------------------------------------------------

let bundle: { dir: string; cli: string } | null = null;
async function shippedBundle(): Promise<{ dir: string; cli: string }> {
  if (bundle) return bundle;
  ensureBuilt();
  const esbuild = await import('esbuild');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwg-exit-v2-bundle-'));
  const skills = path.join(dir, 'skills');
  const own = path.join(skills, 'modern-web-guidance');
  fs.mkdirSync(path.join(own, 'gen'), { recursive: true });
  fs.writeFileSync(path.join(own, 'SKILL.md'), '# own\n');
  for (const id of ['alpha-skill', 'beta-skill']) {
    fs.mkdirSync(path.join(skills, id));
    fs.writeFileSync(path.join(skills, id, 'SKILL.md'), `# ${id}\n`);
  }
  fs.mkdirSync(path.join(skills, 'not-a-skill')); // no SKILL.md: must not be passed
  fs.writeFileSync(path.join(skills, 'stray-file.md'), 'x');
  fs.copyFileSync(path.join(ROOT, 'out/build/skills-cli/gen/guides.json'), path.join(own, 'gen/guides.json'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  const cli = path.join(own, 'modern-web.mjs');
  await esbuild.build({
    entryPoints: [CLI],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: cli,
    logLevel: 'silent',
    // Like build-dist: lazily imported sibling entry points stay external.
    plugins: [{
      name: 'external-cli-modules',
      setup(build) {
        build.onResolve({ filter: /(?:^|\/)(?:rag\/search|analyzing\/cli)\.ts$/ }, () => ({ path: './unused.mjs', external: true }));
      },
    }],
  });
  bundle = { dir, cli };
  process.once('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return bundle;
}

// ---------------------------------------------------------------------------
// Mutation check of the repo's own CLI tests (contract 7)
// ---------------------------------------------------------------------------

type Mutant = 'none' | 'install-signal-exit-0' | 'update-spawn-error-exit-0' | 'uninstall-spawn-error-exit-0';

/** Black-box wrapper placed at src/cli/modern-web.ts in a scratch tree; runs the unmodified CLI copy. */
function wrapperSource(mutant: Mutant): string {
  return `import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const MUTANT = ${JSON.stringify(mutant)};
const REAL = path.join(import.meta.dirname, 'modern-web.unmodified.ts');
const args = process.argv.slice(2);
const first = args.find((a) => !a.startsWith('-'));
const command = ['install', 'update', 'uninstall'].includes(first) ? first : null;
const env = { ...process.env };
let realNpx = null;
for (const d of (env.PATH ?? '').split(path.delimiter)) {
  if (!d) continue;
  const p = path.join(d, 'npx');
  try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) { realNpx = p; break; } } catch {}
}
let proxyDir = null;
let marker = null;
if (realNpx && command) {
  proxyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwg-npx-proxy-'));
  marker = path.join(proxyDir, 'signalled');
  fs.writeFileSync(path.join(proxyDir, 'npx'), '#!' + process.execPath + '\\n' +
    'const { spawnSync } = require("node:child_process");\\n' +
    'const r = spawnSync(' + JSON.stringify(realNpx) + ', process.argv.slice(2), { stdio: "inherit" });\\n' +
    'if (r.signal) { require("node:fs").writeFileSync(' + JSON.stringify(marker) + ', r.signal); process.kill(process.pid, r.signal); setTimeout(() => {}, 5000); }\\n' +
    'else process.exit(r.error ? 127 : (r.status ?? 1));\\n', { mode: 0o755 });
  env.PATH = proxyDir + path.delimiter + (env.PATH ?? '');
}
const r = spawnSync(process.execPath, [REAL, ...args], { stdio: 'inherit', env });
const signalled = marker !== null && fs.existsSync(marker);
if (proxyDir) fs.rmSync(proxyDir, { recursive: true, force: true });
if (MUTANT === 'install-signal-exit-0' && command === 'install' && signalled) process.exit(0);
if (MUTANT === 'update-spawn-error-exit-0' && command === 'update' && !realNpx) process.exit(0);
if (MUTANT === 'uninstall-spawn-error-exit-0' && command === 'uninstall' && !realNpx) process.exit(0);
if (r.signal) { process.kill(process.pid, r.signal); setTimeout(() => {}, 5000); }
else process.exit(r.status ?? 1);
`;
}

/** Scratch tree: real copy of src/cli (CLI renamed, wrapper in its place), everything else symlinked. */
function scratchTree(mutant: Mutant): { root: string; tests: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mwg-mut-${mutant}-`));
  for (const e of fs.readdirSync(ROOT)) {
    if (e !== 'src') fs.symlinkSync(path.join(ROOT, e), path.join(root, e));
  }
  fs.mkdirSync(path.join(root, 'src'));
  for (const e of fs.readdirSync(path.join(ROOT, 'src'))) {
    if (e !== 'cli') fs.symlinkSync(path.join(ROOT, 'src', e), path.join(root, 'src', e));
  }
  const cliDir = path.join(root, 'src/cli');
  fs.cpSync(path.join(ROOT, 'src/cli'), cliDir, { recursive: true });
  fs.renameSync(path.join(cliDir, 'modern-web.ts'), path.join(cliDir, 'modern-web.unmodified.ts'));
  fs.writeFileSync(path.join(cliDir, 'modern-web.ts'), wrapperSource(mutant));
  const tests = (fs.readdirSync(cliDir, { recursive: true }) as string[])
    .filter((f) => f.endsWith('.test.ts') && fs.readFileSync(path.join(cliDir, f), 'utf8').includes('modern-web.ts'))
    .map((f) => path.join(cliDir, f));
  return { root, tests };
}

interface TestRun {
  failing: Set<string>;
  passCount: number;
}

function runRepoTests(mutant: Mutant): Promise<TestRun> {
  const { root, tests } = scratchTree(mutant);
  return new Promise<TestRun>((resolve, reject) => {
    if (tests.length === 0) {
      fs.rmSync(root, { recursive: true, force: true });
      reject(new Error('no repo CLI tests found'));
      return;
    }
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...tests], {
      cwd: root,
      env: { ...process.env, NO_COLOR: '1', DISABLE_TELEMETRY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), 80_000);
    child.on('close', () => {
      clearTimeout(timer);
      fs.rmSync(root, { recursive: true, force: true });
      const failing = new Set<string>();
      for (const m of out.matchAll(/^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/gm)) failing.add(m[1]);
      const pass = /^# pass (\d+)/m.exec(out);
      resolve({ failing, passCount: pass ? Number(pass[1]) : 0 });
    });
    child.on('error', reject);
  });
}

let mutation: Promise<Record<Mutant, TestRun>> | null = null;
function mutationRuns(): Promise<Record<Mutant, TestRun>> {
  ensureBuilt();
  mutation ??= (async () => {
    const mutants: Mutant[] = ['none', 'install-signal-exit-0', 'update-spawn-error-exit-0', 'uninstall-spawn-error-exit-0'];
    const runs = await Promise.all(mutants.map((m) => runRepoTests(m)));
    return Object.fromEntries(mutants.map((m, i) => [m, runs[i]])) as Record<Mutant, TestRun>;
  })();
  return mutation;
}

/** A mutant is killed when some test that passes against the faithful wrapper fails against it. */
async function killed(mutant: Mutant): Promise<boolean> {
  const runs = await mutationRuns();
  const base = runs.none;
  if (base.passCount === 0) throw new Error('faithful run passed no tests');
  return [...runs[mutant].failing].some((name) => !base.failing.has(name));
}

export default defineScorecard({
  feature: 'cli-exit-status-v2',
  title: 'install/update/uninstall report the npx skills result exactly (stricter v2)',
  cases: [
    {
      id: 'update-exact-status',
      description: 'update exits with exactly the child status for 1, 2, 3, 42, 127, 255 (ratio)',
      weight: 6,
      run: () => exactStatusRatio('update'),
    },
    {
      id: 'uninstall-exact-status',
      description: 'uninstall exits with exactly the child status for 1, 2, 3, 42, 127, 255 (ratio)',
      weight: 6,
      run: () => exactStatusRatio('uninstall'),
    },
    {
      id: 'install-exact-status',
      description: 'guard: install exits with exactly the child status for 1, 2, 3, 42, 127, 255 (ratio)',
      weight: 2,
      run: () => exactStatusRatio('install'),
    },
    {
      id: 'update-signal-exits-1',
      description: 'update exits exactly 1 when the child is killed by SIGTERM / SIGKILL (ratio)',
      weight: 3,
      run: () => signalExitsOne('update'),
    },
    {
      id: 'uninstall-signal-exits-1',
      description: 'uninstall exits exactly 1 when the child is killed by SIGTERM / SIGKILL (ratio)',
      weight: 3,
      run: () => signalExitsOne('uninstall'),
    },
    {
      id: 'install-signal-exits-1',
      description: 'DECISION: install exits exactly 1 (never 0) when the child is killed by SIGTERM / SIGKILL (ratio)',
      weight: 3,
      run: () => signalExitsOne('install'),
    },
    {
      id: 'update-spawn-error',
      description: 'update exits exactly 1 with a stderr diagnostic when npx is not on PATH (0.5 without diagnostic)',
      weight: 3,
      run: () => spawnErrorCredit('update'),
    },
    {
      id: 'uninstall-spawn-error',
      description: 'uninstall exits exactly 1 with a stderr diagnostic when npx is not on PATH (0.5 without diagnostic)',
      weight: 3,
      run: () => spawnErrorCredit('uninstall'),
    },
    {
      id: 'install-spawn-error',
      description: 'guard: install exits exactly 1 with a stderr diagnostic when npx is not on PATH',
      weight: 1,
      run: () => spawnErrorCredit('install'),
    },
    {
      id: 'guard-success-argv',
      description: 'guard: child exit 0 -> CLI exit 0 with unchanged npx argv for update, uninstall and install (mean)',
      weight: 3,
      run: () => {
        const ids = adjacentSkillIds(path.join(ROOT, 'skills'));
        const update = runCli({ args: ['update'], shim: 'exit 0' });
        const uninstall = runCli({ args: ['uninstall'], shim: 'exit 0' });
        const install = runCli({ args: ['install'], shim: 'exit 0' });
        return mean([
          update.status === 0 && update.argv !== null && sameArray(update.argv.slice(0, 3), ['-y', 'skills', 'update']) && sameSet(update.argv.slice(3), ids),
          uninstall.status === 0 && uninstall.argv !== null && sameArray(uninstall.argv.slice(0, 3), ['-y', 'skills', 'remove']) && sameSet(uninstall.argv.slice(3), ids),
          install.status === 0 && sameArray(install.argv, [...INSTALL_BASE, '--skill', 'modern-web-guidance']),
        ]);
      },
    },
    {
      id: 'guard-install-extra-args',
      description: 'guard: install forwards extra args after the base argv; --choose drops --skill and is not forwarded (mean)',
      weight: 2,
      run: () => {
        const extra = runCli({ args: ['install', '--agent', 'claude-code', '-y'], shim: 'exit 0' });
        const choose = runCli({ args: ['install', '--choose', '--agent', 'codex'], shim: 'exit 0' });
        return mean([
          extra.status === 0 && sameArray(extra.argv, [...INSTALL_BASE, '--skill', 'modern-web-guidance', '--agent', 'claude-code', '-y']),
          choose.status === 0 && sameArray(choose.argv, [...INSTALL_BASE, '--agent', 'codex']),
        ]);
      },
    },
    {
      id: 'shipped-bundle-skill-ids-and-status',
      description: 'esbuild-bundled CLI in the shipped skills/ layout passes exactly the sibling SKILL.md ids to update/remove and propagates status 3 (mean of 4)',
      weight: 4,
      timeoutMs: 60_000,
      run: async () => {
        const { cli } = await shippedBundle();
        const ids = ['alpha-skill', 'beta-skill', 'modern-web-guidance'];
        const checks: boolean[] = [];
        for (const [command, verb] of [['update', 'update'], ['uninstall', 'remove']] as const) {
          const ok = runCli({ cli, args: [command], shim: 'exit 0' });
          checks.push(ok.status === 0 && ok.argv !== null && sameArray(ok.argv.slice(0, 3), ['-y', 'skills', verb]) && sameSet(ok.argv.slice(3), ids));
          checks.push(runCli({ cli, args: [command], shim: 'exit 3' }).status === 3);
        }
        return mean(checks);
      },
    },
    {
      id: 'child-stdio-inherited',
      description: 'child stdout/stderr reach the CLI stdout/stderr and the child reads the CLI stdin, for update/uninstall/install (mean)',
      weight: 3,
      run: () => {
        const checks: boolean[] = [];
        for (const command of ['update', 'uninstall', 'install']) {
          const token = `${command}-${process.pid}`;
          const r = runCli({
            args: [command],
            shim: `printf 'OUT-%s\\n' '${token}'\nprintf 'ERR-%s\\n' '${token}' >&2\nIFS= read -r line\nprintf 'IN-%s\\n' "$line"\nexit 0`,
            input: `ping-${token}\n`,
          });
          checks.push(r.status === 0 && r.stdout.includes(`OUT-${token}`));
          checks.push(r.stderr.includes(`ERR-${token}`));
          checks.push(r.stdout.includes(`IN-ping-${token}`));
        }
        return mean(checks);
      },
    },
    {
      id: 'repo-tests-guard-install-signal',
      description: 'DECISION: repo CLI tests fail when install exits 0 after npx is killed by a signal (black-box mutant)',
      weight: 3,
      timeoutMs: 85_000,
      run: () => killed('install-signal-exit-0'),
    },
    {
      id: 'repo-tests-guard-spawn-error',
      description: 'FIX: repo CLI tests fail when update / uninstall exit 0 because npx cannot be spawned (black-box mutants, mean)',
      weight: 3,
      timeoutMs: 85_000,
      run: async () => mean([await killed('update-spawn-error-exit-0'), await killed('uninstall-spawn-error-exit-0')]),
    },
  ],
});
