/**
 * Scorecard: macro-referenced web features must be listed in `web-feature-ids`.
 *
 * Problem
 * -------
 * A guide's body can reference web features through transclusion / status
 * macros, but feature gating (`getGuideVolatileFeatures`,
 * `getGuideOriginTrials` in src/core/feature-gates.ts, fed by
 * `processGuideInventory`) only reads the frontmatter `web-feature-ids`. A
 * gated (volatile / origin-trial) feature pulled in by a macro can therefore
 * ship ungated. project-guides/SKILL.md already requires "Include ALL
 * features referenced in the guide body"; nothing enforces it.
 *
 * Contract measured here (implementation-agnostic; only public entry points)
 * --------------------------------------------------------------------------
 * Errors are collected with the same entry point `src/authoring/guides-integrity.test.ts`
 * uses: `processGuideInventory([inventoryGuide(dir)]).errors` (which runs
 * `validateGuide`), so the check may live in `validateGuide`, in
 * `processGuideInventory`, or in a helper either one calls. No new function
 * name is required.
 *
 * 1. For a guide whose body (outside `{# ... #}` maintainer comments)
 *    references a feature id that is absent from its `web-feature-ids`
 *    frontmatter, validation reports an error that names the missing id
 *    verbatim and the guide (its slug or path). Macros that reference a
 *    feature id (first argument, either quote style, any spacing):
 *      {{ BASELINE_STATUS("<id>") }}, {{ BASELINE_STATUS("<id>", "<bcd.key>") }}
 *      {{ FEATURE("<id>") }}, {{ FEATURE("<id>", "<section>") }}
 *      {{ FEATURE_FALLBACKS("<id>") }}, {{ FEATURE_ISSUES("<id>") }}
 *      {{ INCLUDE("features/<id>.md") }}, {{ INCLUDE("features/<id>.md#<section>") }}
 *    (i.e. the ids `getTranscludedFeatureIds()` extracts, plus BASELINE_STATUS).
 * 2. One error per missing id per guide, not one per macro occurrence.
 * 3. No such error when every referenced id is listed, for macros inside
 *    `{# ... #}` comments, or for macros whose argument is not a feature id
 *    (GUIDE_REF, INCLUDE of a non-`features/` path).
 * 4. `tmp-` ids follow the existing convention (validateFeature,
 *    pending-web-features.json): frontmatter and macros use the full
 *    `tmp-<slug>` id verbatim, so `FEATURE("tmp-x")` requires `tmp-x` in
 *    the frontmatter and the error names `tmp-x` (prefix included).
 *    `stripTmpPrefix` is only for GitHub issue matching, not for this check.
 * 5. The five current offenders get exactly their missing ids added to the
 *    frontmatter (no ids removed, no extra ids, no other frontmatter key or
 *    guide body change), and the whole repo then validates with zero errors.
 *
 * Fixtures are written to a fresh os.tmpdir() directory (outside guides/, so
 * the category check does not apply), mirroring guide-validation.test.ts.
 * Each fixture is otherwise valid: with its missing ids added to the
 * frontmatter it validates with zero errors on the unmodified code, so any
 * error it produces is attributed to this feature.
 *
 * Cases whose "correct" answer is "no error" are gated on the detector
 * working (otherwise they would pass on the unmodified code without
 * measuring anything). Only `regression-guards` is ungated.
 *
 * Deterministic, offline, < 10 s.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineScorecard, mean, ratio, lowerIsBetter } from '../lib.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (rel: string) => path.join(ROOT, 'src', rel);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

export interface Fixture {
  /** Guide slug (directory name and frontmatter `name`). Unique per fixture. */
  slug: string;
  /** Ids listed in the frontmatter. */
  ids: string[];
  /** Ids referenced by macros but intentionally absent from `ids`. */
  missing: string[];
  /** Markdown body after the H1. */
  body: string;
}

interface FixtureResult {
  errors: string[];
  prepared: Array<{ name: string; featureIds: string[]; volatileFeatures: Array<{ id: string }> }>;
}

function renderGuide(f: Fixture, ids: string[]): string {
  const idLines = ids.length ? `\n${ids.map(id => `  - ${id}`).join('\n')}` : ' []';
  return `---\nname: ${f.slug}\ndescription: Fixture guide for macro feature id validation.\nweb-feature-ids:${idLines}\n---\n\n# Fixture ${f.slug}\n\n${f.body.trim()}\n`;
}

/** Validate a fixture through processGuideInventory (as guides-integrity does). */
export async function validateFixture(f: Fixture, ids: string[] = f.ids): Promise<FixtureResult> {
  const gv = await import(src('core/guide-validation.ts'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mwg-macro-ids-'));
  const dir = path.join(tmp, f.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'guide.md'), renderGuide(f, ids));
  const origError = console.error;
  console.error = () => {};
  try {
    const result = gv.processGuideInventory([gv.inventoryGuide(dir)]);
    return { errors: [...result.errors], prepared: result.preparedGuides };
  } finally {
    console.error = origError;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `text` contains `id` as a whole token (ids are [a-z0-9-]). */
export function namesId(text: string, id: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRe(id)}($|[^A-Za-z0-9_-])`).test(text);
}

/**
 * Credit for "an error is reported for missing `id` in guide `slug`":
 *   no error at all -> 0; error(s) but none names the id -> 0.3;
 *   names the id but not the guide -> 0.8; names both -> 1.
 */
function detectCredit(errors: string[], id: string, slug: string): number {
  if (errors.length === 0) return 0;
  const naming = errors.filter(e => namesId(e, id));
  if (naming.length === 0) return 0.3;
  return naming.some(e => e.includes(slug)) ? 1 : 0.8;
}

async function detectFixture(f: Fixture): Promise<number> {
  const { errors } = await validateFixture(f);
  return mean(f.missing.map(id => detectCredit(errors, id, f.slug)));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const FIXTURES = {
  baselineStatus: {
    slug: 'mfx-baseline-status',
    ids: ['light-dark'],
    missing: ['scrollbar-color'],
    body: `Theme colors.\n\n{{ BASELINE_STATUS("light-dark") }}\n\nScrollbar colors.\n\n{{ BASELINE_STATUS("scrollbar-color") }}`,
  },
  feature: {
    slug: 'mfx-feature',
    ids: ['light-dark'],
    missing: ['customizable-select'],
    body: `Theme colors.\n\n{{ BASELINE_STATUS("light-dark") }}\n\nStyling the picker:\n\n{{ FEATURE("customizable-select", "usage") }}`,
  },
  featureFallbacks: {
    slug: 'mfx-feature-fallbacks',
    ids: ['light-dark'],
    missing: ['popover'],
    body: `Theme colors.\n\n{{ BASELINE_STATUS("light-dark") }}\n\nShow the panel as a popover.\n\n{{ FEATURE_FALLBACKS("popover") }}`,
  },
  featureIssues: {
    slug: 'mfx-feature-issues',
    ids: ['light-dark'],
    missing: ['focusgroup'],
    body: `Theme colors.\n\n{{ BASELINE_STATUS("light-dark") }}\n\nArrow-key navigation.\n\n{{ FEATURE_ISSUES("focusgroup") }}`,
  },
  includeBare: {
    slug: 'mfx-include-bare',
    ids: ['light-dark'],
    missing: ['temporal'],
    body: `Theme colors.\n\n{{ BASELINE_STATUS("light-dark") }}\n\nDates.\n\n{{ INCLUDE("features/temporal.md") }}`,
  },
  includeSection: {
    slug: 'mfx-include-section',
    ids: ['light-dark'],
    missing: ['accent-color'],
    body: `Theme colors.\n\n{{ BASELINE_STATUS("light-dark") }}\n\nControl tint.\n\n{{ INCLUDE("features/accent-color.md#fallbacks") }}`,
  },
  bcdKey: {
    slug: 'mfx-bcd-key',
    ids: ['light-dark'],
    missing: ['scrollbar-color'],
    body: `Theme colors.\n\n{{ BASELINE_STATUS("light-dark") }}\n\nScrollbar colors.\n\n{{ BASELINE_STATUS("scrollbar-color", "css.properties.scrollbar-color") }}`,
  },
  syntaxVariants: {
    slug: 'mfx-syntax-variants',
    ids: ['color-scheme'],
    missing: ['light-dark', 'popover'],
    body: `Scheme.\n\n{{ BASELINE_STATUS("color-scheme") }}\n\nTheme colors.\n\n{{BASELINE_STATUS('light-dark')}}\n\nPanel.\n\n{{   FEATURE_FALLBACKS( 'popover' )   }}`,
  },
  multiMissing: {
    slug: 'mfx-multi-missing',
    ids: ['color-scheme'],
    missing: ['light-dark', 'popover', 'scrollbar-color', 'focusgroup'],
    body: [
      'Scheme.', '{{ BASELINE_STATUS("color-scheme") }}',
      'Theme colors.', '{{ BASELINE_STATUS("light-dark") }}',
      'Panel.', '{{ FEATURE_FALLBACKS("popover") }}',
      'Scrollbars.', '{{ FEATURE("scrollbar-color", "usage") }}',
      'Arrow keys.', '{{ FEATURE_ISSUES("focusgroup") }}',
    ].join('\n\n'),
  },
  tmpId: {
    slug: 'mfx-tmp-id',
    ids: ['light-dark'],
    missing: ['tmp-cross-origin-storage'],
    body: `Theme colors.\n\n{{ BASELINE_STATUS("light-dark") }}\n\nShared caches.\n\n{{ FEATURE("tmp-cross-origin-storage") }}`,
  },
  volatile: {
    slug: 'mfx-volatile',
    ids: ['light-dark'],
    missing: ['text-decoration-skip-spaces'],
    body: `Theme colors.\n\n{{ BASELINE_STATUS("light-dark") }}\n\nUnderline gaps.\n\n{{ BASELINE_STATUS("text-decoration-skip-spaces") }}`,
  },
  allPresent: {
    slug: 'mfx-all-present',
    ids: ['scrollbar-color', 'customizable-select', 'popover', 'focusgroup', 'temporal', 'accent-color', 'light-dark'],
    missing: [],
    body: [
      'Scrollbars.', '{{ BASELINE_STATUS("scrollbar-color", "css.properties.scrollbar-color") }}',
      'Picker.', '{{ FEATURE("customizable-select", "usage") }}',
      'Panel.', '{{ FEATURE_FALLBACKS("popover") }}',
      'Arrow keys.', '{{ FEATURE_ISSUES("focusgroup") }}',
      'Dates.', '{{ INCLUDE("features/temporal.md") }}',
      'Tint.', '{{ INCLUDE("features/accent-color.md#fallbacks") }}',
      'Theme.', "{{BASELINE_STATUS('light-dark')}}",
    ].join('\n\n'),
  },
  comments: {
    slug: 'mfx-comments',
    ids: ['light-dark'],
    missing: [],
    body: [
      'Theme colors.',
      '{{ BASELINE_STATUS("light-dark") }}',
      '{# {{ BASELINE_STATUS("scrollbar-color") }} #}',
      'Inline note {# see {{ FEATURE_FALLBACKS("popover") }} later #} continues here.',
      '{#\nMaintainer note: once stable, add\n{{ FEATURE_ISSUES("focusgroup") }}\nand {{ INCLUDE("features/temporal.md") }}\n#}',
      'Done.',
    ].join('\n\n'),
  },
  nonFeatureMacros: {
    slug: 'mfx-non-feature-macros',
    ids: ['light-dark'],
    missing: [],
    body: [
      'Theme colors.',
      '{{ BASELINE_STATUS("light-dark") }}',
      'For form basics, see {{ GUIDE_REF("forms") }}.',
      'Sizing:',
      '{{ INCLUDE("guides/visual-design/typography/guide.md#responsive-typography") }}',
    ].join('\n\n'),
  },
  duplicates: {
    slug: 'mfx-duplicates',
    ids: ['light-dark'],
    missing: ['scrollbar-color', 'popover'],
    body: [
      'Theme colors.', '{{ BASELINE_STATUS("light-dark") }}', '{{ FEATURE_FALLBACKS("light-dark") }}',
      'Scrollbars.', '{{ BASELINE_STATUS("scrollbar-color") }}', '{{ FEATURE("scrollbar-color", "usage") }}', '{{ FEATURE_ISSUES("scrollbar-color") }}',
      'Panel.', '{{ BASELINE_STATUS("popover") }}', '{{ FEATURE_FALLBACKS("popover") }}',
    ].join('\n\n'),
  },
} satisfies Record<string, Fixture>;

// ---------------------------------------------------------------------------
// Detector gate (memoized): does validation flag a missing macro id at all?
// ---------------------------------------------------------------------------

let detectorPromise: Promise<boolean> | undefined;
function detectorWorks(): Promise<boolean> {
  detectorPromise ??= (async () => {
    for (const f of [FIXTURES.featureFallbacks, FIXTURES.baselineStatus, FIXTURES.feature, FIXTURES.includeBare]) {
      try {
        const { errors } = await validateFixture(f);
        if (errors.some(e => namesId(e, f.missing[0]))) return true;
      } catch {
        // keep trying the other fixtures
      }
    }
    return false;
  })();
  return detectorPromise;
}

async function gatedNoErrors(f: Fixture): Promise<number> {
  if (!(await detectorWorks())) return 0;
  const { errors } = await validateFixture(f);
  return errors.length === 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Real repo data (hardcoded "before" state at the commit this card was locked)
// ---------------------------------------------------------------------------

interface RealGuide {
  rel: string;
  name: string;
  description: string;
  before: string[];
  missing: string[];
  bodySha256: string;
}

const REAL_GUIDES: RealGuide[] = [
  {
    rel: 'guides/visual-design/contrast-color/guide.md',
    name: 'contrast-color',
    description: 'Select a readable text color with sufficient contrast on a dynamic background color.',
    before: ['contrast-color'],
    missing: ['relative-color', 'text-stroke-fill', 'paint-order', 'svg-filters'],
    bodySha256: 'ce6601287b8b0825703262e9731a83c56d2eeb57723ed9414dbfdbef55e4605f',
  },
  {
    rel: 'guides/ui-components/spinner/guide.md',
    name: 'spinner',
    description: 'Build a loading spinner that communicates busy state to all users, respects reduced-motion preferences, and animates efficiently.',
    before: ['prefers-reduced-motion', 'conic-gradients', 'progress'],
    missing: ['registered-custom-properties', 'background-clip-border-area'],
    bodySha256: '7f67e15f15991c9177009ba52568238acf12b56d757dbee988a0e37419a597dd',
  },
  {
    rel: 'guides/ui-components/progress-ring/guide.md',
    name: 'progress-ring',
    description: 'Build a progress ring component that visually represents the completion status of a task or process, with support for content in the center and brand-consistent styling.',
    before: ['progress', 'conic-gradients', 'masks', 'registered-custom-properties'],
    missing: ['background-clip-border-area', 'attr'],
    bodySha256: '80f247dd0c7c10d97ba3e791b88146d9e926382bc17bb13c782c3e3b2418986c',
  },
  {
    rel: 'guides/visual-design/dark-mode/guide.md',
    name: 'dark-mode',
    description: "Implement dark mode support in a way that respects the user's light/dark theme preference and adapts browser UI (e.g. scrollbars, form controls, etc)",
    before: ['color-scheme', 'prefers-color-scheme', 'light-dark', 'light-dark-image', 'image-function', 'accent-color'],
    missing: ['scrollbar-color'],
    bodySha256: '4630f59139e42ecc49e71a3d5cd7635b3815ad9065fe8ae32a74f03793ac0b5c',
  },
  {
    rel: 'guides/ui-behaviors/scroll-snap-realtime-feedback/guide.md',
    name: 'scroll-snap-realtime-feedback',
    description: 'Provide real-time visual feedback in linked UI elements while a user scrolls through snap-aligned content, before the scroll gesture completes.',
    before: ['scroll-snap-events', 'scroll-snap'],
    missing: ['focusgroup'],
    bodySha256: '66ff74700e7d2e94901735f773c88f5a5f97efcca5942e28f93a825c96322912',
  },
];

async function readRealGuide(g: RealGuide): Promise<{ data: Record<string, unknown>; ids: string[]; body: string }> {
  const { default: matter } = await import('@11ty/gray-matter');
  const raw = fs.readFileSync(path.join(ROOT, g.rel), 'utf8');
  const parsed = matter(raw);
  const data = structuredClone(parsed.data) as Record<string, unknown>;
  const ids = Array.isArray(data['web-feature-ids']) ? (data['web-feature-ids'] as unknown[]).map(String) : [];
  return { data, ids, body: parsed.content };
}

let repoValidation: Promise<string[]> | undefined;
/** Full-repo validation errors, exactly as guides-integrity runs it (memoized). */
function repoErrors(): Promise<string[]> {
  repoValidation ??= (async () => {
    const gv = await import(src('core/guide-validation.ts'));
    const origError = console.error;
    console.error = () => {};
    try {
      return [...gv.processGuideInventory(gv.scanAllGuides()).errors] as string[];
    } finally {
      console.error = origError;
    }
  })();
  return repoValidation;
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

export default defineScorecard({
  feature: 'macro-feature-ids',
  title: 'Macro-referenced web features must be listed in web-feature-ids',
  cases: [
    // ---- Detection, one case per macro type ------------------------------
    {
      id: 'detect-baseline-status',
      description: 'BASELINE_STATUS("<id>") with <id> missing from frontmatter -> error naming the id and the guide',
      weight: 8,
      run: () => detectFixture(FIXTURES.baselineStatus),
    },
    {
      id: 'detect-feature',
      description: 'FEATURE("<id>", "<section>") with <id> missing from frontmatter -> error naming the id and the guide',
      weight: 8,
      run: () => detectFixture(FIXTURES.feature),
    },
    {
      id: 'detect-feature-fallbacks',
      description: 'FEATURE_FALLBACKS("<id>") with <id> missing from frontmatter -> error naming the id and the guide',
      weight: 8,
      run: () => detectFixture(FIXTURES.featureFallbacks),
    },
    {
      id: 'detect-feature-issues',
      description: 'FEATURE_ISSUES("<id>") with <id> missing from frontmatter -> error naming the id and the guide',
      weight: 5,
      run: () => detectFixture(FIXTURES.featureIssues),
    },
    {
      id: 'detect-include-features-path',
      description: 'INCLUDE("features/<id>.md") and INCLUDE("features/<id>.md#section") with <id> missing -> error naming the id (mean of both forms)',
      weight: 8,
      run: async () => mean([await detectFixture(FIXTURES.includeBare), await detectFixture(FIXTURES.includeSection)]),
    },
    {
      id: 'detect-baseline-status-bcd-key',
      description: 'BASELINE_STATUS("<id>", "<bcd.key>"): the feature id (first argument) is checked and named, not the BCD key',
      weight: 4,
      run: () => detectFixture(FIXTURES.bcdKey),
    },
    {
      id: 'detect-quote-and-spacing-variants',
      description: "Single quotes and unusual spacing ({{BASELINE_STATUS('x')}}, {{   FEATURE_FALLBACKS( 'y' )   }}) are recognized like MACRO_PATTERN/parseArguments do",
      weight: 4,
      run: () => detectFixture(FIXTURES.syntaxVariants),
    },
    {
      id: 'detect-multiple-missing-in-one-guide',
      description: 'A guide missing 4 ids across different macro types: credit = mean per-id detection credit (every missing id must be named)',
      weight: 6,
      run: () => detectFixture(FIXTURES.multiMissing),
    },
    {
      id: 'detect-tmp-prefixed-id',
      description: 'FEATURE("tmp-<slug>") missing -> error naming the full tmp- id (0.5 if only the stripped slug is named); with the tmp- id listed -> no error',
      weight: 5,
      run: async () => {
        const f = FIXTURES.tmpId;
        const { errors } = await validateFixture(f);
        const fullId = f.missing[0];
        const stripped = fullId.replace(/^tmp-/, '');
        let detect = detectCredit(errors, fullId, f.slug);
        if (detect <= 0.3 && errors.some(e => namesId(e, stripped))) detect = 0.5;
        if (detect === 0) return 0;
        const fixed = await validateFixture(f, [...f.ids, fullId]);
        return mean([detect, fixed.errors.length === 0]);
      },
    },
    {
      id: 'detect-volatile-feature-via-macro',
      description: 'Motivating case: a volatile feature referenced only by BASELINE_STATUS is flagged; once listed, processGuideInventory gates it (volatileFeatures)',
      weight: 4,
      run: async () => {
        const f = FIXTURES.volatile;
        const detect = await detectFixture(f);
        if (detect === 0) return 0;
        const fixed = await validateFixture(f, [...f.ids, ...f.missing]);
        const gated = fixed.errors.length === 0 &&
          fixed.prepared.some(p => p.volatileFeatures.some(v => v.id === f.missing[0]));
        return mean([detect, gated]);
      },
    },

    // ---- Precision (gated on the detector working) -----------------------
    {
      id: 'no-error-when-all-present',
      description: 'Every macro type referencing only listed ids -> zero errors (gated on detection working)',
      weight: 7,
      run: () => gatedNoErrors(FIXTURES.allPresent),
    },
    {
      id: 'ignores-macros-in-maintainer-comments',
      description: 'Macros inside {# ... #} (own line, inline, multi-line) referencing unlisted ids -> zero errors (gated)',
      weight: 6,
      run: () => gatedNoErrors(FIXTURES.comments),
    },
    {
      id: 'ignores-non-feature-macros',
      description: 'GUIDE_REF("forms") and INCLUDE of a guide section (non-features/ path) are not treated as feature ids -> zero errors (gated)',
      weight: 4,
      run: () => gatedNoErrors(FIXTURES.nonFeatureMacros),
    },
    {
      id: 'one-error-per-missing-id',
      description: 'Ids referenced several times: each missing id is named by exactly one error (per-id credit 1/count, 0 if unnamed); listed id referenced twice adds no error',
      weight: 6,
      run: async () => {
        const f = FIXTURES.duplicates;
        const { errors } = await validateFixture(f);
        const perId = f.missing.map(id => {
          const n = errors.filter(e => namesId(e, id)).length;
          return n === 0 ? 0 : 1 / n;
        });
        // Errors that name none of the missing ids are spurious here.
        const spurious = errors.filter(e => !f.missing.some(id => namesId(e, id))).length;
        return mean(perId) * (spurious === 0 ? 1 : 0.5);
      },
    },

    // ---- Real repository --------------------------------------------------
    {
      id: 'real-guides-list-missing-ids',
      description: 'The 5 offending guides now list their macro-referenced ids: credit = fraction of the 10 missing ids present in frontmatter',
      weight: 10,
      run: async () => {
        let hits = 0;
        let total = 0;
        for (const g of REAL_GUIDES) {
          const { ids } = await readRealGuide(g);
          for (const id of g.missing) {
            total++;
            if (ids.includes(id)) hits++;
          }
        }
        return ratio(hits, total);
      },
    },
    {
      id: 'real-guides-no-frontmatter-churn',
      description: 'Per fixed guide (all missing ids added): id set == before ∪ missing (0.5), other frontmatter keys unchanged (0.25), body byte-identical (0.25); unfixed guide = 0',
      weight: 6,
      run: async () => {
        const perGuide: number[] = [];
        for (const g of REAL_GUIDES) {
          const { data, ids, body } = await readRealGuide(g);
          const after = new Set(ids);
          if (!g.missing.every(id => after.has(id))) {
            perGuide.push(0);
            continue;
          }
          const expected = new Set([...g.before, ...g.missing]);
          const exactIds = after.size === expected.size && [...expected].every(id => after.has(id)) && ids.length === after.size;
          const { 'web-feature-ids': _ids, ...rest } = data;
          const otherKeysSame = JSON.stringify(rest) === JSON.stringify({ name: g.name, description: g.description });
          const bodySame = createHash('sha256').update(body).digest('hex') === g.bodySha256;
          perGuide.push((exactIds ? 0.5 : 0) + (otherKeysSame ? 0.25 : 0) + (bodySame ? 0.25 : 0));
        }
        return mean(perGuide);
      },
    },
    {
      id: 'real-repo-validates-clean',
      description: 'With the check active (gated on detection), processGuideInventory(scanAllGuides()) reports zero errors (full credit at 0, none at >= 10)',
      weight: 8,
      run: async () => {
        if (!(await detectorWorks())) return 0;
        const errors = await repoErrors();
        return lowerIsBetter(errors.length, 0, 10);
      },
    },

    // ---- Regression guard (ungated; may pass on unmodified code) ---------
    {
      id: 'regression-guards',
      description: 'Existing behavior kept: commented-out macro with unknown id still yields no errors; macro-free guide with empty ids is clean; the 5 guides still parse with valid ids and pass transclusion checks',
      weight: 3,
      run: async () => {
        const checks: boolean[] = [];
        // Mirrors guide-validation.test.ts "ignores macros ... inside {# ... #} comments".
        const commented = await validateFixture({
          slug: 'mfx-regression-comment',
          ids: [],
          missing: [],
          body: 'Valid guide content.\n\n{# {{ BASELINE_STATUS("non-existent-feature-xyz") }} #}',
        });
        checks.push(commented.errors.length === 0);
        const plain = await validateFixture({ slug: 'mfx-regression-plain', ids: [], missing: [], body: 'Plain content with no macros.' });
        checks.push(plain.errors.length === 0);

        const { validateFeature } = await import(src('core/baseline.ts'));
        const { replaceMacros, MACRO_PATTERN } = await import(src('core/macros.ts'));
        for (const g of REAL_GUIDES) {
          const { ids, body } = await readRealGuide(g);
          const guidePath = path.join(ROOT, g.rel);
          const idsValid = ids.length > 0 && ids.every(id => validateFeature(id).isValid) && new Set(ids).size === ids.length;
          let transclusionOk = true;
          for (const m of body.matchAll(MACRO_PATTERN)) {
            if (!['INCLUDE', 'FEATURE', 'FEATURE_FALLBACKS'].includes(m[1])) continue;
            try {
              if (!replaceMacros(m[0], guidePath).trim()) transclusionOk = false;
            } catch {
              transclusionOk = false;
            }
          }
          checks.push(idsValid && transclusionOk);
        }
        return mean(checks);
      },
    },
  ],
});
