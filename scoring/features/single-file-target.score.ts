/**
 * Scorecard: `legacy-scan <single file>` must judge an explicitly named file by
 * the file itself, never silently skip it.
 *
 * Problem (unmodified code): single-file mode computes the target's path
 * relative to cwd and runs it through the directory-scan file filter. Ancestor
 * directory names relative to cwd (build/, tmp/, libs/, .cache/, node_modules/,
 * vendor/, ...) therefore make a perfectly normal file disappear, and files the
 * analyzer cannot scan (unsupported extension, minified, vendored license
 * banner, ...) print "0 findings from N qualified guides." with exit 0. Only an
 * oversized file gets a real error.
 *
 * Contract measured here (black-box, by spawning `node src/analyzing/cli.ts`
 * with a controlled cwd inside a fresh mkdtemp directory; NO_COLOR=1):
 *
 *  1. Ancestor directories never matter for an explicitly named file. A
 *     scannable file at e.g. `build/x/app.css`, `tmp/proj/app.css`,
 *     `proj/libs/site.css`, `work/.cache/app.css` (relative to cwd), or the same
 *     file passed as an absolute path from an ancestor cwd, yields the same
 *     findings as `app.css` at the cwd root (exit 0).
 *  2. A named file that cannot be scanned because of the file itself is a
 *     clear error, exactly like the existing size-limit error path:
 *       - text mode: exit code 1, nothing on stdout, `Error: <reason>` on stderr;
 *       - `--json`: exit code 1, valid JSON on stdout with at least the keys of
 *         the size-limit error (`targetDir`, `totalFindings: 0`, `guides: []`,
 *         `error: string`); extra keys are allowed.
 *     Reasons that must be recognisable in the message:
 *       - unsupported extension: mentions "unsupported"/"not supported" and the
 *         extension itself (e.g. `.md`, `.txt`);
 *       - minified content (one line > 1,200 chars): mentions "minified";
 *       - leading third-party versioned license banner: mentions vendor/license.
 *     File-name-based exclusions (`*.min.css`, `*.bundle.js`, well-known
 *     library names such as `jquery.js`) must not be silent either: either the
 *     file is scanned (its legacy pattern is reported) or it is a clear error.
 *  3. Regression guards (these pass on unmodified code and must keep passing):
 *       - directory scans still exclude build/install/vendor/dot dirs, minified,
 *         vendored and unsupported files silently, and still skip docs/tests;
 *       - the size-limit error, the "Target path not found" error (text and
 *         JSON) and ordinary single-file success are unchanged;
 *       - supported files (package.json, .php, .html, .tsx, .vue, upper-case
 *         extensions, *.test.* files, docs/ files) are still accepted.
 *
 * Trigger fixtures (verified against QUALIFIED_RULES at authoring time):
 *   CSS: `.box::-webkit-scrollbar { display: none; }` -> exactly 1 finding of
 *        `customize-scrollbar-color-and-thickness`.
 *   JS:  `AOS.init();` -> exactly 1 finding of `scroll-entry-exit-effects`.
 *
 * Offline, deterministic, ~30 short CLI spawns (< 30 s total).
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineScorecard, mean } from '../lib.ts';

const CLI = fileURLToPath(new URL('../../src/analyzing/cli.ts', import.meta.url));
const CASE_TIMEOUT_MS = 45_000;

const TRIGGER_CSS = '.box::-webkit-scrollbar {\n  display: none;\n}\n';
const TRIGGER_JS = "import AOS from 'aos';\nAOS.init();\n";
const CSS_GUIDE = 'customize-scrollbar-color-and-thickness';
const JS_GUIDE = 'scroll-entry-exit-effects';

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

interface JsonOut {
  targetDir?: unknown;
  totalFindings?: unknown;
  guides?: Array<{ guideId: string; count: number; rules: Array<{ findings: Array<{ file: string }> }> }>;
  error?: unknown;
  skippedDocsAndTestsCount?: unknown;
  [key: string]: unknown;
}

function runCli(args: readonly string[], cwd: string): Promise<CliRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function parseJson(run: CliRun): JsonOut | undefined {
  try {
    const parsed: unknown = JSON.parse(run.stdout);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonOut) : undefined;
  } catch {
    return undefined;
  }
}

function guideCount(json: JsonOut | undefined, guideId: string): number {
  return json?.guides?.find((g) => g.guideId === guideId)?.count ?? 0;
}

async function withProject<T>(files: Record<string, string>, fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'mwg-single-file-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
    }
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Single minified line (> 1,200 chars) that still contains the JS trigger. */
function minifiedJs(): string {
  let s = 'AOS.init();';
  while (s.length < 1500) s += `var a${s.length}=function(b){return b+1};`;
  return `${s}\n`;
}

/** Single minified line (> 1,200 chars) that still contains the CSS trigger. */
function minifiedCss(): string {
  let s = '.box::-webkit-scrollbar{display:none}';
  while (s.length < 1500) s += `.c${s.length}{color:red;margin:0}`;
  return `${s}\n`;
}

const LICENSE_JS = `/*! mylib v1.2.3 | MIT License */\n${TRIGGER_JS}`;

/**
 * Credit for an expected "cannot scan this file" error in text mode.
 * `reasonChecks` are regexes the stderr message must match (each weighted equally).
 */
function textErrorCredit(run: CliRun, reasonChecks: readonly RegExp[]): number {
  const exit = run.code === 1 ? 1 : run.code !== 0 ? 0.5 : 0;
  const isError = run.code !== 0 && /^Error: /m.test(run.stderr);
  const streams = isError && run.stdout.trim() === '' ? 1 : isError ? 0.5 : 0;
  const reasons = isError ? mean(reasonChecks.map((re) => re.test(run.stderr))) : 0;
  return 0.3 * exit + 0.2 * streams + 0.5 * reasons;
}

/** Credit for an expected "cannot scan this file" error in --json mode. */
function jsonErrorCredit(run: CliRun, targetArg: string, reasonChecks: readonly RegExp[]): number {
  const json = parseJson(run);
  const exit = run.code === 1 ? 1 : run.code !== 0 ? 0.5 : 0;
  if (!json || run.code === 0) return 0.2 * exit;
  const hasError = typeof json.error === 'string' && json.error.trim() !== '';
  const shape = mean([
    hasError,
    json.totalFindings === 0,
    Array.isArray(json.guides) && json.guides.length === 0,
    json.targetDir === targetArg,
  ]);
  const reasons = hasError ? mean(reasonChecks.map((re) => re.test(json.error as string))) : 0;
  return 0.2 * exit + 0.4 * shape + 0.4 * reasons;
}

const UNSUPPORTED_RE = /unsupported|not supported/i;

export default defineScorecard({
  feature: 'single-file-target',
  title: 'legacy-scan <single file>: judged by the file itself; unscannable files are clear errors',
  cases: [
    {
      id: 'unsupported-extension-text-error',
      description:
        'legacy-scan README.md (text mode) exits 1 with "Error: ..." on stderr, nothing on stdout, mentioning unsupported and ".md"',
      weight: 12,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        withProject({ 'README.md': '# Hello\n\nSome docs.\n' }, async (root) => {
          const run = await runCli(['README.md'], root);
          return textErrorCredit(run, [UNSUPPORTED_RE, /\.md\b/i]);
        }),
    },
    {
      id: 'unsupported-extension-json-error',
      description:
        'legacy-scan README.md --json exits 1 with valid JSON shaped like the size-limit error (targetDir, totalFindings 0, guides [], error mentioning unsupported and ".md")',
      weight: 10,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        withProject({ 'README.md': '# Hello\n', 'large.css': `/*${' '.repeat(1_000_100)}*/\n` }, async (root) => {
          const [run, sizeRun] = await Promise.all([
            runCli(['README.md', '--json'], root),
            runCli(['large.css', '--json'], root),
          ]);
          const base = jsonErrorCredit(run, 'README.md', [UNSUPPORTED_RE, /\.md\b/i]);
          // Shape consistency with the live size-limit error: every key it has, with the same value type.
          const json = parseJson(run);
          const sizeJson = parseJson(sizeRun);
          if (!json || !sizeJson || run.code === 0) return base * 0.9;
          const keys = Object.keys(sizeJson);
          const sameShape = mean(keys.map((k) => k in json && typeof json[k] === typeof sizeJson[k]));
          return base * 0.9 + 0.1 * sameShape;
        }),
    },
    {
      id: 'ancestor-dirs-relative-to-cwd',
      description:
        'trigger CSS at build/x/app.css, tmp/proj/app.css, proj/libs/site.css, work/.cache/app.css (relative to cwd) each yields 1 finding, exit 0 (credit = fraction found)',
      weight: 16,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () => {
        const paths = ['build/x/app.css', 'tmp/proj/app.css', 'proj/libs/site.css', 'work/.cache/app.css'];
        return withProject(Object.fromEntries(paths.map((p) => [p, TRIGGER_CSS])), async (root) => {
          const runs = await Promise.all(paths.map((p) => runCli([p, '--json'], root)));
          return mean(
            runs.map((r) => {
              const json = parseJson(r);
              return r.code === 0 && json?.totalFindings === 1 && guideCount(json, CSS_GUIDE) === 1;
            }),
          );
        });
      },
    },
    {
      id: 'more-ancestor-dirs-relative-to-cwd',
      description:
        'trigger CSS under node_modules/, dist/, vendor/, third_party/, a vendored subpath (proj/codemirror/) and a hashed asset dir (assets/a09b59a8/) relative to cwd is still found (credit = fraction found)',
      weight: 6,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () => {
        const paths = [
          'node_modules/pkg/app.css',
          'dist/app.css',
          'vendor/app.css',
          'third_party/x/app.css',
          'proj/codemirror/app.css',
          'assets/a09b59a8/app.css',
        ];
        return withProject(Object.fromEntries(paths.map((p) => [p, TRIGGER_CSS])), async (root) => {
          const runs = await Promise.all(paths.map((p) => runCli([p, '--json'], root)));
          return mean(runs.map((r) => r.code === 0 && guideCount(parseJson(r), CSS_GUIDE) === 1));
        });
      },
    },
    {
      id: 'absolute-path-from-ancestor-cwd',
      description:
        'the trigger file passed as an absolute path while cwd is an ancestor whose relative path contains dist/ or node_modules/ is found (text and JSON)',
      weight: 8,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        withProject({ 'dist/site/app.css': TRIGGER_CSS, 'node_modules/pkg/style.css': TRIGGER_CSS }, async (root) => {
          const a = path.join(root, 'dist/site/app.css');
          const b = path.join(root, 'node_modules/pkg/style.css');
          const [ja, jb, ta] = await Promise.all([
            runCli([a, '--json'], root),
            runCli([b, '--json'], root),
            runCli([a], root),
          ]);
          return mean([
            ja.code === 0 && guideCount(parseJson(ja), CSS_GUIDE) === 1,
            jb.code === 0 && guideCount(parseJson(jb), CSS_GUIDE) === 1,
            ta.code === 0 && /Found 1 modernization opportunity/.test(ta.stdout) && /app\.css:1/.test(ta.stdout),
          ]);
        }),
    },
    {
      id: 'minified-file-error',
      description:
        'a single-line minified app.js (> 1,200 chars) exits 1 with a reason mentioning "minified" in text and --json mode; same for a minified app.css',
      weight: 10,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        withProject({ 'app.js': minifiedJs(), 'site.css': minifiedCss() }, async (root) => {
          const [tjs, jjs, tcss] = await Promise.all([
            runCli(['app.js'], root),
            runCli(['app.js', '--json'], root),
            runCli(['site.css'], root),
          ]);
          return (
            0.4 * textErrorCredit(tjs, [/minif/i]) +
            0.4 * jsonErrorCredit(jjs, 'app.js', [/minif/i]) +
            0.2 * textErrorCredit(tcss, [/minif/i])
          );
        }),
    },
    {
      id: 'vendored-license-header-error',
      description:
        'a JS file opening with a versioned third-party license banner (/*! mylib v1.2.3 | MIT License */) is a clear error mentioning vendor/license/third-party (scanning it instead earns partial credit)',
      weight: 5,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        withProject({ 'lib.js': LICENSE_JS }, async (root) => {
          const [text, json] = await Promise.all([runCli(['lib.js'], root), runCli(['lib.js', '--json'], root)]);
          const reason = [/vendor|licen[cs]e|third[- ]party/i];
          const errorCredit = 0.5 * textErrorCredit(text, reason) + 0.5 * jsonErrorCredit(json, 'lib.js', reason);
          const scanned = json.code === 0 && guideCount(parseJson(json), JS_GUIDE) === 1 ? 0.4 : 0;
          return Math.max(errorCredit, scanned);
        }),
    },
    {
      id: 'other-unsupported-extensions-error',
      description:
        'notes.txt, data.json and an extension-less Makefile each exit 1 with an error; .txt/.json messages name their extension and say unsupported',
      weight: 5,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        withProject(
          { 'notes.txt': 'AOS.init();\n', 'data.json': '{"a":1}\n', Makefile: 'all:\n\techo hi\n' },
          async (root) => {
            const [txt, json, make, txtJson] = await Promise.all([
              runCli(['notes.txt'], root),
              runCli(['data.json'], root),
              runCli(['Makefile'], root),
              runCli(['notes.txt', '--json'], root),
            ]);
            return mean([
              textErrorCredit(txt, [UNSUPPORTED_RE, /\.txt\b/i]),
              textErrorCredit(json, [UNSUPPORTED_RE, /\.json\b/i]),
              textErrorCredit(make, [/unsupported|not supported|extension/i]),
              jsonErrorCredit(txtJson, 'notes.txt', [UNSUPPORTED_RE, /\.txt\b/i]),
            ]);
          },
        ),
    },
    {
      id: 'name-based-exclusions-not-silent',
      description:
        'app.min.css, app.bundle.js and jquery.js containing a legacy trigger are either scanned (finding reported) or rejected with exit 1 and an Error message; never "0 findings" with exit 0',
      weight: 4,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        withProject(
          { 'app.min.css': TRIGGER_CSS, 'app.bundle.js': TRIGGER_JS, 'jquery.js': TRIGGER_JS },
          async (root) => {
            const targets: Array<[string, string]> = [
              ['app.min.css', CSS_GUIDE],
              ['app.bundle.js', JS_GUIDE],
              ['jquery.js', JS_GUIDE],
            ];
            const runs = await Promise.all(targets.map(([f]) => runCli([f], root)));
            const jsonRuns = await Promise.all(targets.map(([f]) => runCli([f, '--json'], root)));
            return mean(
              targets.map(([, guide], i) => {
                const text = runs[i]!;
                const json = jsonRuns[i]!;
                const parsed = parseJson(json);
                const scanned = text.code === 0 && json.code === 0 && guideCount(parsed, guide) === 1;
                const rejected =
                  text.code === 1 &&
                  /^Error: \S/m.test(text.stderr) &&
                  json.code === 1 &&
                  typeof parsed?.error === 'string' &&
                  parsed.error.trim() !== '';
                return scanned || rejected;
              }),
            );
          },
        ),
    },

    // ---------------------------------------------------------------------
    // Regression guards: pass on unmodified code, must keep passing.
    // ---------------------------------------------------------------------
    {
      id: 'guard-directory-scan-exclusions',
      description:
        'directory scans still silently exclude node_modules/build/dist/tmp/.cache/vendor/libs, minified, license-bannered, *.min.css, jquery.js and README.md files and skip test/ (only the root app.css is reported, exit 0); an excluded-named dir targeted directly is still scanned',
      weight: 7,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        withProject(
          {
            'app.css': TRIGGER_CSS,
            'node_modules/pkg/a.css': TRIGGER_CSS,
            'build/b.css': TRIGGER_CSS,
            'dist/c.css': TRIGGER_CSS,
            'tmp/d.css': TRIGGER_CSS,
            '.cache/e.css': TRIGGER_CSS,
            'vendor/f.css': TRIGGER_CSS,
            'libs/g.css': TRIGGER_CSS,
            'test/h.css': TRIGGER_CSS,
            'README.md': '# readme\n',
            'notes.txt': 'AOS.init();\n',
            'mini.js': minifiedJs(),
            'lib.js': LICENSE_JS,
            'app.min.css': TRIGGER_CSS,
            'jquery.js': TRIGGER_JS,
            'out/site/page.css': TRIGGER_CSS,
          },
          async (root) => {
            const [json, text, nested] = await Promise.all([
              runCli(['.', '--json'], root),
              runCli(['.'], root),
              runCli(['out/site', '--json'], root),
            ]);
            const parsed = parseJson(json);
            const files = (parsed?.guides ?? []).flatMap((g) => g.rules.flatMap((r) => r.findings.map((f) => f.file)));
            const nestedParsed = parseJson(nested);
            return mean([
              json.code === 0,
              parsed?.error === undefined,
              parsed?.totalFindings === 1,
              files.length === 1 && files[0] === 'app.css',
              parsed?.skippedDocsAndTestsCount === 1,
              text.code === 0 && text.stderr === '' && /Found 1 modernization opportunity/.test(text.stdout),
              nested.code === 0 && guideCount(nestedParsed, CSS_GUIDE) === 1,
            ]);
          },
        ),
    },
    {
      id: 'guard-size-limit-error-unchanged',
      description:
        'an oversized single file still fails with exit 1 and "Target file exceeds maximum size (N bytes): <arg>" (text on stderr; JSON {targetDir, totalFindings: 0, guides: [], error})',
      weight: 4,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        withProject({ 'large.css': `/*${' '.repeat(1_000_100)}*/\n` }, async (root) => {
          const [text, json] = await Promise.all([runCli(['large.css'], root), runCli(['large.css', '--json'], root)]);
          const parsed = parseJson(json);
          const msgRe = /^Target file exceeds maximum size \(\d+ bytes\): large\.css$/;
          return mean([
            text.code === 1,
            text.stdout === '',
            /^Error: Target file exceeds maximum size \(\d+ bytes\): large\.css\n$/.test(text.stderr),
            json.code === 1,
            parsed !== undefined &&
              parsed.targetDir === 'large.css' &&
              parsed.totalFindings === 0 &&
              Array.isArray(parsed.guides) &&
              parsed.guides.length === 0 &&
              typeof parsed.error === 'string' &&
              msgRe.test(parsed.error),
          ]);
        }),
    },
    {
      id: 'guard-single-file-success-unchanged',
      description:
        'ordinary single-file scans still work: root app.css (text + JSON, file label "app.css"), absolute path from an unrelated sibling cwd, a ../ relative path, docs/app.css and component.test.html',
      weight: 5,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        withProject(
          {
            'app.css': TRIGGER_CSS,
            'elsewhere/.keep': '',
            'docs/app.css': TRIGGER_CSS,
            'component.test.js': TRIGGER_JS,
          },
          async (root) => {
            const sibling = path.join(root, 'elsewhere');
            const [text, json, abs, rel, docs, testFile] = await Promise.all([
              runCli(['app.css'], root),
              runCli(['app.css', '--json'], root),
              runCli([path.join(root, 'app.css'), '--json'], sibling),
              runCli(['../app.css', '--json'], sibling),
              runCli(['docs/app.css', '--json'], root),
              runCli(['component.test.js', '--json'], root),
            ]);
            const parsed = parseJson(json);
            return mean([
              text.code === 0 &&
                text.stderr === '' &&
                /Found 1 modernization opportunity across 1 guide/.test(text.stdout) &&
                /- app\.css:1/.test(text.stdout),
              json.code === 0 &&
                parsed?.targetDir === 'app.css' &&
                parsed.totalFindings === 1 &&
                parsed.guides?.[0]?.rules[0]?.findings[0]?.file === 'app.css' &&
                parsed.error === undefined,
              abs.code === 0 && guideCount(parseJson(abs), CSS_GUIDE) === 1,
              rel.code === 0 && guideCount(parseJson(rel), CSS_GUIDE) === 1,
              docs.code === 0 && guideCount(parseJson(docs), CSS_GUIDE) === 1,
              testFile.code === 0 && guideCount(parseJson(testFile), JS_GUIDE) === 1,
            ]);
          },
        ),
    },
    {
      id: 'guard-supported-files-accepted',
      description:
        'supported single files are not rejected: package.json, a.php, a.html, a.tsx, a.vue and upper-case APP.CSS exit 0 with no error (APP.CSS reports its finding)',
      weight: 4,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        withProject(
          {
            'package.json': '{"name":"x","version":"1.0.0"}\n',
            'a.php': '<?php echo 1; ?>\n',
            'a.html': '<!doctype html><title>x</title><p>hi</p>\n',
            'a.tsx': 'export const A = () => <div />;\n',
            'a.vue': '<template><div /></template>\n',
            'APP.CSS': TRIGGER_CSS,
          },
          async (root) => {
            const names = ['package.json', 'a.php', 'a.html', 'a.tsx', 'a.vue'];
            const runs = await Promise.all(names.map((n) => runCli([n, '--json'], root)));
            const upper = await runCli(['APP.CSS', '--json'], root);
            return mean([
              ...runs.map((r) => r.code === 0 && parseJson(r)?.error === undefined),
              upper.code === 0 && guideCount(parseJson(upper), CSS_GUIDE) === 1,
            ]);
          },
        ),
    },
    {
      id: 'guard-nonexistent-path-unchanged',
      description:
        'a missing target (also one with an unsupported extension) still reports exactly "Target path not found: <arg>" with exit 1 in text (stderr) and JSON',
      weight: 4,
      timeoutMs: CASE_TIMEOUT_MS,
      run: () =>
        withProject({}, async (root) => {
          const [text, json, md] = await Promise.all([
            runCli(['nope.css'], root),
            runCli(['nope.css', '--json'], root),
            runCli(['missing.md'], root),
          ]);
          const parsed = parseJson(json);
          return mean([
            text.code === 1 && text.stdout === '' && text.stderr === 'Error: Target path not found: nope.css\n',
            json.code === 1 &&
              parsed !== undefined &&
              JSON.stringify(parsed) ===
                JSON.stringify({ targetDir: 'nope.css', totalFindings: 0, guides: [], error: 'Target path not found: nope.css' }),
            md.code === 1 && md.stderr === 'Error: Target path not found: missing.md\n',
          ]);
        }),
    },
  ],
});
