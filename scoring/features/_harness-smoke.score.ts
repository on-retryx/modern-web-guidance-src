import { defineScorecard, lowerIsBetter } from '../lib.ts';

export default defineScorecard({
  feature: '_harness-smoke',
  title: 'Harness self-check (should always score 66.7)',
  cases: [
    { id: 'boolean-pass', description: 'true maps to full credit', weight: 1, run: () => true },
    { id: 'partial', description: 'partial credit is preserved', weight: 2, run: () => lowerIsBetter(15, 10, 20) },
    { id: 'missing-module', description: 'lazy import of a missing module scores 0, not a crash', weight: 1, run: async () => {
      // @ts-expect-error intentionally missing
      await import('../../src/does-not-exist.ts');
      return true;
    } },
    { id: 'full', description: 'numeric 1', weight: 2, run: () => 1 },
  ],
});
