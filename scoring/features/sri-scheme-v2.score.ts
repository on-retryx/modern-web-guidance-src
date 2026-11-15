/**
 * Scorecard v2 (stricter): secure-external-subresources across URL schemes.
 *
 * Supersedes the locked v1 `sri-scheme` scorecard (kept as is). Everything is measured through
 * public surfaces only: `scanFiles` with the rule taken from the qualified-rule registry by its
 * id, the rule object's public fields (`matcher.fastTokens`, `verifierRubric`), the analyzer CLI
 * (`node src/analyzing/cli.ts <dir> [--json] [--guide ...]`: exit code, stdout, JSON shape), and
 * the guide's own HTML snippets / demo page. Code under test is imported lazily inside cases.
 *
 * Contract
 * 1. Missing integrity. A <script src> (.js/.mjs) or <link rel="stylesheet" href> (.css) that
 *    loads an exact-version asset from one of the seven known public CDNs
 *    (cdnjs.cloudflare.com, cdn.jsdelivr.net, unpkg.com, code.jquery.com,
 *    maxcdn.bootstrapcdn.com, stackpath.bootstrapcdn.com, ajax.googleapis.com) without
 *    `integrity` is flagged when the URL is `https://host/…`, `http://host/…` or
 *    protocol-relative `//host/…`. The scheme is case-insensitive; surrounding whitespace in the
 *    attribute value and the quoting style do not matter. Works in .html, .php and JSX/TSX.
 * 2. Integrity without crossorigin. An element with a valid `integrity="sha256|384|512-…"` and no
 *    `crossorigin`/`crossOrigin` on a cross-origin URL is flagged on ANY host. DECISION (round 2):
 *    this check does not depend on the scheme, so `http://` behaves exactly like `https://` and
 *    `//`. Same-origin URLs (relative paths, `data:`) are not flagged.
 * 3. Scheme parity: for every attribute combination, `http://` and `//` produce the same verdict
 *    as `https://` on the same host and path.
 * 4. Negatives (never flagged as a CDN load): look-alike hosts (suffix/prefix spoofs, CDN host only
 *    in the path or in userinfo, e.g. `https://code.jquery.com@evil.example/…`), non-http(s)
 *    schemes (`ftp:`, `javascript:`, `data:`, `httpss:`, `xhttp:`), relative paths that merely
 *    contain `//` or the host name, and scheme-without-authority forms (`https:host/…`,
 *    `http:/host/…`). Conservative DECISION for malformed authorities: `///host/…`,
 *    backslash-prefixed `\\host/…`, an explicit non-default port, and embedded credentials are
 *    not flagged (they are not valid URL strings per HTML, or browsers refuse/never serve them).
 * 5. Existing behaviour holds: one finding per file located at the FIRST offending element,
 *    exemptions (integrity+crossorigin incl. bare and use-credentials, floating/unversioned/
 *    query/combine URLs, other hosts, non-stylesheet links, wrong extension, importance attr),
 *    https behaviour unchanged, zero findings on the guide's snippets and demo page.
 * 6. The fastTokens pre-filter admits every positive above on its own (no other token present)
 *    and still rejects ordinary pages that reference no known CDN and no integrity.
 * 7. The verifier rubric does not describe any keep criterion as https-only.
 *
 * Out of scope (pre-existing limitation, not scored): uppercase host names.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AnalyzerRule } from '../../src/analyzing/schema.ts';
import { defineScorecard, f1, mean, ratio } from '../lib.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const RULE_ID = 'secure-external-subresources';
const SRI = 'sha384-oqVuAfXRKap7fdgcCY5uykM6+R9GqQ8K/uxy9rx7HNQlGYl1kPzQho1wx4JwY8wC';
const SRI_256 = 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';
const SRI_512 =
  'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==';

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

interface Scanner {
  readonly rule: AnalyzerRule;
  scan(markup: string, ext?: string): Finding[];
  scanMany(files: ReadonlyMap<string, string>): Finding[];
}

let scannerPromise: Promise<Scanner> | undefined;
let fileCounter = 0;

/** Lazily loads scanFiles and the rule (looked up by id in the public qualified-rule registry). */
function loadScanner(): Promise<Scanner> {
  scannerPromise ??= (async () => {
    const { scanFiles } = await import('../../src/analyzing/scanners/index.ts');
    const { QUALIFIED_RULES } = await import('../../src/analyzing/rules/index.ts');
    const rule = QUALIFIED_RULES.find((r) => r.id === RULE_ID);
    if (!rule) throw new Error(`rule ${RULE_ID} is not registered`);
    return {
      rule,
      scan(markup: string, ext = 'html'): Finding[] {
        return this.scanMany(new Map([[`src/pages/page${fileCounter++}.${ext}`, markup]]));
      },
      scanMany(files: ReadonlyMap<string, string>): Finding[] {
        return scanFiles(files, [rule], { includeDocsAndTests: true });
      },
    };
  })();
  return scannerPromise;
}

interface Fixture {
  readonly markup: string;
  readonly ext: string;
  /** 1-based line of the first offending element, or 0 when nothing may be flagged. */
  readonly line: number;
}

const HEAD_PREFIX = ['<!doctype html>', '<html lang="en">', '<head>'];
const HEAD_SUFFIX = ['</head>', '<body></body>', '</html>', ''];

/** HTML page whose <head> contains `tags` starting at line 4; `offender` is an index into tags. */
function page(tags: readonly string[], offender: number | null): Fixture {
  const lines = [...HEAD_PREFIX];
  let line = 0;
  tags.forEach((tag, i) => {
    if (i === offender) line = lines.length + 1;
    lines.push(...tag.split('\n'));
  });
  return { markup: [...lines, ...HEAD_SUFFIX].join('\n'), ext: 'html', line };
}

const flagged = (tag: string): Fixture => page([tag], 0);
const clean = (tag: string): Fixture => page([tag], null);

function jsx(element: string, offending: boolean, ext = 'tsx'): Fixture {
  const markup = `export function Assets() {\n  return (\n    <>\n      ${element}\n    </>\n  );\n}\n`;
  return { markup, ext, line: offending ? 4 : 0 };
}

function php(tag: string, offending: boolean): Fixture {
  const markup = `<?php $title = 'Shop'; ?>\n<!doctype html>\n<html>\n<head>\n<title><?= $title ?></title>\n${tag}\n</head>\n<body></body>\n</html>\n`;
  return { markup, ext: 'php', line: offending ? 6 : 0 };
}

/** True when the fixture yields exactly the expected findings (one at `line`, or none). */
function verdict(s: Scanner, fx: Fixture): boolean {
  const found = s.scan(fx.markup, fx.ext);
  if (fx.line === 0) return found.length === 0;
  return found.length === 1 && found[0]?.line === fx.line;
}

function score(s: Scanner, fixtures: readonly Fixture[]): number {
  return ratio(fixtures.filter((fx) => verdict(s, fx)).length, fixtures.length);
}

const script = (url: string, attrs = '') => `<script src="${url}"${attrs ? ` ${attrs}` : ''}></script>`;
const sheet = (url: string, attrs = '') => `<link rel="stylesheet" href="${url}"${attrs ? ` ${attrs}` : ''}>`;

const CDNS = [
  { host: 'cdnjs.cloudflare.com', js: '/ajax/libs/lodash.js/4.17.21/lodash.min.js', css: '/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css' },
  { host: 'cdn.jsdelivr.net', js: '/npm/htmx.org@1.9.12/dist/htmx.min.js', css: '/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css' },
  { host: 'unpkg.com', js: '/react@18.3.1/umd/react.production.min.js', css: '/katex@0.16.9/dist/katex.min.css' },
  { host: 'code.jquery.com', js: '/jquery-3.7.1.min.js', css: '/ui/1.13.2/themes/base/jquery-ui.css' },
  { host: 'maxcdn.bootstrapcdn.com', js: '/bootstrap/3.4.1/js/bootstrap.min.js', css: '/bootstrap/3.4.1/css/bootstrap.min.css' },
  { host: 'stackpath.bootstrapcdn.com', js: '/bootstrap/4.5.2/js/bootstrap.min.js', css: '/bootstrap/4.5.2/css/bootstrap.min.css' },
  { host: 'ajax.googleapis.com', js: '/ajax/libs/jquery/3.7.1/jquery.min.js', css: '/ajax/libs/jqueryui/1.13.2/themes/smoothness/jquery-ui.css' },
] as const;

const NEW_SCHEMES = ['//', 'http://'] as const;
const ALL_SCHEMES = ['https://', 'http://', '//'] as const;

/** Positive fixtures for the missing-integrity path on every CDN host, `//` and `http://`. */
function cdnSchemeFixtures(): Fixture[] {
  return NEW_SCHEMES.flatMap((scheme) =>
    CDNS.flatMap((c) => [flagged(script(`${scheme}${c.host}${c.js}`)), flagged(sheet(`${scheme}${c.host}${c.css}`))]),
  );
}

function schemeVariantFixtures(): Fixture[] {
  return [
    flagged(script('HTTP://code.jquery.com/jquery-3.7.1.min.js')),
    flagged(sheet('Http://unpkg.com/katex@0.16.9/dist/katex.min.css')),
    flagged(script('  //code.jquery.com/jquery-3.7.1.min.js  ')),
    flagged('<script src=//cdn.jsdelivr.net/npm/htmx.org@1.9.12/dist/htmx.min.js></script>'),
    flagged("<link rel='stylesheet' href='//maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css'>"),
    flagged('<link\n  rel="stylesheet"\n  href="http://stackpath.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css"\n>'),
    flagged(script('//ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js', 'crossorigin="anonymous"')),
    flagged(script('http://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.21/lodash.min.js', 'referrerpolicy="no-referrer"')),
    flagged('<script type="module" src="//cdn.jsdelivr.net/npm/lit@3.1.2/index.mjs"></script>'),
    flagged('<script defer src="http://unpkg.com/alpinejs@3.13.5/dist/cdn.min.js"></script>'),
  ];
}

function templateFixtures(): Fixture[] {
  return [
    jsx('<script src="//unpkg.com/react@18.3.1/umd/react.production.min.js" />', true),
    jsx('<link rel="stylesheet" href="http://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" />', true, 'jsx'),
    jsx('<script src="http://code.jquery.com/jquery-3.7.1.min.js" crossOrigin="anonymous" />', true),
    php(script('//ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js'), true),
    php(sheet('http://maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css'), true),
  ];
}

/** DECISION: http:// + valid integrity + no crossorigin is flagged like https://, on any host. */
function httpIntegrityFixtures(): Fixture[] {
  return [
    flagged(script('http://cdnjs.cloudflare.com/ajax/libs/lodash.js/4.17.21/lodash.min.js', `integrity="${SRI}"`)),
    flagged(sheet('http://maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css', `integrity="${SRI}"`)),
    flagged(script('http://code.jquery.com/jquery.min.js', `integrity="${SRI}"`)),
    flagged(script('http://static.example.com/app.3f2a9c.js', `integrity="${SRI_256}"`)),
    flagged(sheet('http://assets.example.org/site.css', `integrity="${SRI_512}" referrerpolicy="no-referrer"`)),
    flagged(script('HTTP://unpkg.com/react@18.3.1/umd/react.production.min.js', `integrity="${SRI}"`)),
    flagged(`<script\n  src="http://cdn.jsdelivr.net/npm/htmx.org@1.9.12/dist/htmx.min.js"\n  integrity="${SRI}"\n></script>`),
    jsx(`<script src="http://unpkg.com/react@18.3.1/umd/react.production.min.js" integrity="${SRI}" />`, true),
  ];
}

function protocolRelativeIntegrityFixtures(): Fixture[] {
  return [
    flagged(script('//unpkg.com/react@18.3.1/umd/react.production.min.js', `integrity="${SRI}"`)),
    flagged(sheet('//cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css', `integrity="${SRI}"`)),
    flagged(script('//static.example.com/app.3f2a9c.js', `integrity="${SRI_256}"`)),
    flagged(sheet('//cdn.example.com/ui@2.4.0/styles.css', `integrity="${SRI_512}"`)),
    jsx(`<link rel="stylesheet" href="//stackpath.bootstrapcdn.com/bootstrap/4.5.2/css/bootstrap.min.css" integrity="${SRI}" />`, true),
  ];
}

/** Hard negatives: the URL does not load from a known CDN host over http(s). */
function spoofAndSchemeNegatives(): Fixture[] {
  const js = '/jquery-3.7.1.min.js';
  return [
    clean(script(`https://code.jquery.com@evil.example${js}`)),
    clean(script(`//code.jquery.com@evil.example${js}`)),
    clean(script(`http://code.jquery.com:x@evil.example${js}`)),
    clean(script(`//code.jquery.com.evil.example${js}`)),
    clean(script(`http://code.jquery.com.evil.example${js}`)),
    clean(sheet('//cdnjs.cloudflare.com.evil.example/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css')),
    clean(script(`//notcode.jquery.com${js}`)),
    clean(script(`http://evil.example/code.jquery.com${js}`)),
    clean(script(`//evil.example//code.jquery.com${js}`)),
    clean(script(`ftp://code.jquery.com${js}`)),
    clean(script(`javascript://code.jquery.com${js}`)),
    clean(script(`httpss://code.jquery.com${js}`)),
    clean(script(`xhttp://code.jquery.com${js}`)),
    clean(script(`data:text/javascript,//code.jquery.com${js}`)),
    clean(script(`vendor//code.jquery.com${js}`)),
    clean(script(`/code.jquery.com${js}`)),
    clean(script(`./code.jquery.com${js}`)),
    clean(script(`https:code.jquery.com${js}`)),
    clean(script(`http:/code.jquery.com${js}`)),
    clean(script('/vendor/app.js', `integrity="${SRI}"`)),
    clean(script('vendor//static.example.com/app.js', `integrity="${SRI}"`)),
    clean(sheet('data:text/css,body{}', `integrity="${SRI}"`)),
  ];
}

/** Conservative decision: malformed authorities are not flagged. */
function malformedAuthorityNegatives(): Fixture[] {
  const js = '/jquery-3.7.1.min.js';
  return [
    clean(script(`///code.jquery.com${js}`)),
    clean(script(`http:///code.jquery.com${js}`)),
    clean(script(`\\\\code.jquery.com${js}`)),
    clean(script('\\\\code.jquery.com\\jquery-3.7.1.min.js')),
    clean(script(`//code.jquery.com:8080${js}`)),
    clean(script(`http://code.jquery.com:8443${js}`)),
    clean(script(`//user@code.jquery.com${js}`)),
    clean(script(`https://user:pass@code.jquery.com${js}`)),
  ];
}

/** Every positive fixture string used above (for the fast-token soundness check). */
function allPositiveFixtures(): Fixture[] {
  return [
    ...cdnSchemeFixtures(),
    ...schemeVariantFixtures(),
    ...templateFixtures(),
    ...httpIntegrityFixtures(),
    ...protocolRelativeIntegrityFixtures(),
  ];
}

interface CliRun {
  status: number | null;
  stdout: string;
}

function runCli(args: readonly string[]): CliRun {
  const res = spawnSync(process.execPath, ['src/analyzing/cli.ts', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  return { status: res.status, stdout: res.stdout ?? '' };
}

interface CliFinding {
  file: string;
  line: number;
  message: string;
  lineContent: string;
}

interface CliJson {
  totalFindings: number;
  guides: { guideId: string; rules: { ruleId: string; findings: CliFinding[] }[] }[];
}

function ruleFindings(json: CliJson): CliFinding[] {
  return json.guides
    .filter((g) => g.guideId === RULE_ID)
    .flatMap((g) => g.rules.filter((r) => r.ruleId === RULE_ID).flatMap((r) => r.findings));
}

/** F1 over expected (file, line) pairs; a finding at the wrong line counts as fp + fn. */
function locationF1(found: readonly CliFinding[], expected: ReadonlyMap<string, { line: number }>): number {
  let tp = 0;
  let fp = 0;
  for (const f of found) {
    if (expected.get(f.file)?.line === f.line) tp++;
    else fp++;
  }
  return f1(tp, fp, expected.size - tp);
}

/** Fenced ```html blocks of the guide that contain an external element with integrity. */
function guideHtmlSnippets(): string[] {
  const guide = fs.readFileSync(path.join(ROOT, 'guides/security', RULE_ID, 'guide.md'), 'utf8');
  return [...guide.matchAll(/```html\n([\s\S]*?)```/g)]
    .map((m) => m[1] ?? '')
    .filter((block) => /<(?:script|link)\b[\s\S]*?integrity=/.test(block) && /(?:src|href)="https:\/\//.test(block));
}

const stripAttr = (markup: string, attr: string) => markup.replace(new RegExp(`\\s+${attr}="[^"]*"`, 'g'), '');
const withScheme = (markup: string, scheme: string) => markup.replace(/((?:src|href)=")https:\/\//g, `$1${scheme}`);

export default defineScorecard({
  feature: 'sri-scheme-v2',
  title: 'SRI rule handles https, http and protocol-relative URLs consistently (strict v2)',
  cases: [
    {
      id: 'cdn-hosts-protocol-relative-and-http',
      description:
        'every known CDN host, <script> and <link rel=stylesheet>, `//` and `http://`, isolated file: exactly one finding at the tag line',
      weight: 6,
      run: async () => score(await loadScanner(), cdnSchemeFixtures()),
    },
    {
      id: 'scheme-case-quoting-and-markup-variants',
      description:
        'uppercase/mixed-case scheme, padded attribute value, unquoted/single-quoted attributes, multi-line tag, crossorigin or referrerpolicy without integrity, module/defer scripts',
      weight: 3,
      run: async () => score(await loadScanner(), schemeVariantFixtures()),
    },
    {
      id: 'jsx-and-php-templates',
      description: '`//` and `http://` CDN elements without integrity are flagged in TSX/JSX and PHP templates at the element line',
      weight: 3,
      run: async () => score(await loadScanner(), templateFixtures()),
    },
    {
      id: 'http-integrity-without-crossorigin',
      description:
        'DECISION: http:// + valid integrity (sha256/384/512) + no crossorigin is flagged like https, on CDN and non-CDN hosts, versioned or not, HTML and JSX',
      weight: 6,
      run: async () => score(await loadScanner(), httpIntegrityFixtures()),
    },
    {
      id: 'protocol-relative-integrity-without-crossorigin-hosts',
      description: '`//` + integrity without crossorigin is flagged on several CDN and non-CDN hosts, script and stylesheet, HTML and JSX',
      weight: 3,
      run: async () => score(await loadScanner(), protocolRelativeIntegrityFixtures()),
    },
    {
      id: 'integrity-crossorigin-scheme-parity',
      description:
        'for every integrity/crossorigin combination on CDN and non-CDN hosts, http:// and // give the same verdict as https:// (https baseline must also be right)',
      weight: 4,
      run: async () => {
        const s = await loadScanner();
        const targets = [
          { url: 'code.jquery.com/jquery-3.7.1.min.js', tag: script, cdn: true },
          { url: 'maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css', tag: sheet, cdn: true },
          { url: 'static.example.com/app.3f2a9c.js', tag: script, cdn: false },
          { url: 'assets.example.org/site.css', tag: sheet, cdn: false },
        ];
        const combos: { attrs: string; https: (cdn: boolean) => number | null }[] = [
          { attrs: `integrity="${SRI}"`, https: () => 1 },
          { attrs: `integrity="${SRI}" crossorigin="anonymous"`, https: () => 0 },
          { attrs: `integrity="${SRI}" crossorigin`, https: () => 0 },
          { attrs: `integrity="${SRI}" crossorigin="use-credentials"`, https: () => 0 },
          { attrs: `integrity="${SRI_512}"`, https: () => 1 },
          { attrs: `integrity="${SRI_256} ${SRI}"`, https: () => 1 },
          { attrs: 'crossorigin="anonymous"', https: (cdn) => (cdn ? 1 : 0) },
          { attrs: 'integrity="md5-notadigest"', https: () => null },
        ];
        const count = (markup: string, ext = 'html') => s.scan(markup, ext).length;
        const checks: boolean[] = [];
        for (const t of targets) {
          for (const c of combos) {
            const base = count(page([t.tag(`https://${t.url}`, c.attrs)], null).markup);
            const want = c.https(t.cdn);
            if (want !== null && base !== want) return 0;
            for (const scheme of NEW_SCHEMES) {
              checks.push(count(page([t.tag(`${scheme}${t.url}`, c.attrs)], null).markup) === base);
            }
          }
        }
        for (const co of ['', ' crossOrigin="anonymous"']) {
          const el = (scheme: string) =>
            jsx(`<script src="${scheme}unpkg.com/react@18.3.1/umd/react.production.min.js" integrity="${SRI}"${co} />`, false).markup;
          const base = count(el('https://'), 'tsx');
          if (base !== (co ? 0 : 1)) return 0;
          for (const scheme of NEW_SCHEMES) checks.push(count(el(scheme), 'tsx') === base);
        }
        return mean(checks);
      },
    },
    {
      id: 'negative-spoofed-hosts-and-non-http-schemes',
      description:
        'not flagged: look-alike hosts, CDN host in userinfo/path, ftp:/javascript:/data:/httpss:/xhttp:, relative paths containing // or the host, scheme without authority, same-origin integrity',
      weight: 5,
      run: async () => score(await loadScanner(), spoofAndSchemeNegatives()),
    },
    {
      id: 'negative-malformed-authority',
      description: 'conservative decision: ///host, \\\\host, explicit non-default port and embedded credentials are not flagged',
      weight: 2,
      run: async () => score(await loadScanner(), malformedAuthorityNegatives()),
    },
    {
      id: 'first-offender-line-and-dedup',
      description:
        'one finding per file located at the first offending element across mixed schemes; exempt elements before it do not swallow it; separate files are independent',
      weight: 3,
      run: async () => {
        const s = await loadScanner();
        const jq = 'code.jquery.com/jquery-3.7.1.min.js';
        const fixtures = [
          page([script(`//${jq}`, `integrity="${SRI}" crossorigin="anonymous"`), script(`http://${jq}`), script(`https://${jq}`)], 1),
          page([script(`https://${jq}`, `integrity="${SRI}" crossorigin="anonymous"`), script(`//static.example.com/app.js`, `integrity="${SRI}"`)], 1),
          page([script('//cdn.jsdelivr.net/npm/vue@latest/dist/vue.global.js'), script('http://static.example.com/app.js', `integrity="${SRI}"`)], 1),
          page([script('http://static.example.com/app.js', `integrity="${SRI}"`), script(`//${jq}`)], 0),
          page([sheet('//cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css'), script(`http://${jq}`), sheet('https://unpkg.com/katex@0.16.9/dist/katex.min.css')], 0),
        ];
        const checks: boolean[] = fixtures.map((fx) => verdict(s, fx));
        const files = new Map([
          ['src/a.html', page([script(`//${jq}`)], 0).markup],
          ['src/b.html', page([sheet('http://maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css')], 0).markup],
          ['src/c.html', page([script('http://static.example.com/app.js', `integrity="${SRI}"`)], 0).markup],
        ]);
        const found = s.scanMany(files);
        checks.push(found.length === 3 && new Set(found.map((f) => f.file)).size === 3);
        return mean(checks);
      },
    },
    {
      id: 'fast-token-prefilter',
      description:
        "the rule's public fastTokens (scanner semantics) admit every positive fixture on its own, and reject ordinary pages with no known CDN host and no integrity",
      weight: 3,
      run: async () => {
        const s = await loadScanner();
        const { matchesFastTokens } = await import('../../src/analyzing/scanners/js-scanner.ts');
        const tokens = s.rule.matcher.fastTokens;
        const positives = allPositiveFixtures();
        const sound = ratio(positives.filter((fx) => matchesFastTokens(fx.markup, tokens)).length, positives.length);
        const unrelated = [
          page(['<script src="/assets/app.js"></script>', '<link rel="stylesheet" href="/assets/site.css">'], null).markup,
          page(['<link rel="stylesheet" href="//fonts.googleapis.com/css?family=Inter">', '<link rel="preconnect" href="https://fonts.gstatic.com">'], null).markup,
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><a href="https://example.com/docs">docs</a></svg>\n',
          "// fetch helper\nexport async function load() {\n  return fetch('https://api.example.com/v1/items');\n}\n",
          page(['<img src="//images.example.com/hero.png" alt="">', '<script src="http://localhost:3000/dev.js"></script>'], null).markup,
        ];
        const selective = ratio(unrelated.filter((m) => !matchesFastTokens(m, tokens)).length, unrelated.length);
        return mean([sound, selective]);
      },
    },
    {
      id: 'cli-end-to-end',
      description:
        'analyzer CLI on a temp project: exit 0, --json lists exactly the expected (file, line) findings incl. the http+integrity decision, finding text names the URL, human output lists file:line, default qualified mode agrees',
      weight: 4,
      timeoutMs: 90_000,
      run: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sri-scheme-v2-'));
        try {
          const write = (rel: string, content: string) => {
            fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
            fs.writeFileSync(path.join(dir, rel), content);
          };
          const jq = '//code.jquery.com/jquery-3.7.1.min.js';
          const files: { rel: string; fx: Fixture; url?: string }[] = [
            { rel: 'web/index.html', fx: page([script(`https://${jq.slice(2)}`, `integrity="${SRI}" crossorigin="anonymous"`), script(jq)], 1), url: jq },
            { rel: 'web/legacy.html', fx: flagged(sheet('http://maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css')), url: 'http://maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css' },
            { rel: 'web/checkout.html', fx: flagged(script('http://static.example.com/pay.4c1d.js', `integrity="${SRI}"`)), url: 'http://static.example.com/pay.4c1d.js' },
            { rel: 'web/src/App.jsx', fx: jsx('<script src="//unpkg.com/react@18.3.1/umd/react.production.min.js" />', true, 'jsx'), url: '//unpkg.com/react@18.3.1/umd/react.production.min.js' },
            { rel: 'web/shop.php', fx: php(script('//ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js'), true), url: '//ajax.googleapis.com/ajax/libs/jquery/3.7.1/jquery.min.js' },
            {
              rel: 'web/secure.html',
              fx: page(
                [
                  script(jq, `integrity="${SRI}" crossorigin="anonymous"`),
                  sheet('http://unpkg.com/katex@0.16.9/dist/katex.min.css', `integrity="${SRI}" crossorigin`),
                  script('//cdn.jsdelivr.net/npm/vue@latest/dist/vue.global.js'),
                ],
                null,
              ),
            },
            {
              rel: 'web/odd.html',
              fx: page([script('https://code.jquery.com@evil.example/jquery-3.7.1.min.js'), script('///code.jquery.com/jquery-3.7.1.min.js'), script('vendor//code.jquery.com/jquery-3.7.1.min.js')], null),
            },
          ];
          for (const f of files) write(f.rel, f.fx.markup);
          const expected = new Map(
            files.filter((f) => f.fx.line > 0).map((f) => [f.rel, { line: f.fx.line, url: f.url ?? '' }]),
          );

          const json = runCli([dir, '--json', '--guide', RULE_ID]);
          let data: CliJson | undefined;
          try {
            data = JSON.parse(json.stdout) as CliJson;
          } catch {
            data = undefined;
          }
          if (json.status !== 0 || !data) return 0;
          const found = ruleFindings(data);
          const textOk = [...expected].map(([file, e]) => {
            const f = found.find((x) => x.file === file && x.line === e.line);
            return Boolean(f && f.lineContent.includes(e.url) && f.message.includes(e.url));
          });

          const human = runCli([dir, '--guide', RULE_ID]);
          const humanOk = [...expected].map(([file, e]) => human.status === 0 && human.stdout.includes(`${file}:${e.line}`));

          const all = runCli([dir, '--json']);
          let allF1 = 0;
          try {
            if (all.status === 0) allF1 = locationF1(ruleFindings(JSON.parse(all.stdout) as CliJson), expected);
          } catch {
            allF1 = 0;
          }

          return mean([
            locationF1(found, expected),
            data.totalFindings === expected.size,
            mean(textOk),
            mean(humanOk),
            allF1,
          ]);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
    },
    {
      id: 'rubric-scheme-neutral',
      description:
        'no verifierRubric keepWhen criterion is https-only (each one naming https:// also covers http:// and protocol-relative //, or names no scheme)',
      weight: 1,
      run: async () => {
        const keep = (await loadScanner()).rule.verifierRubric?.keepWhen ?? [];
        if (keep.length === 0) return 0;
        const protocolRelative = /(?:^|[\s"'`(])\/\/(?!\/)/;
        return keep.every((item) => !item.includes('https://') || (item.includes('http://') && protocolRelative.test(item)));
      },
    },
    {
      id: 'guide-snippets',
      description:
        "the guide's HTML snippets give 0 findings as written and with // or http:// schemes; stripped of crossorigin, or retargeted to a known CDN without integrity, each scheme gives exactly 1; demo.html gives 0",
      weight: 3,
      run: async () => {
        const s = await loadScanner();
        const snippets = guideHtmlSnippets();
        if (snippets.length === 0) return 0;
        const n = (markup: string) => s.scan(markup).length;
        const checks: boolean[] = [];
        for (const snippet of snippets) {
          const onCdn = snippet.replace(/((?:src|href)="https:\/\/)[^/"]+\//g, '$1cdn.jsdelivr.net/npm/');
          for (const scheme of ALL_SCHEMES) {
            const variant = withScheme(snippet, scheme);
            checks.push(n(variant) === 0);
            checks.push(n(stripAttr(variant, 'crossorigin')) === 1);
            checks.push(n(withScheme(stripAttr(stripAttr(onCdn, 'crossorigin'), 'integrity'), scheme)) === 1);
            checks.push(n(withScheme(onCdn, scheme)) === 0);
          }
        }
        const demo = fs.readFileSync(path.join(ROOT, 'guides/security', RULE_ID, 'demo.html'), 'utf8');
        checks.push(n(demo) === 0);
        return mean(checks);
      },
    },
    {
      id: 'guard-https-regressions',
      description:
        'guard: https:// behaviour unchanged (every CDN host, script+stylesheet, integrity-without-crossorigin on CDN and non-CDN hosts, JSX, PHP)',
      weight: 3,
      run: async () =>
        score(await loadScanner(), [
          ...CDNS.flatMap((c) => [flagged(script(`https://${c.host}${c.js}`)), flagged(sheet(`https://${c.host}${c.css}`))]),
          flagged(script('https://static.example.com/app.3f2a9c.js', `integrity="${SRI}"`)),
          flagged(sheet('https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css', `integrity="${SRI}"`)),
          jsx('<script src="https://unpkg.com/katex@0.16.9/dist/katex.min.js" crossOrigin="anonymous" />', true),
          php(sheet('https://maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css'), true),
        ]),
    },
    {
      id: 'guard-exemptions-all-schemes',
      description:
        'guard: in every scheme, integrity+crossorigin, floating/unversioned/query/combine URLs, other hosts, non-stylesheet links, wrong extension and importance are not flagged; same-origin paths are not flagged',
      weight: 3,
      run: async () => {
        const jq = 'code.jquery.com/jquery-3.7.1.min.js';
        const fixtures: Fixture[] = ALL_SCHEMES.flatMap((p) => [
          clean(script(`${p}${jq}`, `integrity="${SRI}" crossorigin="anonymous" referrerpolicy="no-referrer"`)),
          clean(sheet(`${p}maxcdn.bootstrapcdn.com/bootstrap/3.4.1/css/bootstrap.min.css`, `integrity="${SRI}" crossorigin`)),
          clean(script(`${p}cdn.jsdelivr.net/npm/vue@latest/dist/vue.global.js`)),
          clean(script(`${p}unpkg.com/htmx.org@next/dist/htmx.min.js`)),
          clean(script(`${p}code.jquery.com/jquery.min.js`)),
          clean(script(`${p}${jq}?v=2`)),
          clean(script(`${p}cdn.jsdelivr.net/combine/npm/a@1.2.3,npm/b@4.5.6`)),
          clean(script(`${p}cdn.example.com/lib/1.2.3/lib.min.js`)),
          clean(sheet(`${p}fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap`)),
          clean(`<link rel="preload" as="script" href="${p}${jq}">`),
          clean(`<link rel="icon" href="${p}cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/svg/1f600.svg">`),
          clean(script(`${p}cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css`)),
          clean(sheet(`${p}${jq}`)),
          clean(script(`${p}cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js`, 'importance="low"')),
        ]);
        fixtures.push(clean(script('/vendor/jquery-3.7.1.min.js')), clean(script('vendor/jquery-3.7.1.min.js')));
        return score(await loadScanner(), fixtures);
      },
    },
  ],
});
