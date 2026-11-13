import { describe, test } from 'node:test';
import assert from 'node:assert';
import { editDistance, normalizeGuideId, suggestGuideIds } from './guide-ids.ts';

describe('normalizeGuideId', () => {
  test('lowercases and trims plain IDs', () => {
    assert.strictEqual(normalizeGuideId('  Tabs '), 'tabs');
    assert.strictEqual(normalizeGuideId('scroll-snap-state-sync'), 'scroll-snap-state-sync');
  });

  test('strips category and guides/ path prefixes', () => {
    assert.strictEqual(normalizeGuideId('ui-components/tabs'), 'tabs');
    assert.strictEqual(normalizeGuideId('guides/ui-components/tabs'), 'tabs');
    assert.strictEqual(normalizeGuideId('./guides/ui-components/tabs/'), 'tabs');
    assert.strictEqual(normalizeGuideId('guides\\ui-components\\tabs'), 'tabs');
  });

  test('strips .md and /guide.md suffixes', () => {
    assert.strictEqual(normalizeGuideId('tabs.md'), 'tabs');
    assert.strictEqual(normalizeGuideId('tabs/guide.md'), 'tabs');
    assert.strictEqual(normalizeGuideId('GUIDES/UI-Components/Tabs/Guide.md'), 'tabs');
  });

  test('returns an empty string when only separators remain', () => {
    assert.strictEqual(normalizeGuideId('/'), '');
    assert.strictEqual(normalizeGuideId('///'), '');
  });
});

describe('editDistance', () => {
  test('counts insertions, deletions and substitutions', () => {
    assert.strictEqual(editDistance('', ''), 0);
    assert.strictEqual(editDistance('tabs', 'tabs'), 0);
    assert.strictEqual(editDistance('tab', 'tabs'), 1);
    assert.strictEqual(editDistance('colour', 'color'), 1);
    assert.strictEqual(editDistance('kitten', 'sitting'), 3);
  });

  test('counts an adjacent transposition as one edit', () => {
    assert.strictEqual(editDistance('mneu', 'menu'), 1);
    assert.strictEqual(editDistance('toolbra', 'toolbar'), 1);
  });
});

describe('suggestGuideIds', () => {
  const ids = [
    'tabs',
    'toolbar',
    'menu',
    'app-menus',
    'navbar',
    'navigation-drawer',
    'scroll-snap-state-sync',
    'scroll-snap-realtime-feedback',
    'scroll-progress-indicator',
    'trusted-types',
    'validate-origins',
    'verify-email-ownership',
    'css',
  ];

  test('ranks the intended ID first for common typos', () => {
    assert.strictEqual(suggestGuideIds('toolbra', ids)[0], 'toolbar');
    assert.strictEqual(suggestGuideIds('mneu', ids)[0], 'menu');
    assert.strictEqual(suggestGuideIds('trusted-type', ids)[0], 'trusted-types');
    assert.strictEqual(suggestGuideIds('validate-origin', ids)[0], 'validate-origins');
    assert.strictEqual(suggestGuideIds('navigaton-drawer', ids)[0], 'navigation-drawer');
  });

  test('matches partial IDs and missing words', () => {
    assert.strictEqual(suggestGuideIds('verify-email', ids)[0], 'verify-email-ownership');
    assert.strictEqual(suggestGuideIds('scroll-progress', ids)[0], 'scroll-progress-indicator');
    assert.strictEqual(suggestGuideIds('nav-drawer', ids)[0], 'navigation-drawer');
  });

  test('normalizes the query before comparing', () => {
    assert.strictEqual(suggestGuideIds('guides/ui-components/TOOLBRA.md', ids)[0], 'toolbar');
  });

  test('returns at most three suggestions', () => {
    const suggestions = suggestGuideIds('scroll-snap', ids);
    assert.ok(suggestions.length >= 1 && suggestions.length <= 3, `got ${suggestions.join(', ')}`);
    assert.ok(suggestions.every((id) => id.startsWith('scroll-')));
  });

  test('returns no suggestions for hopeless input', () => {
    assert.deepStrictEqual(suggestGuideIds('qwfp-zxcv', ids), []);
    assert.deepStrictEqual(suggestGuideIds('x', ids), []);
    assert.deepStrictEqual(suggestGuideIds('', ids), []);
  });
});
