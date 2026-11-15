/**
 * Scorecard: `legacy-scan --max-files <n>` (#3596).
 *
 * Contract (public behaviour of runAnalyzeCli, src/analyzing/cli.ts):
 * - `--max-files <n>` / `--max-files=<n>` caps the number of files collected in a
 *   directory scan, replacing the built-in default (5000).
 * - The value must be a positive integer; anything else exits 1 with an error that
 *   names the option, in text and --json modes.
 * - The CLI flag wins over the programmatic `maxFiles` option.
 * - `--help` documents the option. Without the flag, behaviour is unchanged.
 * Fixture: N HTML files that each produce exactly one finding (password form without
 * autocomplete, as in cli.test.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineScorecard, mean } from '../lib.ts';
import { ANALYZE_CLI_HELP, runAnalyzeCli, type AnalyzeJsonOutput } from '../../src/analyzing/cli.ts';

const FILES = 8;
let fixture: string | null = null;
function dir(): string {
  if (fixture) return fixture;
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mwg-maxfiles-'));
  for (let i = 1; i <= FILES; i++) {
    fs.writeFileSync(
      path.join(fixture, `form${i}.html`),
      `<form action="/login${i}" method="POST">\n  <input type="password" name="password">\n</form>`,
    );
  }
  process.on('exit', () => fs.rmSync(fixture!, { recursive: true, force: true }));
  return fixture;
}

async function findings(args: string[], maxFiles?: number): Promise<number | null> {
  const res = await runAnalyzeCli([dir(), '--json', ...args], maxFiles === undefined ? undefined : { maxFiles });
  if (res.exitCode !== 0) return null;
  try {
    return (JSON.parse(res.output) as AnalyzeJsonOutput).totalFindings;
  } catch {
    return null;
  }
}

async function rejects(value: string): Promise<number> {
  const text = await runAnalyzeCli([dir(), '--max-files', value]);
  const json = await runAnalyzeCli([dir(), '--json', `--max-files=${value}`]);
  let jsonError = '';
  try {
    jsonError = (JSON.parse(json.output) as AnalyzeJsonOutput).error ?? '';
  } catch {
    /* not JSON */
  }
  // The error must be about the value, not strict parseArgs rejecting an unknown flag.
  const aboutValue = (msg: string) => /max-files/.test(msg) && !/unknown option/i.test(msg);
  return mean([
    text.exitCode === 1,
    aboutValue(text.stderr || text.output),
    json.exitCode === 1,
    aboutValue(jsonError),
  ]);
}

export default defineScorecard({
  feature: 'max-files',
  title: 'legacy-scan --max-files <n>',
  cases: [
    {
      id: 'caps-files',
      description: '`--max-files 3` scans 3 of 8 files (3 findings)',
      weight: 5,
      run: async () => (await findings(['--max-files', '3'])) === 3,
    },
    {
      id: 'equals-syntax',
      description: '`--max-files=5` scans 5 files',
      weight: 2,
      run: async () => (await findings(['--max-files=5'])) === 5,
    },
    {
      id: 'raises-programmatic-cap',
      description: 'the flag overrides a programmatic maxFiles (2 → flag 6 gives 6)',
      weight: 3,
      run: async () => (await findings(['--max-files', '6'], 2)) === 6,
    },
    {
      id: 'rejects-zero',
      description: '`--max-files 0` is rejected (exit 1, error names the option, text + JSON)',
      weight: 2,
      run: () => rejects('0'),
    },
    {
      id: 'rejects-negative',
      description: '`--max-files -2` is rejected',
      weight: 1,
      run: () => rejects('-2'),
    },
    {
      id: 'rejects-non-integer',
      description: '`--max-files abc` and `1.5` are rejected',
      weight: 2,
      run: async () => mean([await rejects('abc'), await rejects('1.5')]),
    },
    {
      id: 'help-documents-option',
      description: '--help lists `--max-files <n>`',
      weight: 2,
      run: () => /--max-files <n>/.test(ANALYZE_CLI_HELP),
    },
    {
      id: 'guard-default-unchanged',
      description: 'guard: without the flag all 8 files are scanned',
      weight: 2,
      run: async () => (await findings([])) === FILES,
    },
    {
      id: 'guard-programmatic-still-works',
      description: 'guard: programmatic maxFiles still applies without the flag',
      weight: 1,
      run: async () => (await findings([], 4)) === 4,
    },
  ],
});
