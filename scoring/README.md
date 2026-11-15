# Scoring harness (fork-only)

Graded (0–100) scorecards and a review loop used by the RetryX fork to develop
upstream-contributable changes. **This folder is never part of an upstream PR**;
feature commits are cherry-picked onto clean branches without `scoring/`.

## Roles and rules

1. **Test author** writes `scoring/features/<feature>.score.ts` *before* any
   implementation exists. Cases are weighted and give partial credit
   (precision/recall, ratios, thresholds), not just pass/fail. Code under test
   is imported lazily inside each case. The scorecard must score low on the
   unmodified code (it measures the missing feature), then it is locked:
   `node scoring/cli.ts lock <feature>`.
2. **Implementer** changes `src/`, `guides/` etc. until the scorecard is high.
   It must not edit anything under `scoring/` (locks enforce this) and must
   not special-case scorecard inputs. It writes normal repo unit tests
   (`*.test.ts`) for its change too.
3. **Reviewer** (independent agent) verifies and scores:
   ```sh
   node scoring/cli.ts verify            # locks intact
   node scoring/cli.ts run <feature> --verbose
   node scoring/cli.ts gates             # typecheck + lint + unit tests vs baseline-failures.json
   # read the diff, probe edge cases the scorecard misses, judge code quality,
   # upstream-readiness and coding standards → review score 0–100
   node scoring/cli.ts record <feature> --review <score> --note "<one line>"
   ```
   `record` exits 0 when the final score beats the feature's previous best:
   the reviewer then commits (author RetryX, no co-author trailer) including
   `scoring/history.jsonl`. Exit 3 means no improvement: no commit, feedback
   goes back to the implementer.

## Final score

`final = (0.7 × scorecard + 0.3 × review) × (gates pass ? 1 : 0.5)`

`node scoring/cli.ts status` prints the best final score per feature and the
project score (mean over feature scorecards; `_`-prefixed self-checks are
excluded).
