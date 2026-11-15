/**
 * Scorecard: identify-heavy-scripts guide snippet aggregates incrementally (#2377).
 *
 * Contract (guides/performance/identify-heavy-scripts/guide.md, first ```javascript block):
 * - Observes `long-animation-frame` with `buffered: true`.
 * - On every observer callback it reports (console.table) the scripts whose total
 *   duration across the whole page lifecycle so far exceeds 100ms, as
 *   `{ sourceURL, count, totalDuration }`, sorted by totalDuration descending.
 * - Per-callback work stays bounded: it does not re-scan the full history.
 * - It does not retain every PerformanceScriptTiming entry for the page lifetime.
 * - The guide cautions against heavy/synchronous DOM work inside the observer callback
 *   (it can create further long animation frames).
 * The snippet runs in a vm sandbox (child node process with --expose-gc) against a mock
 * PerformanceObserver that delivers 200 batches of synthetic entries.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineScorecard, mean } from '../lib.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const GUIDE = path.join(ROOT, 'guides/performance/identify-heavy-scripts/guide.md');

const RUNNER = String.raw`
import vm from 'node:vm';
import fs from 'node:fs';
const code = fs.readFileSync(process.argv[2], 'utf8');
let callback = null;
let observeOpts = null;
const tables = [];
let reads = 0;
class PerformanceObserver {
  constructor(cb) { callback = cb; }
  observe(opts) { observeOpts = opts; }
  disconnect() {}
}
const quiet = () => {};
const sandboxConsole = { table: (rows) => tables.push(JSON.parse(JSON.stringify(rows))), log: quiet, info: quiet, warn: quiet, error: quiet, debug: quiet };
const context = vm.createContext({ PerformanceObserver, console: sandboxConsole, performance: { now: () => 0 } });
const out = { error: null };
try {
  vm.runInContext(code, context, { timeout: 5000 });
} catch (e) { out.error = 'load: ' + e.message; }

const DURATIONS = { 'https://a.example/app.js': 7, 'https://b.example/ads.js': 3, 'https://c.example/chat.js': 1 };
const expected = new Map();
function add(url, d) {
  const e = expected.get(url) ?? { sourceURL: url, count: 0, totalDuration: 0 };
  e.count++; e.totalDuration += d; expected.set(url, e);
}
function script(url, d) {
  add(url, d);
  return { get sourceURL() { reads++; return url; }, duration: d, invoker: 'x', invokerType: 'user-callback', sourceFunctionName: 'f', sourceCharPosition: 1 };
}
function batch(i) {
  const entries = [];
  for (let e = 0; e < 20; e++) {
    const scripts = [];
    for (const [url, d] of Object.entries(DURATIONS)) scripts.push(script(url, d));
    if (i === 0 && e === 0) { scripts.push(script('https://early.example/boot.js', 500)); scripts.push(script('https://rare.example/once.js', 40)); }
    entries.push({ entryType: 'long-animation-frame', duration: 80, scripts });
  }
  return entries;
}
const refs = [];
const perCallbackReads = [];
function deliver(i) {
  const entries = batch(i);
  if (i === 0) for (const en of entries) for (const s of en.scripts) refs.push(new WeakRef(s));
  const list = { getEntries: () => entries, getEntriesByType: () => entries, getEntriesByName: () => [] };
  const before = reads;
  callback(list, { disconnect() {} });
  perCallbackReads.push(reads - before);
}
if (!out.error && callback) {
  try { for (let i = 0; i < 200; i++) deliver(i); } catch (e) { out.error = 'callback: ' + e.message; }
}
const avg = (a) => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
out.observeOpts = observeOpts;
out.hasCallback = Boolean(callback);
out.lastTable = tables.at(-1) ?? null;
out.tableCount = tables.length;
out.readsFirst = avg(perCallbackReads.slice(0, 5));
out.readsLast = avg(perCallbackReads.slice(-5));
out.expected = [...expected.values()].filter((e) => e.totalDuration > 100).sort((a, b) => b.totalDuration - a.totalDuration);
for (let k = 0; k < 5; k++) { await new Promise((r) => setTimeout(r, 10)); globalThis.gc(); }
out.retainedFraction = refs.length ? refs.filter((r) => r.deref() !== undefined).length / refs.length : 1;
process.stdout.write(JSON.stringify(out));
`;

interface Row {
  sourceURL: string;
  count: number;
  totalDuration: number;
}
interface RunOut {
  error: string | null;
  observeOpts: { type?: string; buffered?: boolean } | null;
  hasCallback: boolean;
  lastTable: Row[] | null;
  tableCount: number;
  readsFirst: number;
  readsLast: number;
  expected: Row[];
  retainedFraction: number;
}

function guideText(): string {
  return fs.readFileSync(GUIDE, 'utf8');
}

let cached: RunOut | null = null;
function run(): RunOut {
  if (cached) return cached;
  const m = guideText().match(/```(?:javascript|js)\n([\s\S]*?)```/);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mwg-heavy-'));
  try {
    fs.writeFileSync(path.join(tmp, 'runner.mjs'), RUNNER);
    fs.writeFileSync(path.join(tmp, 'snippet.js'), m ? m[1] : '');
    const r = spawnSync(process.execPath, ['--expose-gc', path.join(tmp, 'runner.mjs'), path.join(tmp, 'snippet.js')], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    cached = JSON.parse(r.stdout) as RunOut;
    return cached;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const norm = (rows: Row[] | null) =>
  (rows ?? []).map((r) => ({ sourceURL: r.sourceURL, count: r.count, totalDuration: r.totalDuration }));

export default defineScorecard({
  feature: 'heavy-scripts',
  title: 'identify-heavy-scripts snippet aggregates incrementally',
  cases: [
    {
      id: 'final-report-correct',
      description: 'last console.table = heavy scripts over the whole session, sorted desc (exact rows)',
      weight: 3,
      run: () => {
        const r = run();
        const got = norm(r.lastTable);
        const want = norm(r.expected);
        if (JSON.stringify(got) === JSON.stringify(want)) return 1;
        const key = (x: Row) => `${x.sourceURL}|${x.count}|${x.totalDuration}`;
        const g = new Set(got.map(key));
        const hits = want.filter((w) => g.has(key(w))).length;
        return want.length ? (hits / Math.max(want.length, got.length)) * 0.7 : 0;
      },
    },
    {
      id: 'history-preserved',
      description: 'a heavy script seen only in the first batch is still reported at the end; a light one is not',
      weight: 1,
      run: () => {
        const rows = norm(run().lastTable);
        return mean([
          rows.some((x) => x.sourceURL === 'https://early.example/boot.js' && x.totalDuration === 500 && x.count === 1),
          !rows.some((x) => x.sourceURL === 'https://rare.example/once.js'),
        ]);
      },
    },
    {
      id: 'bounded-per-callback-work',
      description: 'sourceURL reads per callback do not grow with history (last 5 vs first 5 callbacks)',
      weight: 5,
      run: () => {
        const r = run();
        if (r.error || !r.readsFirst) return 0;
        const ratio = r.readsLast / r.readsFirst;
        return ratio <= 1.5 ? 1 : ratio <= 5 ? 0.5 : 0;
      },
    },
    {
      id: 'no-entry-retention',
      description: 'script entries from the first batch are garbage-collectable after 200 batches',
      weight: 5,
      run: () => {
        const r = run();
        return r.error || !r.hasCallback ? 0 : 1 - r.retainedFraction;
      },
    },
    {
      id: 'dom-work-caution',
      description: 'guide cautions against heavy/synchronous DOM work inside the observer callback',
      weight: 3,
      run: () => {
        const sentences = guideText().split(/(?<=[.!?])\s+|\n/);
        const hit = sentences.find((s) => /\bDOM\b/.test(s) && /(callback|observer)/i.test(s));
        if (!hit) return 0;
        return /(long animation frame|long-animation-frame|feedback|another|more)/i.test(hit) ? 1 : 0.6;
      },
    },
    {
      id: 'guard-observe-buffered',
      description: "guard: observes 'long-animation-frame' with buffered: true",
      weight: 1,
      run: () => {
        const o = run().observeOpts;
        return o?.type === 'long-animation-frame' && o.buffered === true;
      },
    },
    {
      id: 'guard-runs-cleanly',
      description: 'guard: snippet loads and handles 200 callbacks without throwing, reporting each time',
      weight: 1,
      run: () => {
        const r = run();
        return !r.error && r.tableCount === 200;
      },
    },
  ],
});
