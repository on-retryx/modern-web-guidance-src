/**
 * Scorecard: legacy-scan must ignore `<script>` / `<style>` blocks inside HTML comments.
 *
 * Problem: `SCRIPT_TAG_REGEX` / `STYLE_TAG_REGEX` in `src/analyzing/scanners/sfc-extractor.ts`
 * run on raw markup, so a commented-out block such as
 * `<!-- <style>.box::-webkit-scrollbar-thumb{…}</style> -->` is still scanned and reported
 * (here as `customize-scrollbar-color-and-thickness`; a commented-out `<script>` with a
 * dialog backdrop-click handler is reported as `dialog`). The element (DOM) scanner already
 * skips comments; the block extractors do not.
 *
 * Contract measured here (all through the public entry point
 * `scanFiles(files, QUALIFIED_RULES)` from `src/analyzing/scanners/index.ts`, in memory,
 * offline, deterministic):
 *
 * 1. In markup files that go through the block extractors (.html, .htm, .php, .vue, .svelte,
 *    .astro, and the `<template>` markup of .gts/.gjs), a `<script>`/`<style>` block that
 *    lies inside an HTML comment (`<!-- … -->`) produces no finding. This holds for single-
 *    and multi-line comments, comments at the root of an SFC and inside `<template>`,
 *    downlevel-hidden conditional comments (`<!--[if IE]>…<![endif]-->`), comments that
 *    contain `>` or `--`, and comments that only hold an opening tag (`<!-- <style> -->`),
 *    which must not swallow the next live block.
 * 2. Comments are recognised the way the HTML tokenizer does, so live code is never hidden:
 *    - `<!--` inside the raw text of a live `<script>`/`<style>` does not start a comment
 *      (legacy `<script><!-- … //--></script>` and `<style><!-- … --></style>` wrappers are
 *      live; `document.write("<!--")` does not hide later blocks);
 *    - downlevel-revealed conditional comments (`<!--[if !IE]><!-->…<!--<![endif]-->`) leave
 *      the block between them live;
 *    - the abrupt empty comments `<!-->` and `<!--->` end right there;
 *    - `<!--` inside a quoted attribute value is not a comment;
 *    - an unterminated `<!--` neither crashes the scan nor hides live blocks before it
 *      (blocks after it are not judged).
 * 3. Line numbers of live findings are unchanged (offsets preserved), including with CRLF
 *    line endings.
 * 4. Non-markup files (.css, .js/.ts incl. Lit css``) are unaffected.
 *
 * Fixtures mark every trigger line with a unique token: `.css-live-N` / `.css-dead-N` selectors
 * (→ customize-scrollbar-color-and-thickness) and `/* js-live-N *\/` / `/* js-dead-N *\/` comments
 * on the `addEventListener('click', …)` line (→ dialog). The expected line of a finding is
 * the line of its marker.
 *
 * Grading per file (all findings of all qualified rules count, fixtures have no other triggers):
 * - each live marker: 1 if a finding of its guide is on the marker line, 0.5 if a finding of its
 *   guide is reported on some other non-dead line instead (present, wrong line), else 0;
 * - every other finding (on a dead marker line, a duplicate, or unrelated) is spurious;
 *   clean = 1 − min(spurious, max(#dead, 1)) / max(#dead, 1);
 * - live-only file: live × clean; dead-only file: clean;
 *   mixed file: live × (0.25 + 0.75 × clean), so a scanner that ignores comments entirely
 *   keeps only a quarter of the credit and one that hides live code gets none.
 * Cases with several files average the per-file grades. Regression guards are marked
 * `[guard]` in their description and are expected to pass on the unmodified scanner.
 */
import { defineScorecard, mean } from '../lib.ts';

const SCROLLBAR = 'customize-scrollbar-color-and-thickness';
const DIALOG = 'dialog';
const DECLS = '{ background: #888; border-radius: 4px; }';

interface Finding {
  readonly guideId: string;
  readonly file: string;
  readonly line: number;
}

interface FileExpectation {
  readonly path: string;
  readonly content: string;
  /** Markers that must be reported on their own line. */
  readonly live?: readonly string[];
  /** Markers that must not be reported. */
  readonly dead?: readonly string[];
  /** Markers whose findings are neither required nor penalised. */
  readonly ignore?: readonly string[];
}

/** Multi-line live/dead style block; the selector line carries the marker. */
function style(marker: string, indent = ''): string {
  return `${indent}<style>\n${indent}  .${marker}::-webkit-scrollbar-thumb ${DECLS}\n${indent}</style>`;
}

/** Single-line style block. */
function style1(marker: string): string {
  return `<style>.${marker}::-webkit-scrollbar-thumb ${DECLS}</style>`;
}

/** Dialog backdrop-click handler body (no surrounding tags); the listener line carries the marker. */
function dialogJs(marker: string, indent = '  '): string {
  return [
    `${indent}var dialog = document.querySelector('dialog');`,
    `${indent}dialog.addEventListener('click', function (event) { /* ${marker} */`,
    `${indent}  if (event.target === dialog) {`,
    `${indent}    dialog.close();`,
    `${indent}  }`,
    `${indent}});`,
  ].join('\n');
}

/** Multi-line script block with the dialog trigger. */
function script(marker: string, openTag = '<script>', indent = ''): string {
  return `${indent}${openTag}\n${dialogJs(marker, `${indent}  `)}\n${indent}</script>`;
}

/** Single-line script block with the dialog trigger. */
function script1(marker: string): string {
  return `<script>var dialog = document.querySelector('dialog'); dialog.addEventListener('click', function (event) { /* ${marker} */ if (event.target === dialog) { dialog.close(); } });</script>`;
}

function guideOf(marker: string): string {
  return marker.startsWith('css-') ? SCROLLBAR : DIALOG;
}

function lineOf(content: string, marker: string): number {
  const re = marker.startsWith('css-') ? `.${marker}::` : `/* ${marker} */`;
  const lines = content.split('\n');
  const hits = lines.flatMap((l, i) => (l.includes(re) ? [i + 1] : []));
  if (hits.length !== 1) {
    throw new Error(`fixture error: marker ${marker} found ${hits.length} times`);
  }
  return hits[0] as number;
}

async function scan(files: readonly FileExpectation[]): Promise<Finding[]> {
  const { scanFiles } = await import('../../src/analyzing/scanners/index.ts');
  const { QUALIFIED_RULES } = await import('../../src/analyzing/rules/index.ts');
  return scanFiles(new Map(files.map((f) => [f.path, f.content])), QUALIFIED_RULES);
}

function gradeFile(all: readonly Finding[], exp: FileExpectation): number {
  const live = exp.live ?? [];
  const dead = exp.dead ?? [];
  const deadLines = new Set(dead.map((m) => lineOf(exp.content, m)));
  const ignoreLines = new Set((exp.ignore ?? []).map((m) => lineOf(exp.content, m)));
  const remaining = all.filter((f) => f.file === exp.path && !ignoreLines.has(f.line));

  const credit = new Map<string, number>();
  for (const m of live) {
    const line = lineOf(exp.content, m);
    const idx = remaining.findIndex((f) => f.guideId === guideOf(m) && f.line === line);
    if (idx >= 0) {
      credit.set(m, 1);
      remaining.splice(idx, 1);
    }
  }
  for (const m of live) {
    if (credit.has(m)) continue;
    const idx = remaining.findIndex((f) => f.guideId === guideOf(m) && !deadLines.has(f.line));
    if (idx >= 0) {
      credit.set(m, 0.5);
      remaining.splice(idx, 1);
    }
  }

  const liveScore = live.length ? live.reduce((s, m) => s + (credit.get(m) ?? 0), 0) / live.length : 1;
  const budget = Math.max(dead.length, 1);
  const clean = 1 - Math.min(remaining.length, budget) / budget;
  if (!live.length) return clean;
  if (!dead.length) return liveScore * clean;
  return liveScore * (0.25 + 0.75 * clean);
}

async function grade(files: readonly FileExpectation[]): Promise<number> {
  const findings = await scan(files);
  return mean(files.map((f) => gradeFile(findings, f)));
}

const lines = (...parts: string[]): string => `${parts.join('\n')}\n`;

export default defineScorecard({
  feature: 'html-comment-blocks',
  title: 'legacy-scan ignores <script>/<style> blocks inside HTML comments',
  cases: [
    {
      id: 'html-commented-style-block',
      description: 'Single- and multi-line `<!-- <style>…</style> -->` in .html produce no finding.',
      weight: 8,
      run: () =>
        grade([
          {
            path: 'site/index.html',
            content: lines(
              '<!doctype html>',
              '<html>',
              '<head>',
              '<title>Page</title>',
              `<!-- ${style1('css-dead-1')} -->`,
              '<!--',
              style('css-dead-2'),
              '-->',
              '</head>',
              '<body><p>Hello</p></body>',
              '</html>',
            ),
            dead: ['css-dead-1', 'css-dead-2'],
          },
        ]),
    },
    {
      id: 'html-commented-multiline-script-block',
      description: 'Multi-line commented-out `<script>` blocks (plain and typed) with a dialog handler produce no finding.',
      weight: 8,
      run: () =>
        grade([
          {
            path: 'site/modal.html',
            content: lines(
              '<!doctype html>',
              '<html>',
              '<body>',
              '<p>Hello</p>',
              '<!--',
              script('js-dead-1'),
              '-->',
              '<!-- old module version',
              script('js-dead-2', '<script type="module">'),
              '-->',
              '</body>',
              '</html>',
            ),
            dead: ['js-dead-1', 'js-dead-2'],
          },
        ]),
    },
    {
      id: 'legacy-script-comment-wrapper-is-live',
      description:
        'Legacy `<script><!-- … //--></script>` wrapper is live: its finding is kept on the right line, while a real commented style block is dropped.',
      weight: 6,
      run: () =>
        grade([
          {
            path: 'legacy/page.html',
            content: lines(
              '<html>',
              '<head>',
              `<!-- ${style1('css-dead-1')} -->`,
              '<script type="text/javascript"><!--',
              dialogJs('js-live-1', ''),
              '//--></script>',
              '<script language="javascript">',
              '<!--',
              dialogJs('js-live-2', ''),
              '// -->',
              '</script>',
              '</head>',
              '<body></body>',
              '</html>',
            ),
            live: ['js-live-1', 'js-live-2'],
            dead: ['css-dead-1'],
          },
        ]),
    },
    {
      id: 'lt-bang-dash-dash-inside-script-text',
      description:
        '`<!--` inside live script text (`document.write("<!--")`) does not open a comment: later live blocks are reported, a later real comment is still dropped.',
      weight: 6,
      run: () =>
        grade([
          {
            path: 'legacy/write.html',
            content: lines(
              '<html>',
              '<body>',
              '<script>document.write("<!--");</script>',
              style('css-live-1'),
              script('js-live-1'),
              `<!-- ${style1('css-dead-1')} -->`,
              '</body>',
              '</html>',
            ),
            live: ['css-live-1', 'js-live-1'],
            dead: ['css-dead-1'],
          },
        ]),
    },
    {
      id: 'downlevel-conditional-comments',
      description:
        'Downlevel-revealed `<!--[if !IE]><!-->…<!--<![endif]-->` blocks are live (multi- and single-line); a downlevel-hidden `<!--[if IE]>…<![endif]-->` block is dropped.',
      weight: 6,
      run: () =>
        grade([
          {
            path: 'legacy/conditional.html',
            content: lines(
              '<html>',
              '<head>',
              `<!--[if IE]>${style1('css-dead-1')}<![endif]-->`,
              '<!--[if !IE]><!-->',
              style('css-live-1'),
              '<!--<![endif]-->',
              `<!--[if !IE]><!-->${style1('css-live-2')}<!--<![endif]-->`,
              '</head>',
              '<body></body>',
              '</html>',
            ),
            live: ['css-live-1', 'css-live-2'],
            dead: ['css-dead-1'],
          },
        ]),
    },
    {
      id: 'crlf-commented-then-live-line-numbers',
      description:
        'CRLF files: a commented block followed by a live block yields exactly one finding, on the live block’s line (style and script).',
      weight: 8,
      run: () =>
        grade([
          {
            path: 'win/style.html',
            content: lines(
              '<!DOCTYPE html>',
              '<html>',
              '<head>',
              '<!--',
              style('css-dead-1'),
              '-->',
              style('css-live-1'),
              '</head>',
              '<body></body>',
              '</html>',
            ).replace(/\n/g, '\r\n'),
            live: ['css-live-1'],
            dead: ['css-dead-1'],
          },
          {
            path: 'win/script.html',
            content: lines(
              '<!DOCTYPE html>',
              '<html>',
              '<body>',
              '<!--',
              script('js-dead-1'),
              '-->',
              '<p>Hello</p>',
              script('js-live-1'),
              '</body>',
              '</html>',
            ).replace(/\n/g, '\r\n'),
            live: ['js-live-1'],
            dead: ['js-dead-1'],
          },
        ]),
    },
    {
      id: 'vue-template-commented-style',
      description: 'Vue SFC: `<template><!-- <style>…</style> --></template>` (single- and multi-line) produces no finding.',
      weight: 7,
      run: () =>
        grade([
          {
            path: 'src/components/Box.vue',
            content: lines(
              '<template>',
              '  <div class="box">',
              `    <!-- ${style1('css-dead-1')} -->`,
              '    <span>Hello</span>',
              '    <!--',
              style('css-dead-2', '    '),
              '    -->',
              '  </div>',
              '</template>',
              '',
              '<script setup>',
              'const label = "box";',
              '</script>',
            ),
            dead: ['css-dead-1', 'css-dead-2'],
          },
        ]),
    },
    {
      id: 'vue-root-commented-blocks',
      description: 'Vue SFC: root-level commented `<script>`/`<style>` blocks are dropped; live `<script setup>` and `<style scoped>` are kept on their lines.',
      weight: 4,
      run: () =>
        grade([
          {
            path: 'src/components/Modal.vue',
            content: lines(
              '<!--',
              script('js-dead-1'),
              '-->',
              '<template>',
              '  <div class="box"><slot /></div>',
              '</template>',
              '',
              script('js-live-1', '<script setup>'),
              '',
              `<!-- ${style1('css-dead-1')} -->`,
              style('css-live-1').replace('<style>', '<style scoped>'),
            ),
            live: ['js-live-1', 'css-live-1'],
            dead: ['js-dead-1', 'css-dead-1'],
          },
        ]),
    },
    {
      id: 'svelte-and-astro-commented-blocks',
      description: 'Svelte and Astro: commented blocks are dropped, live blocks kept on their lines (Astro frontmatter untouched).',
      weight: 5,
      run: () =>
        grade([
          {
            path: 'src/lib/Box.svelte',
            content: lines(
              '<script>',
              '  let open = false;',
              '</script>',
              '',
              `<!-- ${style1('css-dead-1')} -->`,
              '<div class="box"></div>',
              '',
              style('css-live-1'),
            ),
            live: ['css-live-1'],
            dead: ['css-dead-1'],
          },
          {
            path: 'src/pages/index.astro',
            content: lines(
              '---',
              "const title = 'Home';",
              '---',
              '<html>',
              '<body>',
              '<!--',
              script('js-dead-1'),
              '-->',
              script('js-live-1'),
              `<!-- ${style1('css-dead-1')} -->`,
              '</body>',
              '</html>',
            ),
            live: ['js-live-1'],
            dead: ['js-dead-1', 'css-dead-1'],
          },
        ]),
    },
    {
      id: 'php-and-htm-commented-blocks',
      description: '.php and .htm files: commented blocks are dropped, live blocks kept on their lines.',
      weight: 4,
      run: () =>
        grade([
          {
            path: 'templates/header.php',
            content: lines(
              "<?php $title = 'Home'; ?>",
              '<html>',
              '<head>',
              `<!-- ${style1('css-dead-1')} -->`,
              style('css-live-1'),
              '</head>',
              '<body><?php echo $title; ?></body>',
              '</html>',
            ),
            live: ['css-live-1'],
            dead: ['css-dead-1'],
          },
          {
            path: 'static/old.htm',
            content: lines(
              '<html>',
              '<body>',
              '<!--',
              script('js-dead-1'),
              '-->',
              '</body>',
              '</html>',
            ),
            dead: ['js-dead-1'],
          },
        ]),
    },
    {
      id: 'interleaved-comments-and-blocks',
      description:
        'Several comments interleaved with live blocks: comments containing `>`/`--`, an empty `<!---->`, one comment spanning a script and a style, single-line commented script; only live blocks reported, on their lines.',
      weight: 5,
      run: () =>
        grade([
          {
            path: 'site/mixed.html',
            content: lines(
              '<html>',
              '<head>',
              style('css-live-1'),
              `<!-- note: a > b -- c ${style1('css-dead-1')} -->`,
              '<!---->',
              style('css-live-2'),
              '<!--',
              script('js-dead-1', '<script>', '  '),
              style('css-dead-2', '  '),
              '-->',
              '</head>',
              '<body>',
              script('js-live-1'),
              `<!-- ${script1('js-dead-2')} -->`,
              '</body>',
              '</html>',
            ),
            live: ['css-live-1', 'css-live-2', 'js-live-1'],
            dead: ['css-dead-1', 'css-dead-2', 'js-dead-1', 'js-dead-2'],
          },
        ]),
    },
    {
      id: 'commented-opening-tag-does-not-swallow-live-block',
      description:
        'A comment holding only an opening tag (`<!-- <style> -->`, `<!-- <script src=…> -->`) neither hides nor merges into the next live block; a full commented block is still dropped.',
      weight: 4,
      run: () =>
        grade([
          {
            path: 'site/opener.html',
            content: lines(
              '<html>',
              '<head>',
              '<!-- <style> -->',
              '<!-- <script src="old.js"> -->',
              style('css-live-1'),
              script('js-live-1'),
              `<!-- ${style1('css-dead-1')} -->`,
              '</head>',
              '<body></body>',
              '</html>',
            ),
            live: ['css-live-1', 'js-live-1'],
            dead: ['css-dead-1'],
          },
        ]),
    },
    {
      id: 'glimmer-template-commented-style',
      description: '.gts `<template>` markup: a commented style block is dropped, a live one kept on its line.',
      weight: 3,
      run: () =>
        grade([
          {
            path: 'app/components/box.gts',
            content: lines(
              "import Component from '@glimmer/component';",
              '',
              'export default class Box extends Component {',
              '  <template>',
              `    <!-- ${style1('css-dead-1')} -->`,
              '    <div class="box"></div>',
              style('css-live-1', '    '),
              '  </template>',
              '}',
            ),
            live: ['css-live-1'],
            dead: ['css-dead-1'],
          },
        ]),
    },
    {
      id: 'unterminated-comment-robustness',
      description:
        '[guard] An unterminated `<!--` (with a block after it, or at EOF) does not crash the scan or hide live blocks before it; blocks after it are not judged.',
      weight: 5,
      run: () =>
        grade([
          {
            path: 'site/broken.html',
            content: lines(
              '<html>',
              '<head>',
              style('css-live-1'),
              script('js-live-1'),
              '</head>',
              '<body>',
              `<!-- ${style1('css-tail-1')}`,
              '</body>',
              '</html>',
            ),
            live: ['css-live-1', 'js-live-1'],
            ignore: ['css-tail-1'],
          },
          {
            path: 'src/components/Eof.vue',
            content: `${lines('<template><div class="box"></div></template>', style('css-live-1'))}<!--`,
            live: ['css-live-1'],
          },
        ]),
    },
    {
      id: 'regression-live-blocks-all-markup-extensions',
      description:
        '[guard] Uncommented blocks in every extractor extension (.html .htm .php .vue .svelte .astro .gts) are still reported once, on the same line as before.',
      weight: 8,
      run: () =>
        grade([
          {
            path: 'r/a.html',
            content: lines('<!doctype html>', '<html><head>', style('css-live-1'), '</head><body>', script('js-live-1'), '</body></html>'),
            live: ['css-live-1', 'js-live-1'],
          },
          {
            path: 'r/a.htm',
            content: lines('<html><head>', style('css-live-1'), '</head></html>'),
            live: ['css-live-1'],
          },
          {
            path: 'r/a.php',
            content: lines("<?php $x = 1; ?>", '<html><head>', style('css-live-1'), '</head><body>', script('js-live-1'), '</body></html>'),
            live: ['css-live-1', 'js-live-1'],
          },
          {
            path: 'r/A.vue',
            content: lines('<template>', '  <div class="box"></div>', '</template>', '', script('js-live-1', '<script setup>'), '', style('css-live-1')),
            live: ['js-live-1', 'css-live-1'],
          },
          {
            path: 'r/A.svelte',
            content: lines(script('js-live-1'), '', '<div class="box"></div>', '', style('css-live-1')),
            live: ['js-live-1', 'css-live-1'],
          },
          {
            path: 'r/a.astro',
            content: lines('---', "const title = 'x';", '---', '<div class="box"></div>', script('js-live-1'), style('css-live-1')),
            live: ['js-live-1', 'css-live-1'],
          },
          {
            path: 'r/a.gts',
            content: lines(
              "import Component from '@glimmer/component';",
              'export default class A extends Component {',
              '  <template>',
              '    <div class="box"></div>',
              style('css-live-1', '    '),
              '  </template>',
              '}',
            ),
            live: ['css-live-1'],
          },
        ]),
    },
    {
      id: 'style-cdo-cdc-wrapper-is-live',
      description:
        'Legacy `<style><!-- … --></style>` wrappers are live (kept on their lines) while a real commented style block is dropped.',
      weight: 3,
      run: () =>
        grade([
          {
            path: 'legacy/style-wrap.html',
            content: lines(
              '<html>',
              '<head>',
              '<style type="text/css"><!--',
              `.css-live-1::-webkit-scrollbar-thumb ${DECLS}`,
              '--></style>',
              '<style>',
              '<!--',
              `  .css-live-2::-webkit-scrollbar-thumb ${DECLS}`,
              '-->',
              '</style>',
              `<!-- ${style1('css-dead-1')} -->`,
              '</head>',
              '</html>',
            ),
            live: ['css-live-1', 'css-live-2'],
            dead: ['css-dead-1'],
          },
        ]),
    },
    {
      id: 'abrupt-empty-comments',
      description:
        '`<!-->` and `<!--->` are complete (empty) comments per the HTML tokenizer: blocks after them stay live; a real commented block is dropped.',
      weight: 3,
      run: () =>
        grade([
          {
            path: 'site/abrupt.html',
            content: lines(
              '<html>',
              '<head>',
              '<!-->',
              style('css-live-1'),
              '<!--->',
              style('css-live-2'),
              `<!-- ${style1('css-dead-1')} -->`,
              '</head>',
              '</html>',
            ),
            live: ['css-live-1', 'css-live-2'],
            dead: ['css-dead-1'],
          },
        ]),
    },
    {
      id: 'lt-bang-dash-dash-in-attribute-value',
      description: '`<!--` inside a quoted attribute value is not a comment: the following live block is kept; a real commented block is dropped.',
      weight: 2,
      run: () =>
        grade([
          {
            path: 'site/attr.html',
            content: lines(
              '<html>',
              '<body>',
              '<a href="#top" title="<!-- back to top">Top</a>',
              style('css-live-1'),
              `<!-- ${style1('css-dead-1')} -->`,
              '</body>',
              '</html>',
            ),
            live: ['css-live-1'],
            dead: ['css-dead-1'],
          },
        ]),
    },
    {
      id: 'non-markup-files-unaffected',
      description: '[guard] `<!--` in .css stylesheets and JS/TS sources (incl. Lit css``) does not hide anything there.',
      weight: 2,
      run: () =>
        grade([
          {
            path: 'styles/legacy.css',
            content: lines('<!--', `.css-live-1::-webkit-scrollbar-thumb ${DECLS}`, '-->'),
            live: ['css-live-1'],
          },
          {
            path: 'src/modal.js',
            content: lines("const marker = '<!--';", dialogJs('js-live-1', ''), "const end = '-->';"),
            live: ['js-live-1'],
          },
          {
            path: 'src/box.ts',
            content: lines(
              "import { css } from 'lit';",
              "const marker = '<!--';",
              'export const styles = css`',
              `  .css-live-1::-webkit-scrollbar-thumb ${DECLS}`,
              '`;',
              "const end = '-->';",
            ),
            live: ['css-live-1'],
          },
        ]),
    },
  ],
});
