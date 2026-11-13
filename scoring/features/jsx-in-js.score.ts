/**
 * Scorecard: legacy-scan applies element (DOM/JSX) rules to JSX found in
 * `.js`, `.mjs` and `.cjs` files.
 *
 * Problem (at the time this scorecard was locked)
 * -----------------------------------------------
 * `scanFiles` (src/analyzing/scanners/index.ts) only passes `dom` rules to the
 * JSX scanner for `.jsx` / `.tsx`. The TypeScript parser already produces JSX
 * nodes for `.js` / `.mjs` / `.cjs`, but those files get no element findings,
 * so CRA / older Next.js / Gatsby projects (JSX in `.js`) are under-reported:
 * the identical login form yields `autofill-sign-in-form` in `Login.jsx` and
 * nothing in `Login.js`.
 *
 * Contract measured here (public entry points only: `scanFiles` with
 * `QUALIFIED_RULES`, and `runAnalyzeCli` for the end-to-end case)
 * -------------------------------------------------------------------------
 * 1. JSX in `.js`, `.mjs`, `.cjs` is scanned by the element rules and yields
 *    the SAME findings (rule id, line, message, line content, snippet) as the
 *    identical source saved as `.jsx`. This includes rules whose matchers gate
 *    on the file extension themselves (autofill-address-form,
 *    autofill-payment-form), Flow-annotated components, fragments, and
 *    comparison-heavy component code. Negative JSX (valid autocomplete, SRI
 *    attributes, spread props, member-expression tags) stays negative.
 * 2. JS-rule findings in those files are unaffected (a file with both JSX and
 *    JS-rule triggers yields the union).
 * 3. `.ts` / `.mts` / `.cts` stay excluded from element rules (angle-bracket
 *    type assertions conflict with JSX): no crash, no element findings, JS-rule
 *    findings unchanged even with `<any>x` / `<HTMLInputElement>y` casts.
 * 4. Non-JSX `.js` files behave exactly as before: identical findings
 *    (golden values captured on the unmodified scanner), HTML inside strings,
 *    template literals, regexes or comments does NOT become element findings,
 *    and parser-hostile code (Flow types, `a < b > c` chains, HTML comments)
 *    does not crash the scan.
 * 5. `.jsx` / `.tsx` behaviour is unchanged (golden values).
 * 6. Performance on plain (JSX-free) JS does not regress meaningfully:
 *    - files that today are never parsed (no JS-rule fastTokens, but common
 *      DOM-rule fastTokens such as "export"/"password"/"address") must not
 *      start paying a full parse merely because element rules are now eligible
 *      for `.js` (measured as extra ms/file vs. the same workload scanned with
 *      the `dom` rules removed);
 *    - files that are parsed anyway (JS-rule fastTokens present) must not get
 *      dramatically slower (time ratio vs. the same no-dom control).
 *    Both are measured in the same process/run, min-of-N, so they are robust on
 *    a 2-core machine.
 *
 * Cases 1–7 (feature) score 0 on the unmodified scanner; the regression guards
 * (plain JS, TS family, parser-hostile JS, JSX/TSX, perf) score full credit on
 * the unmodified scanner and must stay there. Offline, deterministic, < 60 s.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AnalyzeJsonOutput } from '../../src/analyzing/cli.ts';
import type { AnalyzerFinding, AnalyzerRule } from '../../src/analyzing/schema.ts';
import { defineScorecard, f1, lowerIsBetter, mean } from '../lib.ts';

// ---------------------------------------------------------------------------
// Lazy access to the code under test
// ---------------------------------------------------------------------------

interface Engine {
  scanFiles: typeof import('../../src/analyzing/scanners/index.ts').scanFiles;
  createInMemoryProject: typeof import('../../src/analyzing/scanners/index.ts').createInMemoryProject;
  rules: readonly AnalyzerRule[];
  domRuleIds: ReadonlySet<string>;
}

let enginePromise: Promise<Engine> | undefined;

function loadEngine(): Promise<Engine> {
  enginePromise ??= (async () => {
    const scanners = await import('../../src/analyzing/scanners/index.ts');
    const { QUALIFIED_RULES } = await import('../../src/analyzing/rules/index.ts');
    return {
      scanFiles: scanners.scanFiles,
      createInMemoryProject: scanners.createInMemoryProject,
      rules: QUALIFIED_RULES,
      domRuleIds: new Set(QUALIFIED_RULES.filter((r) => r.matcher.kind === 'dom').map((r) => r.id)),
    };
  })();
  return enginePromise;
}

async function scan(files: Record<string, string>): Promise<AnalyzerFinding[]> {
  const { scanFiles, rules } = await loadEngine();
  return scanFiles(new Map(Object.entries(files)), rules);
}

const key = (f: AnalyzerFinding): string => `${f.file}|${f.ruleId}@${f.line}`;

/** F1 between two multisets of keys (order-insensitive, duplicates count). */
function multisetF1(actual: readonly string[], expected: readonly string[]): number {
  const remaining = new Map<string, number>();
  for (const k of expected) remaining.set(k, (remaining.get(k) ?? 0) + 1);
  let tp = 0;
  for (const k of actual) {
    const n = remaining.get(k) ?? 0;
    if (n > 0) {
      tp++;
      remaining.set(k, n - 1);
    }
  }
  return f1(tp, actual.length - tp, expected.length - tp);
}

/** Expected keys for `file` from `ruleId@line` goldens. */
const expectKeys = (file: string, goldens: readonly string[]): string[] =>
  goldens.map((g) => `${file}|${g}`);

/** Content-level equality of two findings, ignoring file path and card id. */
function sameFindingContent(a: AnalyzerFinding, b: AnalyzerFinding): boolean {
  return (
    a.ruleId === b.ruleId &&
    a.line === b.line &&
    a.message === b.message &&
    a.lineContent === b.lineContent &&
    a.codeSnippet === b.codeSnippet
  );
}

// ---------------------------------------------------------------------------
// Fixtures (goldens verified against the unmodified scanner's .jsx/.tsx output)
// ---------------------------------------------------------------------------

const LOGIN_ESM = `import React from 'react';

export default function Login({ onSubmit }) {
  return (
    <form action="/login" method="post" onSubmit={onSubmit}>
      <label htmlFor="email">Email</label>
      <input id="email" type="email" name="email" />
      <label htmlFor="password">Password</label>
      <input id="password" type="password" name="password" />
      <button type="submit">Sign in</button>
    </form>
  );
}
`;
const LOGIN_ESM_GOLDEN = ['autofill-sign-in-form@9'];

const LOGIN_CJS = `'use strict';
const React = require('react');

function LoginForm(props) {
  return (
    <form action="/session" method="post" onSubmit={props.onSubmit}>
      <input type="text" name="username" />
      <input type="password" name="password" />
      <button type="submit">Log in</button>
    </form>
  );
}

module.exports = LoginForm;
`;
const LOGIN_CJS_GOLDEN = ['autofill-sign-in-form@8'];

const VENDOR_PAGE = `import React from 'react';

export default function Page() {
  return (
    <div>
      <script src="https://code.jquery.com/jquery-1.11.0.min.js" />
      <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/3.3.7/css/bootstrap.min.css" />
      <p>Hello</p>
    </div>
  );
}
`;
// secure-external-subresources reports at most one finding per file (the first offending element).
const VENDOR_PAGE_GOLDEN = ['secure-external-subresources@6'];

const CHECKOUT = `import React from 'react';

export function Checkout() {
  return (
    <div>
      <script src="https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js"></script>
      <form onSubmit={handleSubmit}>
        <input type="text" name="zipcode" id="zipcode" />
        <input type="text" name="cardholder_name" id="cardholder_name" />
        <input type="password" id="signup-pwd" name="newPassword" />
        <input type="checkbox" role="switch" />
      </form>
    </div>
  );
}
`;
const CHECKOUT_GOLDEN = [
  'secure-external-subresources@6',
  'autofill-address-form@8',
  'autofill-payment-form@9',
  'autofill-sign-up-form@10',
  'switch@11',
];

const FLOW_LOGIN = `// @flow
import * as React from 'react';

type Props = {| onSubmit: (password: string) => void |};

export default function FlowLogin(props: Props): React.Node {
  const [value, setValue] = React.useState<string>('');
  return (
    <form onSubmit={() => props.onSubmit(value)}>
      <input type="password" name="password" onChange={(e) => setValue(e.target.value)} />
    </form>
  );
}
`;
const FLOW_LOGIN_GOLDEN = ['autofill-sign-in-form@10'];

const COMPARE = `import React from 'react';

export function Gate({ a, b, c, d, items }) {
  if (a < b && c > d) {
    return (
      <form action="/login" method="post">
        <input type="password" name="password" />
      </form>
    );
  }
  const many = items.length > 1 && items.length < 10;
  return many ? (
    <>
      <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>
      <form action="/shipping">
        <input type="text" name="postal_code" id="postal_code" />
      </form>
    </>
  ) : null;
}
`;
const COMPARE_GOLDEN = ['autofill-sign-in-form@7', 'autofill-address-form@16'];

/** Mostly negative JSX: valid autocomplete, SRI, spread, member tags. One positive. */
const PROFILE = `import React from 'react';

export const Profile = (props) => (
  <section>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js" integrity="sha384-abc" crossOrigin="anonymous"></script>
    <input type="password" name="current" autoComplete="current-password" />
    <input type="text" name="address-line1" autoComplete="address-line1" />
    <input {...props.fieldProps} type="password" />
    <Form.Input type="password" name="other" />
    <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/3.3.7/css/bootstrap.min.css" />
    <div role="progressbar" aria-valuenow={props.pct} />
  </section>
);
`;
const PROFILE_GOLDEN = ['secure-external-subresources@10'];

/** JSX plus JS-rule triggers in the same file. */
const MIXED = `import React, { useEffect } from 'react';
import $ from 'jquery';

export default function Comments({ onSend }) {
  useEffect(() => {
    $('.comment-box').autosize();
    const box = document.querySelector('#comment');
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        onSend(box.value);
      }
    });
  }, [onSend]);
  return (
    <form action="/login" method="post">
      <input type="text" name="username" />
      <input type="password" name="password" />
      <textarea id="comment" className="comment-box" />
    </form>
  );
}
`;
const MIXED_JS_GOLDEN = ['form-fields-automatically-fit-contents@6', 'ime-safe-enter-submit@9'];
const MIXED_DOM_GOLDEN = ['autofill-sign-in-form@17'];

/** Plain JS (no JSX) with JS-rule triggers and HTML that only lives in strings/templates/comments. */
const PLAIN_JS = `import $ from 'jquery';
import DOMPurify from 'dompurify';
import { html } from 'lit';

$('.settings').autosize();

export function render(el, markup) {
  el.innerHTML = DOMPurify.sanitize(markup);
}

document.querySelector('#msg').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    submit();
  }
});

$('h1').fitText(1.2);
balanceText('.headline');

// <form action="/login"><input type="password" name="password"></form>
const legacy = '<form action="/login"><input type="password" name="password"></form>';
const tpl = html\`<form action="/login"><input type="password" name="password"></form>\`;
const vendor = \`<script src="https://code.jquery.com/jquery-1.11.0.min.js"></script>\`;
const s = document.createElement('script');
s.src = 'https://code.jquery.com/jquery-1.11.0.min.js';
export { legacy, tpl, vendor };
`;
const PLAIN_JS_GOLDEN = [
  'form-fields-automatically-fit-contents@5',
  'sanitize-untrusted-html/js-dompurify-innerhtml@8',
  'ime-safe-enter-submit@12',
  'equal-width-text-lines/js-fittext@17',
  'improve-text-layout-and-legibility/js-text-balance@18',
];

/** Flow-typed / comparison-heavy JS without JSX. */
const HOSTILE_JS = `// @flow
import $ from 'jquery';

type Props = { password: string, card: number, address: string };

function clamp(a: number, b: number, c: number): number {
  if (a < b && b > c) return b;
  return a<b ? a : c>b ? c : b;
}

function first<T>(xs: Array<T>): ?T {
  return xs.length > 0 ? xs[0] : null;
}

const cast = ((value: any): string);
const chain = 1 < 2 > 0;
const stripTags = (s) => s.replace(/<\\/?[a-z][^>]*>/gi, '');
const closing = '</div><input type="password" name="password"/>';
for (let i = 0; i<10; i++) { if (i <clamp(1, 2, 3)) break; }

$('.settings').autosize();
balanceText('.headline');
// <input type="password" name="pw">
`;
const HOSTILE_JS_GOLDEN = [
  'form-fields-automatically-fit-contents@21',
  'improve-text-layout-and-legibility/js-text-balance@22',
];

/** TS with angle-bracket type assertions. */
const TS_CASTS = `import $ from 'jquery';

const input = <HTMLInputElement>document.querySelector('input[type="password"]');
const anyVal = <any>window;
const card = <any>(document.getElementById('card'));
function cmp(a: number, b: number) { return a < b && b > a; }
const generic = <T,>(x: T): T => x;

$('.settings').autosize();
balanceText('.headline');
`;
const TS_CASTS_GOLDEN = [
  'form-fields-automatically-fit-contents@9',
  'improve-text-layout-and-legibility/js-text-balance@10',
];

/** JSX-looking text inside a .ts file must never produce element findings. */
const TS_JSX_LOOKING = `export function view(): unknown {
  return (
    <form action="/login" method="post">
      <input type="password" name="password" />
      <script src="https://code.jquery.com/jquery-1.11.0.min.js" />
    </form>
  );
}
`;

// ---------------------------------------------------------------------------
// Helpers for the per-extension login cases
// ---------------------------------------------------------------------------

/**
 * Credit for "file `path` yields exactly `golden` element findings, with the
 * same content as the `.jsx` twin".
 *  - 0.6: multiset F1 of (rule, line) keys vs golden (penalises extras)
 *  - 0.4: every expected finding has content parity with the `.jsx` twin
 *         (message, lineContent, codeSnippet) and the right `file`.
 */
async function parityCredit(path: string, source: string, golden: readonly string[]): Promise<number> {
  const twin = path.replace(/\.[cm]?js$/, '.jsx');
  const actual = await scan({ [path]: source });
  const reference = await scan({ [twin]: source });
  const keyCredit = multisetF1(actual.map(key), expectKeys(path, golden));
  const contentHits = reference.filter((ref) =>
    actual.some((f) => f.file === path && sameFindingContent(f, ref)),
  ).length;
  const contentCredit = reference.length > 0 ? contentHits / reference.length : 0;
  return 0.6 * keyCredit + 0.4 * contentCredit;
}

// ---------------------------------------------------------------------------
// Perf workloads (JSX-free, prettier-style formatting)
// ---------------------------------------------------------------------------

/** Plain ESM module that today matches DOM fastTokens only (never parsed). */
function unparsedModule(i: number): string {
  return `import { hash${i} } from './crypto.js';

const MIN_LENGTH_${i} = 8;
const settings${i} = { address: 'billing', zip: 'required', card: 'optional' };

export function validatePassword${i}(password, confirmation) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH_${i}) {
    return { ok: false, reason: 'too-short' };
  }
  let classes = 0;
  if (/[a-z]/.test(password)) classes += 1;
  if (/[A-Z]/.test(password)) classes += 1;
  if (/[0-9]/.test(password)) classes += 1;
  for (let k = 0; k < password.length; k += 1) {
    if (password.charCodeAt(k) < 32 || password.charCodeAt(k) > 126) {
      return { ok: false, reason: 'invalid-char' };
    }
  }
  return { ok: classes > 1 && password === confirmation, reason: null };
}

export async function storeCredentials${i}(store, user, password) {
  const digest = await hash${i}(password);
  const record = { ...user, digest, updatedAt: Date.now() };
  await store.put(user.id, record);
  return settings${i}.address ? record : null;
}

export default { validatePassword${i}, storeCredentials${i} };
`;
}

/** Same module plus an IME-safe keydown/Enter handler: JS-rule fastTokens match (parsed today), no finding. */
function parsedModule(i: number): string {
  return `${unparsedModule(i)}
const field${i} = document.querySelector('#search-${i}');
field${i}.addEventListener('keydown', (event) => {
  if (event.isComposing) {
    return;
  }
  if (event.key === 'Enter') {
    field${i}.form.requestSubmit();
  }
});
`;
}

/** Min wall time (ms) of `runs` alternating scans of `files` with all rules vs. no dom rules. */
async function timeAllVsNoDom(
  files: ReadonlyMap<string, string>,
  runs: number,
): Promise<{ all: number; noDom: number; allFindings: number }> {
  const { scanFiles, createInMemoryProject, rules } = await loadEngine();
  const noDomRules = rules.filter((r) => r.matcher.kind !== 'dom');
  const project = createInMemoryProject();
  const timeOnce = (rs: readonly AnalyzerRule[]): [number, number] => {
    const start = performance.now();
    const found = scanFiles(files, rs, { project }).length;
    return [performance.now() - start, found];
  };
  // Warm-up (JIT, module init, linkedom).
  timeOnce(rules);
  timeOnce(noDomRules);
  let all = Infinity;
  let noDom = Infinity;
  let allFindings = 0;
  for (let r = 0; r < runs; r++) {
    const [ta, fa] = timeOnce(rules);
    const [tn] = timeOnce(noDomRules);
    all = Math.min(all, ta);
    noDom = Math.min(noDom, tn);
    allFindings = fa;
  }
  return { all, noDom, allFindings };
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

export default defineScorecard({
  feature: 'jsx-in-js',
  title: 'legacy-scan applies element rules to JSX in .js/.mjs/.cjs',
  cases: [
    // ----------------------------- feature -----------------------------
    {
      id: 'js-login-sign-in-form',
      description:
        'src/Login.js with a JSX login form yields autofill-sign-in-form at the same line/content as Login.jsx',
      weight: 12,
      run: () => parityCredit('src/Login.js', LOGIN_ESM, LOGIN_ESM_GOLDEN),
    },
    {
      id: 'mjs-login-sign-in-form',
      description: 'same login form JSX in src/Login.mjs yields the .jsx-identical finding',
      weight: 8,
      run: () => parityCredit('src/Login.mjs', LOGIN_ESM, LOGIN_ESM_GOLDEN),
    },
    {
      id: 'cjs-login-sign-in-form',
      description: 'CommonJS (require/module.exports) login component in src/LoginForm.cjs yields the .jsx-identical finding',
      weight: 8,
      run: () => parityCredit('src/LoginForm.cjs', LOGIN_CJS, LOGIN_CJS_GOLDEN),
    },
    {
      id: 'js-secure-external-subresources',
      description:
        'a second element rule: unversioned-SRI CDN <script src> in .js JSX yields secure-external-subresources like .jsx',
      weight: 8,
      run: () => parityCredit('src/Page.js', VENDOR_PAGE, VENDOR_PAGE_GOLDEN),
    },
    {
      id: 'js-jsx-corpus-parity',
      description:
        'multi-rule corpus in .js/.mjs (address, payment, sign-up, switch, SRI, Flow-typed component, fragments + comparisons, negatives) matches .jsx goldens (F1)',
      weight: 12,
      run: async () => {
        const files: Record<string, string> = {
          'src/checkout/Checkout.js': CHECKOUT,
          'src/auth/FlowLogin.js': FLOW_LOGIN,
          'src/gate/Gate.mjs': COMPARE,
          'src/account/Profile.js': PROFILE,
        };
        const expected = [
          ...expectKeys('src/checkout/Checkout.js', CHECKOUT_GOLDEN),
          ...expectKeys('src/auth/FlowLogin.js', FLOW_LOGIN_GOLDEN),
          ...expectKeys('src/gate/Gate.mjs', COMPARE_GOLDEN),
          ...expectKeys('src/account/Profile.js', PROFILE_GOLDEN),
        ];
        const actual = await scan(files);
        return multisetF1(actual.map(key), expected);
      },
    },
    {
      id: 'js-mixed-jsx-and-js-rules',
      description:
        'a .js file with both JSX and JS-rule triggers yields the element finding AND keeps every JS-rule finding (product of the two)',
      weight: 8,
      run: async () => {
        const path = 'src/Comments.js';
        const { domRuleIds } = await loadEngine();
        const actual = await scan({ [path]: MIXED });
        const dom = actual.filter((f) => domRuleIds.has(f.ruleId)).map(key);
        const js = actual.filter((f) => !domRuleIds.has(f.ruleId)).map(key);
        const domCredit = multisetF1(dom, expectKeys(path, MIXED_DOM_GOLDEN));
        const jsCredit = multisetF1(js, expectKeys(path, MIXED_JS_GOLDEN));
        return domCredit * jsCredit;
      },
    },
    {
      id: 'cli-end-to-end',
      description:
        'runAnalyzeCli --json on a temp project (Login.js, Vendor.mjs, LoginForm.cjs, plain.js, typed.ts) reports the .js/.mjs/.cjs element findings; JS findings intact',
      weight: 10,
      run: async () => {
        const { runAnalyzeCli } = await import('../../src/analyzing/cli.ts');
        const dir = await mkdtemp(join(tmpdir(), 'mwg-jsx-in-js-'));
        try {
          const files: Record<string, string> = {
            'src/pages/Login.js': LOGIN_ESM,
            'src/components/Vendor.mjs': VENDOR_PAGE,
            'src/server/LoginForm.cjs': LOGIN_CJS,
            'src/lib/plain.js': PLAIN_JS,
            'src/lib/typed.ts': TS_CASTS,
          };
          for (const [rel, content] of Object.entries(files)) {
            const full = join(dir, rel);
            await mkdir(dirname(full), { recursive: true });
            await writeFile(full, content);
          }
          const res = await runAnalyzeCli([dir, '--json']);
          if (res.exitCode !== 0) return 0;
          const out = JSON.parse(res.output) as AnalyzeJsonOutput;
          const found: string[] = [];
          for (const guide of out.guides) {
            for (const rule of guide.rules) {
              for (const finding of rule.findings) {
                found.push(`${finding.file}|${rule.ruleId}@${finding.line}`);
              }
            }
          }
          const expectedDom = [
            ...expectKeys('src/pages/Login.js', LOGIN_ESM_GOLDEN),
            ...expectKeys('src/components/Vendor.mjs', VENDOR_PAGE_GOLDEN),
            ...expectKeys('src/server/LoginForm.cjs', LOGIN_CJS_GOLDEN),
          ];
          const expectedJs = [
            ...expectKeys('src/lib/plain.js', PLAIN_JS_GOLDEN),
            ...expectKeys('src/lib/typed.ts', TS_CASTS_GOLDEN),
          ];
          const jsSet = new Set(expectedJs);
          const domFound = found.filter((k) => !jsSet.has(k));
          const jsIntact = expectedJs.every((k) => found.includes(k));
          return multisetF1(domFound, expectedDom) * (jsIntact ? 1 : 0.5);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
    },

    // ------------------------- regression guards -------------------------
    {
      id: 'guard-plain-js-unchanged',
      description:
        'plain (JSX-free) .js/.mjs/.cjs with JS triggers and HTML only in strings/templates/comments: identical findings to the unmodified scanner, content-equal to the .ts twin',
      weight: 6,
      run: async () => {
        const results: number[] = [];
        for (const path of ['src/plain.js', 'src/plain.mjs', 'src/plain.cjs']) {
          const actual = await scan({ [path]: PLAIN_JS });
          const twin = await scan({ 'src/plain.ts': PLAIN_JS });
          const keyCredit = multisetF1(actual.map(key), expectKeys(path, PLAIN_JS_GOLDEN));
          const contentEqual =
            actual.length === twin.length &&
            twin.every((t) => actual.some((f) => sameFindingContent(f, t)));
          results.push(keyCredit * (contentEqual ? 1 : 0.5));
        }
        return mean(results);
      },
    },
    {
      id: 'guard-ts-family-excluded',
      description:
        '.ts/.mts/.cts with <any>x casts: no crash, JS findings unchanged; JSX-looking text in .ts/.mts/.cts yields no element findings',
      weight: 5,
      run: async () => {
        const { domRuleIds } = await loadEngine();
        const results: number[] = [];
        for (const ext of ['ts', 'mts', 'cts']) {
          const castPath = `src/casts.${ext}`;
          const casts = await scan({ [castPath]: TS_CASTS });
          results.push(multisetF1(casts.map(key), expectKeys(castPath, TS_CASTS_GOLDEN)));
          const looking = await scan({ [`src/view.${ext}`]: TS_JSX_LOOKING });
          results.push(looking.some((f) => domRuleIds.has(f.ruleId)) ? 0 : 1);
        }
        return mean(results);
      },
    },
    {
      id: 'guard-parser-hostile-js',
      description:
        'Flow-typed, comparison-chain, regex/closing-tag-string JS (no JSX) in .js/.mjs/.cjs: no crash, JS findings identical, no element findings, scan of sibling files continues',
      weight: 5,
      run: async () => {
        const results: number[] = [];
        for (const ext of ['js', 'mjs', 'cjs']) {
          const path = `src/hostile.${ext}`;
          const sentinel = `src/sentinel-${ext}.js`;
          const actual = await scan({ [path]: HOSTILE_JS, [sentinel]: "$('.box').autosize();\n" });
          const expected = [
            ...expectKeys(path, HOSTILE_JS_GOLDEN),
            `${sentinel}|form-fields-automatically-fit-contents@1`,
          ];
          results.push(multisetF1(actual.map(key), expected));
        }
        return mean(results);
      },
    },
    {
      id: 'guard-jsx-tsx-unchanged',
      description: 'existing .jsx/.tsx element + JS findings are unchanged (goldens)',
      weight: 4,
      run: async () => {
        const files: Record<string, string> = {
          'src/Login.jsx': LOGIN_ESM,
          'src/Login.tsx': LOGIN_ESM,
          'src/Checkout.jsx': CHECKOUT,
          'src/Gate.tsx': COMPARE,
          'src/Profile.jsx': PROFILE,
          'src/FlowLogin.jsx': FLOW_LOGIN,
          'src/Comments.jsx': MIXED,
          'src/Page.tsx': VENDOR_PAGE,
          'src/LoginForm.jsx': LOGIN_CJS,
        };
        const expected = [
          ...expectKeys('src/Login.jsx', LOGIN_ESM_GOLDEN),
          ...expectKeys('src/Login.tsx', LOGIN_ESM_GOLDEN),
          ...expectKeys('src/Checkout.jsx', CHECKOUT_GOLDEN),
          ...expectKeys('src/Gate.tsx', COMPARE_GOLDEN),
          ...expectKeys('src/Profile.jsx', PROFILE_GOLDEN),
          ...expectKeys('src/FlowLogin.jsx', FLOW_LOGIN_GOLDEN),
          ...expectKeys('src/Comments.jsx', [...MIXED_JS_GOLDEN, ...MIXED_DOM_GOLDEN]),
          ...expectKeys('src/Page.tsx', VENDOR_PAGE_GOLDEN),
          ...expectKeys('src/LoginForm.jsx', LOGIN_CJS_GOLDEN),
        ];
        const actual = await scan(files);
        return multisetF1(actual.map(key), expected);
      },
    },
    {
      id: 'guard-perf-unparsed-plain-js',
      description:
        '200 JSX-free .js modules that match only DOM fastTokens (never parsed today): extra cost vs. the no-dom-rules control must stay ≈ 0 (full ≤ 0.15 ms/file, zero ≥ 0.6 ms/file)',
      weight: 6,
      timeoutMs: 60_000,
      run: async () => {
        const n = 200;
        const files = new Map(
          Array.from({ length: n }, (_, i) => [`src/lib/u${i}.js`, unparsedModule(i)] as const),
        );
        const { all, noDom, allFindings } = await timeAllVsNoDom(files, 5);
        if (allFindings !== 0) return 0;
        const extraMsPerFile = Math.max(0, all - noDom) / n;
        return lowerIsBetter(extraMsPerFile, 0.15, 0.6);
      },
    },
    {
      id: 'guard-perf-parsed-plain-js',
      description:
        '120 JSX-free .js modules that are parsed anyway (JS-rule fastToken present): time ratio vs. no-dom-rules control (full ≤ 1.25×, zero ≥ 1.9×)',
      weight: 3,
      timeoutMs: 60_000,
      run: async () => {
        const n = 120;
        const files = new Map(
          Array.from({ length: n }, (_, i) => [`src/lib/p${i}.js`, parsedModule(i)] as const),
        );
        const { all, noDom, allFindings } = await timeAllVsNoDom(files, 5);
        if (allFindings !== 0) return 0;
        return lowerIsBetter(all / Math.max(noDom, 1), 1.25, 1.9);
      },
    },
  ],
});
