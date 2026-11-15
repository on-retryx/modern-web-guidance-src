#!/usr/bin/env node
/**
 * Scoring harness CLI (fork-only tooling).
 *
 *   node scoring/cli.ts run [feature...] [--json] [--verbose]
 *   node scoring/cli.ts lock <feature>            # record sha256 of a scorecard
 *   node scoring/cli.ts verify                    # fail if a locked scorecard changed
 *   node scoring/cli.ts gates [--skip-tests]      # typecheck, lint, unit tests vs baseline
 *   node scoring/cli.ts record <feature> --review <0-100> [--note "..."]
 *       Combines the latest automated score + gates + reviewer score into a
 *       final score, prints the previous best, and appends to history.jsonl.
 *       Exit code 0 = improved (commit), 3 = not improved (do not commit).
 *   node scoring/cli.ts status                    # best final score per feature + project score
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Scorecard, toCredit } from './lib.ts';

const SCORING_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SCORING_DIR);
const FEATURES_DIR = path.join(SCORING_DIR, 'features');
const LOCKS_FILE = path.join(SCORING_DIR, 'locks.json');
const HISTORY_FILE = path.join(SCORING_DIR, 'history.jsonl');
const BASELINE_FAILURES_FILE = path.join(SCORING_DIR, 'baseline-failures.json');
const OUT_DIR = path.join(ROOT, 'out', 'scoring');

/** Weights of the final score. */
const AUTO_WEIGHT = 0.7;
const REVIEW_WEIGHT = 0.3;
/** Final score is multiplied by this when a regression gate fails. */
const GATE_PENALTY = 0.5;

interface CaseOutcome {
  id: string;
  weight: number;
  credit: number;
  error?: string;
  ms: number;
}

interface ScorecardResult {
  feature: string;
  title: string;
  score: number;
  cases: CaseOutcome[];
  at: string;
}

interface GateResult {
  typecheck: boolean;
  lintErrors: number;
  newTestFailures: string[];
  testsRun: boolean;
  passed: boolean;
  at: string;
}

interface HistoryEntry {
  feature: string;
  auto: number;
  review: number;
  gatesPassed: boolean;
  final: number;
  improved: boolean;
  previousBest: number;
  /** HEAD at record time, i.e. the parent of the commit that lands this score. */
  base: string;
  note?: string;
  at: string;
}

function scorecardPath(feature: string): string {
  return path.join(FEATURES_DIR, `${feature}.score.ts`);
}

function listFeatures(): string[] {
  if (!existsSync(FEATURES_DIR)) return [];
  return readdirSync(FEATURES_DIR)
    .filter((f) => f.endsWith('.score.ts'))
    .map((f) => f.replace(/\.score\.ts$/, ''))
    .sort();
}

function readJson<T>(file: string, fallback: T): T {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : fallback;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runScorecard(feature: string): Promise<ScorecardResult> {
  const mod = (await import(pathToFileURL(scorecardPath(feature)).href)) as { default: Scorecard };
  const card = mod.default;
  const cases: CaseOutcome[] = [];
  for (const c of card.cases) {
    const start = performance.now();
    try {
      const result = await withTimeout(Promise.resolve().then(() => c.run()), c.timeoutMs ?? 120_000);
      cases.push({ id: c.id, weight: c.weight, credit: toCredit(result), ms: performance.now() - start });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cases.push({ id: c.id, weight: c.weight, credit: 0, error: message.split('\n')[0], ms: performance.now() - start });
    }
  }
  const totalWeight = cases.reduce((s, c) => s + c.weight, 0);
  const score = totalWeight ? (100 * cases.reduce((s, c) => s + c.weight * c.credit, 0)) / totalWeight : 0;
  return { feature: card.feature, title: card.title, score: Math.round(score * 10) / 10, cases, at: new Date().toISOString() };
}

async function cmdRun(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const verbose = args.includes('--verbose');
  const requested = args.filter((a) => !a.startsWith('--'));
  const features = requested.length ? requested : listFeatures();
  mkdirSync(OUT_DIR, { recursive: true });
  const results: ScorecardResult[] = [];
  for (const feature of features) {
    const result = await runScorecard(feature);
    results.push(result);
    writeFileSync(path.join(OUT_DIR, `${feature}.json`), JSON.stringify(result, null, 2));
    if (!json) {
      console.log(`\n${feature} — ${result.title}: ${result.score}/100`);
      for (const c of result.cases) {
        if (verbose || c.credit < 1) {
          const pct = (c.credit * 100).toFixed(0).padStart(3);
          console.log(`  ${pct}%  w${c.weight}  ${c.id}${c.error ? `  (${c.error})` : ''}`);
        }
      }
    }
  }
  if (json) console.log(JSON.stringify(results, null, 2));
}

function cmdLock(args: string[]): void {
  const feature = args[0];
  if (!feature || !existsSync(scorecardPath(feature))) throw new Error(`Unknown scorecard: ${feature}`);
  const locks = readJson<Record<string, string>>(LOCKS_FILE, {});
  locks[feature] = sha256(scorecardPath(feature));
  writeFileSync(LOCKS_FILE, `${JSON.stringify(locks, null, 2)}\n`);
  console.log(`Locked ${feature}: ${locks[feature]}`);
}

function cmdVerify(): boolean {
  const locks = readJson<Record<string, string>>(LOCKS_FILE, {});
  let ok = true;
  for (const [feature, hash] of Object.entries(locks)) {
    const file = scorecardPath(feature);
    if (!existsSync(file)) {
      console.error(`✖ ${feature}: locked scorecard is missing`);
      ok = false;
    } else if (sha256(file) !== hash) {
      console.error(`✖ ${feature}: scorecard was modified after locking`);
      ok = false;
    } else {
      console.log(`✓ ${feature}`);
    }
  }
  for (const feature of listFeatures()) {
    if (!locks[feature]) console.warn(`! ${feature}: scorecard is not locked`);
  }
  return ok;
}

function run(cmd: string, cmdArgs: string[]): { status: number; output: string } {
  const r = spawnSync(cmd, cmdArgs, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, TEST_REPORTER: 'spec', FORCE_COLOR: '0', NO_COLOR: '1' } });
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function parseFailingTests(output: string): string[] {
  const idx = output.indexOf('failing tests:');
  if (idx === -1) return [];
  const names = new Set<string>();
  for (const line of output.slice(idx).split('\n')) {
    const m = line.match(/^\s*✖ (.+?) \(\d+(?:\.\d+)?m?s\)\s*$/);
    if (m) names.add(m[1]);
  }
  return [...names];
}

/**
 * Gates are serialized machine-wide: concurrent full test runs from several
 * worktrees starve each other on small machines and produce spurious timeouts.
 */
const GATES_LOCK = path.join(tmpdir(), 'mwg-scoring-gates.lock');
const STALE_LOCK_MS = 30 * 60_000;

function acquireGatesLock(): void {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  let announced = false;
  for (;;) {
    try {
      mkdirSync(GATES_LOCK);
      writeFileSync(path.join(GATES_LOCK, 'owner'), `${process.pid} ${ROOT}\n`);
      return;
    } catch {
      try {
        if (Date.now() - statSync(GATES_LOCK).mtimeMs > STALE_LOCK_MS) rmSync(GATES_LOCK, { recursive: true, force: true });
      } catch {
        // Lock vanished between checks; retry.
      }
      if (!announced) {
        console.error(`Waiting for another gates run to finish (${GATES_LOCK})...`);
        announced = true;
      }
      Atomics.wait(sleeper, 0, 0, 5000);
    }
  }
}

function cmdGates(args: string[]): GateResult {
  acquireGatesLock();
  try {
    return runGates(args);
  } finally {
    rmSync(GATES_LOCK, { recursive: true, force: true });
  }
}

function runGates(args: string[]): GateResult {
  const skipTests = args.includes('--skip-tests');
  const typecheck = run('pnpm', ['typecheck']).status === 0;
  const lint = run('pnpm', ['lint']);
  const lintMatch = lint.output.match(/Found \d+ warnings? and (\d+) errors?/);
  const lintErrors = lintMatch ? Number(lintMatch[1]) : lint.status === 0 ? 0 : 1;
  let newTestFailures: string[] = [];
  if (!skipTests) {
    const tests = run('pnpm', ['test']);
    const baseline = new Set(readJson<string[]>(BASELINE_FAILURES_FILE, []));
    newTestFailures = parseFailingTests(tests.output).filter((t) => !baseline.has(t));
    if (tests.status !== 0 && newTestFailures.length === 0 && parseFailingTests(tests.output).length === 0) {
      newTestFailures = ['<test run failed without a parsable failure list>'];
    }
  }
  const result: GateResult = {
    typecheck,
    lintErrors,
    newTestFailures,
    testsRun: !skipTests,
    passed: typecheck && lintErrors === 0 && newTestFailures.length === 0,
    at: new Date().toISOString(),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, 'gates.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  return result;
}

function history(): HistoryEntry[] {
  if (!existsSync(HISTORY_FILE)) return [];
  return readFileSync(HISTORY_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as HistoryEntry);
}

function bestFor(feature: string): number {
  return history()
    .filter((h) => h.feature === feature && h.improved)
    .reduce((best, h) => Math.max(best, h.final), 0);
}

function cmdRecord(args: string[]): number {
  const feature = args[0];
  const reviewIdx = args.indexOf('--review');
  const noteIdx = args.indexOf('--note');
  const review = Number(args[reviewIdx + 1]);
  if (!feature || reviewIdx === -1 || !(review >= 0 && review <= 100)) {
    throw new Error('usage: record <feature> --review <0-100> [--note "..."]');
  }
  if (!cmdVerify()) throw new Error('Locked scorecards were modified; refusing to record.');
  const autoFile = path.join(OUT_DIR, `${feature}.json`);
  const gatesFile = path.join(OUT_DIR, 'gates.json');
  if (!existsSync(autoFile) || !existsSync(gatesFile)) throw new Error('Run `run <feature>` and `gates` first.');
  const auto = readJson<ScorecardResult>(autoFile, {} as ScorecardResult).score;
  const gates = readJson<GateResult>(gatesFile, {} as GateResult);
  const raw = AUTO_WEIGHT * auto + REVIEW_WEIGHT * review;
  const final = Math.round(raw * (gates.passed ? 1 : GATE_PENALTY) * 10) / 10;
  const previousBest = bestFor(feature);
  const improved = final > previousBest;
  const base = run('git', ['rev-parse', '--short', 'HEAD']).output.trim();
  const entry: HistoryEntry = {
    feature,
    auto,
    review,
    gatesPassed: gates.passed,
    final,
    improved,
    previousBest,
    base,
    note: noteIdx === -1 ? undefined : args[noteIdx + 1],
    at: new Date().toISOString(),
  };
  appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`);
  console.log(`${feature}: auto=${auto} review=${review} gates=${gates.passed ? 'pass' : 'FAIL'} → final=${final} (previous best ${previousBest}) ${improved ? 'IMPROVED → commit' : 'not improved → do not commit'}`);
  return improved ? 0 : 3;
}

function cmdStatus(): void {
  // Underscore-prefixed scorecards are harness self-checks, not features.
  const features = listFeatures().filter((f) => !f.startsWith('_'));
  let sum = 0;
  for (const f of features) {
    const best = bestFor(f);
    sum += best;
    console.log(`${best.toFixed(1).padStart(5)}  ${f}`);
  }
  const project = features.length ? sum / features.length : 0;
  console.log(`\nProject score: ${project.toFixed(1)}/100 over ${features.length} feature scorecard(s)`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case 'run':
    await cmdRun(rest);
    break;
  case 'lock':
    cmdLock(rest);
    break;
  case 'verify':
    process.exitCode = cmdVerify() ? 0 : 1;
    break;
  case 'gates':
    process.exitCode = cmdGates(rest).passed ? 0 : 1;
    break;
  case 'record':
    process.exitCode = cmdRecord(rest);
    break;
  case 'status':
    cmdStatus();
    break;
  default:
    console.error('usage: node scoring/cli.ts <run|lock|verify|gates|record|status> ...');
    process.exitCode = 2;
}
