/**
 * Scorecard v2 (stricter, round 2): identify-heavy-scripts guide snippet aggregates
 * script time incrementally (#2377). Replaces the lenient v1 scorecard (kept, locked).
 *
 * Public surface under test: the guide as an agent reads it, i.e. the skills-cli
 * rendering of guides/performance/identify-heavy-scripts/guide.md (raw file as a
 * fallback). Every ```js / ```javascript / ```mjs block (and the concatenation of all
 * of them, for snippets split across blocks) is a candidate; a candidate qualifies when
 * it registers exactly one PerformanceObserver for `long-animation-frame`. The best
 * qualifying candidate is scored, so the snippet's position in the guide and the prose
 * around it do not matter.
 *
 * Contract (the snippet's observable behaviour in a browser-like vm sandbox):
 * - Registers a PerformanceObserver with `{ type: 'long-animation-frame', buffered: true }`
 *   and never disconnects it.
 * - After every observer callback (allowing microtasks, setTimeout, requestIdleCallback,
 *   requestAnimationFrame to settle) it reports the scripts whose TOTAL duration over the
 *   whole page lifecycle so far is strictly greater than 100ms, one row per script URL
 *   with `{ sourceURL, count, totalDuration }`, sorted by totalDuration descending (ties in
 *   any order). A report is structured data passed to any console method (table, log,
 *   info, ...) or sent as the body of navigator.sendBeacon / fetch (JSON string or
 *   object). Accepted row shapes: an array of row objects, a Map or a plain object keyed
 *   by URL, or an object wrapping such an array. Field aliases are accepted
 *   (url/source/script for sourceURL, total/duration for totalDuration,
 *   invocations/calls for count). Not reporting after a callback that does not change
 *   the heavy set is fine (the previous report still holds); no report = [].
 * - Exactly 100ms is not heavy; 100.5ms is. A script crossing the threshold in a later
 *   batch appears from that batch on. Heavy scripts seen only in the first batch stay.
 * - Scripts with an empty sourceURL are aggregated into one row of their own (any label
 *   that is not another script's URL) and never merged into another URL's totals;
 *   omitting that row earns partial credit only.
 * - Many distinct URLs: every heavy URL is reported with exact totals.
 * - Per-callback work does not depend on history: no entry object (frame or script)
 *   is touched after the callback that delivered it has settled, and per-callback entry
 *   accesses do not grow over time.
 * - No entry objects (frames, scripts, entry lists) are retained, and heap usage does
 *   not grow with the number of processed scripts when the set of URLs is fixed (copying
 *   every entry's fields into an array also fails this).
 * - No DOM work inside the observer callback (document is instrumented), and the guide
 *   explicitly cautions against DOM work in the callback and explains why.
 * - Review decisions (round 1): the comment explaining per-URL grouping sits with the
 *   accumulation code; the guide notes that the totals are bounded by the number of
 *   distinct script URLs.
 * - Regression guards: the guide still validates (validateGuide) and the snippet runs
 *   every scenario without throwing.
 *
 * The sandbox runs in child node processes (one functional run per candidate, one
 * --expose-gc memory run for the chosen candidate); deterministic and offline.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineScorecard, lowerIsBetter, mean, ratio } from '../lib.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const GUIDE = path.join(ROOT, 'guides/performance/identify-heavy-scripts/guide.md');

// ---------------------------------------------------------------------------
// Sandbox runner (executed in a child process). Usage:
//   node [--expose-gc] runner.mjs <snippet.js> functional|memory <out.json>
// ---------------------------------------------------------------------------
const RUNNER = String.raw`
import vm from 'node:vm';
import fs from 'node:fs';

const code = fs.readFileSync(process.argv[2], 'utf8');
const mode = process.argv[3];
const THRESHOLD = 100;
const ALLOWED_DOCUMENT_PROPS = new Set(['visibilityState', 'hidden', 'addEventListener', 'removeEventListener',
  'readyState', 'prerendering', 'wasDiscarded', 'then', 'constructor', 'toJSON']);

let quiet = 0; // > 0 while the runner itself inspects values (not counted as snippet work)

// ----- report normalisation -------------------------------------------------
const pick = (o, keys) => { for (const k of keys) if (o[k] !== undefined) return o[k]; return undefined; };
function toRow(v, key) {
  if (!v || typeof v !== 'object') return null;
  const url = pick(v, ['sourceURL', 'url', 'source', 'script', 'scriptURL', 'sourceUrl']) ?? key;
  const total = pick(v, ['totalDuration', 'total', 'duration', 'totalTime', 'time']);
  const count = pick(v, ['count', 'invocations', 'calls', 'occurrences']);
  if (typeof url !== 'string' || typeof total !== 'number') return null;
  return { sourceURL: url, count: typeof count === 'number' ? count : null, totalDuration: total };
}
function toRows(value, depth = 0) {
  if (depth > 3 || value == null) return null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!(s.startsWith('[') || s.startsWith('{'))) return null;
    try { return toRows(JSON.parse(s), depth + 1); } catch { return null; }
  }
  if (typeof value !== 'object') return null;
  if (typeof value.__blobText === 'string') return toRows(value.__blobText, depth + 1);
  if (value instanceof Map || Object.prototype.toString.call(value) === '[object Map]') {
    const rows = [];
    for (const [k, v] of value) { const r = toRow(v, typeof k === 'string' ? k : undefined); if (!r) return null; rows.push(r); }
    return rows;
  }
  if (Array.isArray(value)) {
    const rows = [];
    for (const item of value) {
      let r = null;
      if (Array.isArray(item) && item.length === 2 && typeof item[0] === 'string') r = toRow(item[1], item[0]);
      else r = toRow(item);
      if (!r) return null;
      rows.push(r);
    }
    return rows;
  }
  for (const v of Object.values(value)) {
    if (Array.isArray(v) || (typeof v === 'string' && v.trim().startsWith('['))) {
      const rows = toRows(v, depth + 1);
      if (rows) return rows;
    }
  }
  const entries = Object.entries(value);
  if (entries.length && entries.every(([, v]) => v && typeof v === 'object' && !Array.isArray(v))) {
    const rows = [];
    for (const [k, v] of entries) { const r = toRow(v, k); if (!r) return null; rows.push(r); }
    return rows;
  }
  return null;
}

// ----- sandbox ------------------------------------------------------------------
function makeSandbox(state) {
  const capture = (args) => {
    quiet++;
    try {
      let found = null;
      for (const a of args) { let r = null; try { r = toRows(a); } catch { r = null; } if (r) found = r; }
      if (found) { state.lastReport = found; state.reportCount++; }
    } finally { quiet--; }
  };
  const consoleObj = new Proxy({}, { get: (_t, prop) => (prop === 'table' || prop === 'log' || prop === 'info' ||
    prop === 'debug' || prop === 'dir' || prop === 'warn' || prop === 'error' || prop === 'dirxml')
    ? (...args) => capture(args) : () => {} });
  const tasks = state.tasks;
  let nextId = 1;
  const schedule = (fn, args) => { const id = nextId++; if (typeof fn === 'function') tasks.push({ id, fn, args }); return id; };
  const cancel = (id) => { const i = tasks.findIndex((t) => t.id === id); if (i >= 0) tasks.splice(i, 1); state.intervals.delete(id); };
  class Blob { constructor(parts = []) { this.__blobText = parts.map(String).join(''); } text() { return Promise.resolve(this.__blobText); } }
  const listeners = state.listeners;
  const addEventListener = (type, fn) => { if (typeof fn === 'function' || (fn && typeof fn.handleEvent === 'function')) listeners.push({ type, fn }); };
  const removeEventListener = (type, fn) => { const i = listeners.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) listeners.splice(i, 1); };
  const documentTarget = { visibilityState: 'visible', hidden: false, readyState: 'complete', prerendering: false, wasDiscarded: false,
    addEventListener, removeEventListener };
  const domNode = () => new Proxy(function () {}, { get: (_t, p) => (p === Symbol.toPrimitive ? () => '' : domNode()), apply: () => domNode(), set: () => true, construct: () => domNode() });
  const documentObj = new Proxy(documentTarget, {
    get(t, prop) {
      if (typeof prop === 'string' && !ALLOWED_DOCUMENT_PROPS.has(prop) && state.inCallback && !quiet) state.domTouches++;
      if (prop in t) return t[prop];
      return domNode();
    },
    set(t, prop, v) { if (state.inCallback && !quiet) state.domTouches++; t[prop] = v; return true; },
  });
  class PerformanceObserver {
    static supportedEntryTypes = ['element', 'event', 'first-input', 'largest-contentful-paint', 'layout-shift',
      'long-animation-frame', 'longtask', 'mark', 'measure', 'navigation', 'paint', 'resource', 'visibility-state'];
    constructor(cb) { this._cb = cb; }
    observe(opts = {}) {
      const types = opts.type ? [opts.type] : (opts.entryTypes ?? []);
      if (types.includes('long-animation-frame')) {
        state.observeOpts.push({ type: opts.type, entryTypes: opts.entryTypes, buffered: opts.buffered });
        if (!state.observers.includes(this)) state.observers.push(this);
      }
    }
    disconnect() { state.disconnects++; const i = state.observers.indexOf(this); if (i >= 0) state.observers.splice(i, 1); }
    takeRecords() { return []; }
  }
  let now = 1000;
  const sandbox = {
    PerformanceObserver, console: consoleObj, Blob,
    performance: { now: () => (now += 0.1), timeOrigin: 0, getEntries: () => [], getEntriesByType: () => [], getEntriesByName: () => [], mark() {}, measure() {} },
    navigator: { sendBeacon: (_url, data) => { capture([data]); return true; }, userAgent: 'sandbox' },
    fetch: (_url, opts) => { if (opts && opts.body !== undefined) capture([opts.body]); return Promise.resolve({ ok: true, status: 200, json: async () => ({}), text: async () => '' }); },
    setTimeout: (fn, _ms, ...args) => schedule(fn, args), clearTimeout: cancel,
    setInterval: (fn, _ms, ...args) => { const id = nextId++; if (typeof fn === 'function') state.intervals.set(id, { fn, args }); return id; },
    clearInterval: cancel,
    requestIdleCallback: (fn) => schedule(fn, [{ didTimeout: false, timeRemaining: () => 50 }]), cancelIdleCallback: cancel,
    requestAnimationFrame: (fn) => schedule(fn, [now]), cancelAnimationFrame: cancel,
    queueMicrotask: (fn) => Promise.resolve().then(fn),
    scheduler: { postTask: (fn) => new Promise((res) => schedule(() => res(fn()), [])), yield: () => Promise.resolve() },
    addEventListener, removeEventListener, dispatchEvent: () => true,
    document: documentObj, location: { href: 'https://site.example/', origin: 'https://site.example' },
  };
  sandbox.window = sandbox; sandbox.self = sandbox;
  return sandbox;
}

async function flush(state) {
  for (let round = 0; round < 20; round++) {
    await new Promise((r) => setImmediate(r));
    if (!state.tasks.length) {
      if (round === 0 && state.intervals.size) { for (const { fn, args } of [...state.intervals.values()]) safe(state, () => fn(...args)); continue; }
      break;
    }
    const batch = state.tasks.splice(0);
    for (const t of batch) safe(state, () => t.fn(...t.args));
  }
}
function safe(state, fn) {
  state.inCallback = true;
  try { const r = fn(); if (r && typeof r.then === 'function') r.then(undefined, (e) => { state.errors.push('async: ' + (e && e.message)); }); }
  catch (e) { state.errors.push('callback: ' + (e && e.message)); }
  finally { state.inCallback = false; }
}

function newState() {
  return { tasks: [], intervals: new Map(), listeners: [], observers: [], observeOpts: [], disconnects: 0, errors: [],
    lastReport: null, reportCount: 0, domTouches: 0, inCallback: false };
}

function load(state) {
  const context = vm.createContext(makeSandbox(state));
  try { vm.runInContext(code, context, { timeout: 5000 }); }
  catch (e) { state.errors.push('load: ' + (e && e.message)); }
  return context;
}

async function deliver(state, entries) {
  const list = {
    getEntries: () => entries.slice(),
    getEntriesByType: (t) => (t === 'long-animation-frame' ? entries.slice() : []),
    getEntriesByName: (n, t) => entries.filter((e) => n === 'long-animation-frame' && (!t || t === 'long-animation-frame')),
  };
  for (const obs of state.observers.slice()) safe(state, () => obs._cb.call(obs, list, obs));
  await flush(state);
  return list;
}

async function pageHide(state) {
  for (const l of state.listeners.slice()) {
    if (l.type === 'visibilitychange' || l.type === 'pagehide') {
      const ev = { type: l.type, persisted: false, target: null };
      safe(state, () => (typeof l.fn === 'function' ? l.fn(ev) : l.fn.handleEvent(ev)));
    }
  }
  await flush(state);
}

// ----- entry factories -------------------------------------------------------------
let tick = 0;
function makeScript(url, duration, wrap) {
  const s = { name: 'script', entryType: 'script', startTime: tick, duration, executionStart: tick + 1,
    forcedStyleAndLayoutDuration: 0, pauseDuration: 0, invoker: 'https://site.example/#click', invokerType: 'event-listener',
    sourceCharPosition: 10, sourceFunctionName: 'handler', sourceURL: url, windowAttribution: 'self', window: null };
  s.toJSON = () => ({ ...s, toJSON: undefined });
  return wrap ? wrap(s) : s;
}
function makeFrame(scripts, wrap) {
  tick += 100;
  const total = scripts.reduce((a, s) => a + (s.duration ?? 0), 0);
  const f = { name: 'long-animation-frame', entryType: 'long-animation-frame', startTime: tick, duration: Math.max(51, total + 10),
    renderStart: tick + total, styleAndLayoutStart: tick + total + 1, firstUIEventTimestamp: 0, blockingDuration: Math.max(0, total - 50),
    scripts };
  f.toJSON = () => ({ ...f, toJSON: undefined });
  return wrap ? wrap(f) : f;
}
// Each batch spec: array of frames; each frame: array of [url, duration].
function expectedFrom(totals) {
  return [...totals.values()].filter((t) => t.totalDuration > THRESHOLD).sort((a, b) => b.totalDuration - a.totalDuration)
    .map((t) => ({ ...t }));
}
function accumulate(totals, batch) {
  for (const frame of batch) for (const [url, d] of frame) {
    const t = totals.get(url) ?? { sourceURL: url, count: 0, totalDuration: 0 };
    t.count++; t.totalDuration += d; totals.set(url, t);
  }
}

async function runScenario(name, batches, opts = {}) {
  const state = newState();
  load(state);
  const res = { name, errors: state.errors, observers: state.observers.length, observeOpts: state.observeOpts,
    checkpoints: [], final: null, finalAfterHide: null, reportCount: 0, disconnects: 0, domTouches: 0 };
  const totals = new Map();
  if (state.observers.length !== 1) { res.observers = state.observers.length; return res; }
  for (const batch of batches) {
    accumulate(totals, batch);
    const entries = batch.map((frame) => makeFrame(frame.map(([u, d]) => makeScript(u, d))));
    await deliver(state, entries);
    if (opts.checkpoints) res.checkpoints.push({ got: state.lastReport ?? [], want: expectedFrom(totals) });
  }
  res.final = { got: state.lastReport ?? [], want: expectedFrom(totals) };
  await pageHide(state);
  res.finalAfterHide = { got: state.lastReport ?? [], want: expectedFrom(totals) };
  res.reportCount = state.reportCount;
  res.disconnects = state.disconnects;
  res.domTouches = state.domTouches;
  res.observers = state.observers.length;
  return res;
}

// Work scenario: every entry is a Proxy counting accesses; accesses after the
// delivering callback settled are "stale" (history re-scan / retained entries).
async function runWorkScenario(batchCount) {
  const state = newState();
  load(state);
  const out = { errors: state.errors, perCallback: [], stale: 0, observers: state.observers.length };
  if (state.observers.length !== 1) return out;
  let open = -1;
  let accesses = 0;
  const wrapFor = (batchIdx) => (obj) => {
    const touch = () => { if (quiet) return; if (batchIdx !== open) out.stale++; else accesses++; };
    return new Proxy(obj, {
      get(t, p, r) { touch(); return Reflect.get(t, p, r); },
      has(t, p) { touch(); return Reflect.has(t, p); },
      ownKeys(t) { touch(); return Reflect.ownKeys(t); },
      getOwnPropertyDescriptor(t, p) { touch(); return Reflect.getOwnPropertyDescriptor(t, p); },
    });
  };
  const urls = ['https://a.example/app.js', 'https://b.example/ads.js', 'https://c.example/chat.js', 'https://d.example/vendor.js', ''];
  for (let i = 0; i < batchCount; i++) {
    const wrap = wrapFor(i);
    const entries = [];
    quiet++;
    try { for (let f = 0; f < 10; f++) entries.push(makeFrame(urls.map((u, k) => makeScript(u, 1 + k, wrap)), wrap)); }
    finally { quiet--; }
    open = i; accesses = 0;
    await deliver(state, entries);
    out.perCallback.push(accesses);
    open = -1;
  }
  // Page hide must not touch old entries either.
  open = batchCount;
  await pageHide(state);
  return out;
}

async function runMemory() {
  const state = newState();
  // Keep the sandbox (and whatever the snippet retains) reachable while measuring.
  globalThis.__sandboxState = state;
  state.context = load(state);
  const out = { errors: state.errors, observers: state.observers.length, growth: null, retained: null, sampled: 0, timedOut: false, batches: 0 };
  if (state.observers.length !== 1) return out;
  const urls = ['https://a.example/app.js', 'https://b.example/ads.js', 'https://c.example/chat.js', 'https://d.example/vendor.js'];
  const refs = { frames: [], scripts: [], lists: [] };
  const WARM = 200, MORE = 2000, KEEP_LAST = 5;
  const started = Date.now();
  const gcAll = async () => { for (let k = 0; k < 6; k++) { await new Promise((r) => setTimeout(r, 5)); globalThis.gc(); } };
  let h1 = 0;
  for (let i = 0; i < WARM + MORE; i++) {
    if (i === WARM) { state.lastReport = null; await gcAll(); h1 = process.memoryUsage().heapUsed; }
    const entries = [];
    for (let f = 0; f < 10; f++) entries.push(makeFrame([0, 1, 2, 3, 0].map((k, j) => makeScript(urls[k], 1 + j))));
    const sample = i % 10 === 0 && i < WARM + MORE - KEEP_LAST;
    if (sample) { refs.frames.push(new WeakRef(entries[3])); refs.scripts.push(new WeakRef(entries[7].scripts[2])); }
    const list = await deliver(state, entries);
    if (sample) refs.lists.push(new WeakRef(list));
    out.batches = i + 1;
    if (Date.now() - started > 25000) { out.timedOut = true; break; }
  }
  state.lastReport = null;
  await gcAll();
  if (!out.timedOut) out.growth = process.memoryUsage().heapUsed - h1;
  const alive = (a) => a.filter((r) => r.deref() !== undefined).length / a.length;
  out.sampled = refs.frames.length + refs.scripts.length + refs.lists.length;
  // Worst of the three kinds: retaining every script entry is as bad as retaining everything.
  out.retained = refs.frames.length ? Math.max(alive(refs.frames), alive(refs.scripts), alive(refs.lists)) : null;
  out.observers = state.observers.length;
  out.reportCount = state.reportCount;
  return out;
}

// ----- scenarios -----------------------------------------------------------------
function mainBatches() {
  const recurring = [['https://a.example/app.js', 7], ['https://b.example/ads.js', 3.5], ['https://c.example/chat.js', 1]];
  const batches = [];
  for (let i = 0; i < 120; i++) {
    const frames = [];
    for (let e = 0; e < 20; e++) frames.push(recurring.map(([u, d]) => [u, d]));
    if (i === 0) { frames[0].push(['https://early.example/boot.js', 500], ['https://rare.example/once.js', 40]); }
    if (i % 7 === 3) frames.push([]); // frame without script attribution
    batches.push(frames);
  }
  return batches;
}
function thresholdBatches() {
  return [
    [[['https://cross.example/x.js', 60], ['https://exact.example/two-halves.js', 50], ['https://single.example/hundred.js', 100]],
     [['https://over.example/one-oh-one.js', 101]]],
    [[['https://exact.example/two-halves.js', 50]]],
    [[['https://just.example/over.js', 100.5]]],
    [[['https://cross.example/x.js', 60]]],
    [[]],
    [[['https://late.example/z.js', 99.5]], [['https://late.example/z.js', 0.5]]],
    [[['https://late.example/z.js', 0.5]]],
  ];
}
function emptySourceBatches() {
  return [
    [[['', 40], ['https://real.example/app.js', 80]], [['https://light.example/l.js', 10]]],
    [[['', 40]], [['https://real.example/app.js', 70]]],
    [[['', 40], ['https://light.example/l.js', 10]]],
  ];
}
function manyUrlBatches() {
  // 400 distinct URLs spread over 5 batches; totals straddle the threshold
  // (including exact 100s and ties).
  const batches = [[], [], [], [], []];
  for (let u = 0; u < 400; u++) {
    const url = 'https://cdn' + (u % 13) + '.example/lib-' + u + '.js';
    const total = [100, 100.5, 99.5, 150, 250][u % 5] + (u % 3 === 0 ? 0 : (u % 40));
    const parts = [1, 2, 4][(u >> 1) % 3];
    for (let p = 0; p < parts; p++) batches[(u + p) % 5].push([[url, total / parts]]);
  }
  return batches;
}

const result = { mode, scenarios: {}, work: null, memory: null, fatal: null };
try {
  if (mode === 'memory') {
    result.memory = await runMemory();
  } else {
    result.scenarios.main = await runScenario('main', mainBatches(), { checkpoints: true });
    result.scenarios.threshold = await runScenario('threshold', thresholdBatches(), { checkpoints: true });
    result.scenarios.emptySource = await runScenario('emptySource', emptySourceBatches(), { checkpoints: true });
    result.scenarios.manyUrls = await runScenario('manyUrls', manyUrlBatches(), { checkpoints: true });
    result.work = await runWorkScenario(150);
  }
} catch (e) { result.fatal = String(e && e.stack || e); }
fs.writeFileSync(process.argv[4], JSON.stringify(result));
process.exit(0);
`;

// ---------------------------------------------------------------------------
// Parent side
// ---------------------------------------------------------------------------
interface Row {
  sourceURL: string;
  count: number | null;
  totalDuration: number;
}
interface Checkpoint {
  got: Row[];
  want: Row[];
}
interface ScenarioOut {
  name: string;
  errors: string[];
  observers: number;
  observeOpts: { type?: string; entryTypes?: string[]; buffered?: boolean }[];
  checkpoints: Checkpoint[];
  final: Checkpoint | null;
  finalAfterHide: Checkpoint | null;
  reportCount: number;
  disconnects: number;
  domTouches: number;
}
interface WorkOut {
  errors: string[];
  perCallback: number[];
  stale: number;
  observers: number;
}
interface MemoryOut {
  errors: string[];
  observers: number;
  growth: number | null;
  retained: number | null;
  sampled: number;
  timedOut: boolean;
  batches: number;
}
interface FunctionalOut {
  scenarios: Record<'main' | 'threshold' | 'emptySource' | 'manyUrls', ScenarioOut | undefined>;
  work: WorkOut | null;
  fatal: string | null;
}

let renderedCache: string | null = null;
/** The guide as agents receive it (skills-cli rendering); raw markdown as a fallback. */
async function guideMarkdown(): Promise<string> {
  if (renderedCache !== null) return renderedCache;
  try {
    const { extractGuideChunks } = await import('../../src/core/guide-chunks.ts');
    const r = extractGuideChunks({
      filePath: GUIDE,
      category: 'performance',
      id: 'identify-heavy-scripts',
      target: 'skills-cli',
      noChunking: true,
    });
    renderedCache = r?.processedMarkdown ?? fs.readFileSync(GUIDE, 'utf8');
  } catch {
    renderedCache = fs.readFileSync(GUIDE, 'utf8');
  }
  return renderedCache;
}

interface CodeBlock {
  lang: string;
  text: string;
}
async function guideParts(): Promise<{ blocks: CodeBlock[]; prose: string }> {
  const md = await guideMarkdown();
  const { marked } = await import('marked');
  const blocks: CodeBlock[] = [];
  const prose: string[] = [];
  const walk = (tokens: unknown[]) => {
    for (const t of tokens as { type: string; lang?: string; text?: string; raw?: string; tokens?: unknown[]; items?: unknown[] }[]) {
      if (t.type === 'code') {
        blocks.push({ lang: (t.lang ?? '').trim().split(/\s+/)[0].toLowerCase(), text: t.text ?? '' });
        continue;
      }
      if (t.tokens) walk(t.tokens);
      else if (t.items) walk(t.items);
      else if (t.type !== 'space') prose.push(t.raw ?? t.text ?? '');
      // Block boundaries end a sentence (headings, list items, paragraphs, ...).
      if (['paragraph', 'heading', 'list_item', 'blockquote', 'table', 'html'].includes(t.type)) prose.push('\n\n');
    }
  };
  walk(marked.lexer(md));
  return { blocks, prose: prose.join(' ') };
}

/** Contiguous comment blocks of a snippet, each as one line of text. */
function commentBlocks(snippet: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inBlock = false;
  for (const line of snippet.split('\n')) {
    const t = line.trim();
    const isComment = inBlock || t.startsWith('//') || t.startsWith('/*');
    if (t.startsWith('/*')) inBlock = !t.includes('*/');
    else if (inBlock && t.includes('*/')) inBlock = false;
    if (isComment) cur.push(t.replace(/^\/\/\s?|^\/\*+|\*+\/$|^\*\s?/g, ''));
    else if (cur.length) {
      out.push(cur.join(' '));
      cur = [];
    }
    const trailing = !isComment && t.match(/\/\/(.*)$/);
    if (trailing) out.push(trailing[1]);
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}

function runChild(snippet: string, mode: 'functional' | 'memory'): unknown {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mwg-heavy-v2-'));
  try {
    fs.writeFileSync(path.join(tmp, 'runner.mjs'), RUNNER);
    fs.writeFileSync(path.join(tmp, 'snippet.js'), snippet);
    const args = mode === 'memory' ? ['--expose-gc'] : [];
    const outFile = path.join(tmp, 'out.json');
    spawnSync(process.execPath, [...args, path.join(tmp, 'runner.mjs'), path.join(tmp, 'snippet.js'), mode, outFile], {
      stdio: 'ignore',
      timeout: 40_000,
    });
    try {
      return JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } catch {
      return null;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ----- comparison helpers -----------------------------------------------------------
const EPS = 1e-6;
const rowKey = (r: Row) => `${r.sourceURL}|${r.count}|${Math.round(r.totalDuration * 1000) / 1000}`;
function sortedDesc(rows: Row[]): boolean {
  for (let i = 1; i < rows.length; i++) if (rows[i].totalDuration > rows[i - 1].totalDuration + EPS) return false;
  return true;
}
function sameRows(got: Row[], want: Row[]): boolean {
  if (got.length !== want.length) return false;
  const a = got.map(rowKey).sort();
  const b = want.map(rowKey).sort();
  return a.every((k, i) => k === b[i]);
}
function exactReport(cp: Checkpoint | null | undefined): boolean {
  return Boolean(cp) && sameRows(cp!.got, cp!.want) && sortedDesc(cp!.got);
}
/** Fraction of checkpoints whose report exactly matches (rows + order). */
function checkpointRatio(s: ScenarioOut | undefined): number {
  if (!s || !s.checkpoints.length) return 0;
  return ratio(s.checkpoints.filter((cp) => exactReport(cp)).length, s.checkpoints.length);
}
function urlsAt(s: ScenarioOut | undefined, i: number): Set<string> {
  return new Set((s?.checkpoints[i]?.got ?? []).map((r) => r.sourceURL));
}
function rowAt(s: ScenarioOut | undefined, i: number, url: string): Row | undefined {
  return s?.checkpoints[i]?.got.find((r) => r.sourceURL === url);
}

function functionalSelectionScore(f: FunctionalOut | null): number {
  if (!f || f.fatal) return -1;
  const s = Object.values(f.scenarios);
  if (s.some((x) => !x || x.observers !== 1)) return -1;
  // Prefer the snippet that is correct, clean, and does not re-scan history (e.g. when the
  // guide also shows an anti-pattern block).
  return mean(s.map((x) => checkpointRatio(x))) + mean(s.map((x) => x!.errors.length === 0)) + (f.work?.stale === 0 ? 1 : 0);
}

interface Chosen {
  snippet: string | null;
  candidates: number;
  functional: FunctionalOut | null;
}
let chosenCache: Promise<Chosen> | null = null;
function chosen(): Promise<Chosen> {
  chosenCache ??= (async () => {
    const { blocks } = await guideParts();
    const js = blocks.filter((b) => ['js', 'javascript', 'mjs'].includes(b.lang)).map((b) => b.text);
    const candidates = [...js];
    if (js.length > 1) candidates.push(js.join('\n;\n'));
    let best: Chosen = { snippet: null, candidates: 0, functional: null };
    let bestScore = -Infinity;
    for (const snippet of candidates) {
      if (!/PerformanceObserver/.test(snippet)) continue;
      const f = runChild(snippet, 'functional') as FunctionalOut | null;
      const score = functionalSelectionScore(f);
      if (score < 0) continue;
      best.candidates++;
      if (score > bestScore) {
        bestScore = score;
        best = { snippet, candidates: best.candidates, functional: f };
      }
    }
    return best;
  })();
  return chosenCache;
}
async function functional(): Promise<FunctionalOut> {
  const c = await chosen();
  if (!c.functional) throw new Error('no guide code block registers exactly one long-animation-frame observer');
  return c.functional;
}
let memoryCache: Promise<MemoryOut | null> | null = null;
function memory(): Promise<MemoryOut | null> {
  memoryCache ??= chosen().then((c) => (c.snippet ? (runChild(c.snippet, 'memory') as { memory: MemoryOut | null } | null)?.memory ?? null : null));
  return memoryCache;
}

/** Sentences of guide prose + snippet comments. */
async function sentences(includeCodeComments: boolean): Promise<string[]> {
  const { prose } = await guideParts();
  let text = prose;
  if (includeCodeComments) {
    const c = await chosen();
    text += `\n\n${commentBlocks(c.snippet ?? '').join('\n\n')}`;
  }
  return text
    .split(/\n\s*\n|(?<=[.!?;])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export default defineScorecard({
  feature: 'heavy-scripts-v2',
  title: 'identify-heavy-scripts snippet aggregates incrementally (strict v2)',
  cases: [
    {
      id: 'final-report-exact',
      description: 'main scenario (120 batches, varied durations, frames without scripts, an empty callback): last report = all scripts > 100ms over the session, exact count/total, sorted desc',
      weight: 3,
      run: async () => {
        const s = (await functional()).scenarios.main;
        if (!s?.final) return 0;
        if (exactReport(s.final)) return 1;
        // Partial: share of expected rows reported exactly, penalising extra rows; no credit for order.
        const want = new Set(s.final.want.map(rowKey));
        const hits = s.final.got.filter((r) => want.has(rowKey(r))).length;
        return (0.5 * hits) / Math.max(s.final.want.length, s.final.got.length);
      },
    },
    {
      id: 'progressive-reports',
      description: 'after every callback the latest report matches the heavy set so far (main + threshold scenarios, fraction of checkpoints)',
      weight: 2,
      run: async () => {
        const f = await functional();
        return mean([checkpointRatio(f.scenarios.main), checkpointRatio(f.scenarios.threshold)]);
      },
    },
    {
      id: 'threshold-boundaries',
      description: 'strict > 100ms: exactly 100 (one entry or 50+50) never reported, 100.5 and 101 reported, scripts crossing 100 in a later batch appear exactly from that batch',
      weight: 2,
      run: async () => {
        const s = (await functional()).scenarios.threshold;
        if (!s || s.checkpoints.length !== 7) return 0;
        const never = ['https://exact.example/two-halves.js', 'https://single.example/hundred.js'];
        const checks: boolean[] = [];
        for (let i = 0; i < 7; i++) {
          const urls = urlsAt(s, i);
          checks.push(never.every((u) => !urls.has(u)));
          checks.push(urls.has('https://over.example/one-oh-one.js'));
          checks.push(urls.has('https://cross.example/x.js') === i >= 3);
          checks.push(urls.has('https://just.example/over.js') === i >= 2);
          // late.example: 99.5 + 0.5 = 100 at batch 5 (not heavy), 100.5 at batch 6.
          checks.push(urls.has('https://late.example/z.js') === i >= 6);
        }
        const cross = rowAt(s, 3, 'https://cross.example/x.js');
        checks.push(Boolean(cross && cross.count === 2 && Math.abs(cross.totalDuration - 120) < EPS));
        const late = rowAt(s, 6, 'https://late.example/z.js');
        checks.push(Boolean(late && late.count === 3 && Math.abs(late.totalDuration - 100.5) < EPS));
        return mean(checks);
      },
    },
    {
      id: 'history-preserved',
      description: 'a heavy script seen only in the first batch is still reported (count 1, 500ms) at the end; a light first-batch script never is',
      weight: 1,
      run: async () => {
        const s = (await functional()).scenarios.main;
        const rows = s?.final?.got ?? [];
        return mean([
          rows.some((r) => r.sourceURL === 'https://early.example/boot.js' && r.count === 1 && Math.abs(r.totalDuration - 500) < EPS),
          !rows.some((r) => r.sourceURL === 'https://rare.example/once.js'),
          Boolean(s?.checkpoints.length) && s!.checkpoints.every((cp) => !cp.got.some((r) => r.sourceURL === 'https://rare.example/once.js')),
        ]);
      },
    },
    {
      id: 'many-distinct-urls',
      description: '400 distinct URLs straddling the threshold (exact 100s, ties): F1 of reported URL set, exact totals/counts of reported rows, descending order',
      weight: 2,
      run: async () => {
        const s = (await functional()).scenarios.manyUrls;
        if (!s?.final) return 0;
        const want = new Map(s.final.want.map((r) => [r.sourceURL, r]));
        const got = s.final.got;
        const tp = got.filter((r) => want.has(r.sourceURL)).length;
        const fp = got.length - tp;
        const fn = want.size - tp;
        const f1 = want.size + got.length === 0 ? 0 : (2 * tp) / (2 * tp + fp + fn);
        const exact = ratio(got.filter((r) => want.has(r.sourceURL) && rowKey(r) === rowKey(want.get(r.sourceURL)!)).length, want.size);
        return 0.5 * f1 + 0.3 * exact + 0.2 * (got.length > 1 && sortedDesc(got) ? 1 : 0);
      },
    },
    {
      id: 'empty-source-url',
      description: "scripts with sourceURL '' are aggregated into one own row (3 entries, 120ms; any label) and never merged into another URL; omitting that row earns half",
      weight: 1.5,
      run: async () => {
        const s = (await functional()).scenarios.emptySource;
        if (!s?.final || s.errors.length) return 0;
        const got = s.final.got;
        const realUrls = new Set(['https://real.example/app.js', 'https://light.example/l.js']);
        const real = got.find((r) => r.sourceURL === 'https://real.example/app.js');
        const realOk = Boolean(real && real.count === 2 && Math.abs(real.totalDuration - 150) < EPS);
        const lightAbsent = !got.some((r) => r.sourceURL === 'https://light.example/l.js');
        const others = got.filter((r) => !realUrls.has(r.sourceURL));
        let emptyCredit = 0;
        if (others.length === 0) emptyCredit = 0.5;
        else if (others.length === 1 && others[0].count === 3 && Math.abs(others[0].totalDuration - 120) < EPS) emptyCredit = 1;
        const sorted = sortedDesc(got);
        return mean([realOk, lightAbsent, emptyCredit, sorted]);
      },
    },
    {
      id: 'no-history-rescan',
      description: 'no frame/script entry is touched after its callback settled (stale accesses = 0, else 0 credit); per-callback entry accesses do not grow (last 10 vs first 10 callbacks, full at <= 1.25x, zero at >= 3x)',
      weight: 3,
      run: async () => {
        const w = (await functional()).work;
        if (!w || w.observers !== 1 || w.errors.length || w.perCallback.length < 20) return 0;
        if (w.stale > 0) return 0;
        const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
        const first = avg(w.perCallback.slice(0, 10));
        const last = avg(w.perCallback.slice(-10));
        if (!(first > 0)) return 0;
        return lowerIsBetter(last / first, 1.25, 3);
      },
    },
    {
      id: 'no-entry-retention',
      description: 'frame entries, script entries and entry lists sampled from every 10th of 2200 batches are garbage-collectable (credit = 1 - worst retained fraction of the three kinds, 0 if the run times out)',
      weight: 2.5,
      timeoutMs: 60_000,
      run: async () => {
        const m = await memory();
        if (!m || m.timedOut || m.errors.length || m.retained === null || m.sampled < 100) return 0;
        return 1 - m.retained;
      },
    },
    {
      id: 'bounded-heap-growth',
      description: 'with 4 fixed URLs, heap growth over 2000 batches x 50 scripts (100k entries) after warm-up stays small (full <= 512KiB, zero >= 3MiB): copying entry fields also fails',
      weight: 2.5,
      timeoutMs: 60_000,
      run: async () => {
        const m = await memory();
        if (!m || m.timedOut || m.errors.length || m.growth === null) return 0;
        return lowerIsBetter(m.growth, 512 * 1024, 3 * 1024 * 1024);
      },
    },
    {
      id: 'no-dom-work-in-callback',
      description: 'the snippet does no DOM work (document access other than visibility/listeners) inside the observer callback in any scenario',
      weight: 1.5,
      run: async () => {
        const f = await functional();
        const s = Object.values(f.scenarios);
        if (s.some((x) => !x)) return 0;
        return s.every((x) => x!.domTouches === 0 && x!.reportCount > 0);
      },
    },
    {
      id: 'dom-work-caution-documented',
      description: 'one sentence (prose or snippet comment) is a negative directive (don\'t/avoid/never/keep out/defer) about DOM work in the observer callback AND states the consequence (another long animation frame / blocking); directive without consequence = 0.4',
      weight: 1,
      run: async () => {
        const directive = /\b(don['’]?t|do not|avoid|never|refrain|keep (?:it |such work |this )?out|defer|instead of|rather than)\b/i;
        const dom = /\bDOM\b|\bdocument\.|innerHTML|\blayout\b|debug panel|on-page|render(?:ing)? (?:to|into|on) the page/i;
        const where = /\b(callback|observer|handler)\b/i;
        const consequence = /long(?:[- ]animation)?[- ]frames?|\bLoAF\b|\bjank|block(?:s|ing)? the main thread|feedback loop|itself (?:cause|create|trigger|produce|add)|skew|distort|inflate/i;
        let best = 0;
        for (const s of await sentences(true)) {
          if (!(directive.test(s) && dom.test(s) && where.test(s))) continue;
          best = Math.max(best, consequence.test(s) ? 1 : 0.4);
        }
        return best;
      },
    },
    {
      id: 'review-grouping-comment-placement',
      description: 'review decision: the nearest comment above the first code line that reads a script sourceURL explains per-URL grouping/aggregation, with at most one code line in between',
      weight: 0.5,
      run: async () => {
        const c = await chosen();
        const lines = (c.snippet ?? '').split('\n');
        const isComment = (l: string) => /^\s*(\/\/|\/\*|\*)/.test(l);
        const first = lines.findIndex((l) => !isComment(l) && /\.sourceURL\b|\bsourceURL\s*[}:,]/.test(l) && !/^\s*(const|let|var)\s+\w+\s*=\s*new\s+Map/.test(l));
        if (first < 0) return 0;
        let codeBetween = 0;
        for (let i = first - 1; i >= 0; i--) {
          const l = lines[i];
          if (!l.trim()) continue;
          if (isComment(l)) {
            // gather the contiguous comment block
            let j = i;
            const block: string[] = [];
            while (j >= 0 && (isComment(lines[j]) || !lines[j].trim())) block.unshift(lines[j--]);
            const text = block.join(' ');
            return codeBetween <= 1 && /\b(group|aggregat|accumulat|per[- ](?:script )?(?:url|source)|running total|by (?:its )?(?:source ?url|url|script))/i.test(text);
          }
          codeBetween++;
          if (codeBetween > 1) return 0;
        }
        return 0;
      },
    },
    {
      id: 'review-map-bound-note',
      description: 'review decision: the guide (prose or snippet comment) notes the totals grow only with the number of distinct script URLs',
      weight: 0.5,
      run: async () => {
        for (const s of await sentences(true)) {
          if (/\b(distinct|unique|different|number of)\b[^.]*\b(script|source)?\s*(urls?|scripts|sources)\b/i.test(s) &&
            /\b(bound|bounded|grows?|proportional|scales?|memory|size|only)\b/i.test(s)) return 1;
        }
        return 0;
      },
    },
    {
      id: 'guard-observe-buffered',
      description: "guard: observes { type: 'long-animation-frame', buffered: true } and never disconnects",
      weight: 0.5,
      run: async () => {
        const f = await functional();
        const s = Object.values(f.scenarios);
        if (s.some((x) => !x)) return 0;
        return s.every((x) => x!.observeOpts.length === 1 && x!.observeOpts[0].type === 'long-animation-frame' &&
          x!.observeOpts[0].buffered === true && x!.disconnects === 0 && x!.observers === 1);
      },
    },
    {
      id: 'guard-runs-cleanly',
      description: 'guard: snippet loads and handles every scenario (incl. empty callbacks, frames without scripts, empty sourceURL) without throwing, and reports',
      weight: 1,
      run: async () => {
        const f = await functional();
        if (f.fatal) return 0;
        const runs = [...Object.values(f.scenarios), f.work];
        return mean(runs.map((x) => Boolean(x) && x!.errors.length === 0 && x!.observers === 1 && ('reportCount' in x! ? x.reportCount > 0 : true)));
      },
    },
    {
      id: 'guard-guide-valid',
      description: 'guard: guide passes validateGuide (frontmatter, macros, code fences, links) with 0 errors',
      weight: 0.5,
      run: async () => {
        const { validateGuide } = await import('../../src/core/guide-validation.ts');
        return validateGuide(GUIDE).errors.length === 0;
      },
    },
  ],
});
