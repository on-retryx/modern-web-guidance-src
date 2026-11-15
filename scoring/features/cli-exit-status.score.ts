/**
 * Scorecard: `update` / `uninstall` must report the delegated `npx skills` result.
 *
 * Contract (public CLI behaviour, src/cli/modern-web.ts):
 * - `update` and `uninstall` exit with the exit status of the `npx skills ...` child.
 * - If the child cannot be spawned (e.g. npx missing) or is killed by a signal,
 *   the CLI exits non-zero.
 * - Success paths are unchanged: exit 0 and the same npx arguments as today.
 * Tests use a fake `npx` shim on PATH, like src/cli/modern-web.test.ts.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineScorecard } from '../lib.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CLI = path.join(ROOT, 'src/cli/modern-web.ts');

let built = false;
/** The CLI loads gen/guides.json at import time; build it once (offline, ~2s). */
function ensureBuilt(): void {
  if (built) return;
  const r = spawnSync(process.execPath, ['src/build/build-guides.ts', '--target=skills-cli'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`build-guides failed: ${r.stderr.slice(0, 300)}`);
  built = true;
}

interface Run {
  status: number | null;
  args: string[] | null;
}

function runWithShim(command: string, shimBody: string | null): Run {
  ensureBuilt();
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwg-exit-'));
  const log = path.join(binDir, 'args.json');
  try {
    if (shimBody !== null) {
      fs.writeFileSync(
        path.join(binDir, 'npx'),
        `#!/bin/sh\nnode -e 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))' "${log}" "$@"\n${shimBody}\n`,
        { mode: 0o755 },
      );
    }
    const nodeDir = path.dirname(process.execPath);
    const r = spawnSync(process.execPath, [CLI, command], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        // With no shim, PATH holds only node's dir so `npx` cannot be found.
        PATH: shimBody === null ? binDir : `${binDir}:${nodeDir}:/usr/bin:/bin`,
        NO_COLOR: '1',
        DISABLE_TELEMETRY: '1',
      },
    });
    const args = fs.existsSync(log) ? (JSON.parse(fs.readFileSync(log, 'utf8')) as string[]) : null;
    return { status: r.status, args };
  } finally {
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

export default defineScorecard({
  feature: 'cli-exit-status',
  title: 'update/uninstall propagate the npx skills exit status',
  cases: [
    {
      id: 'update-propagates-failure',
      description: 'update exits with the failing child status (3)',
      weight: 5,
      run: () => {
        const r = runWithShim('update', 'exit 3');
        return r.status === 3 ? 1 : r.status !== 0 && r.status !== null ? 0.5 : 0;
      },
    },
    {
      id: 'uninstall-propagates-failure',
      description: 'uninstall exits with the failing child status (3)',
      weight: 5,
      run: () => {
        const r = runWithShim('uninstall', 'exit 3');
        return r.status === 3 ? 1 : r.status !== 0 && r.status !== null ? 0.5 : 0;
      },
    },
    {
      id: 'update-other-status',
      description: 'update exits 1 when the child exits 1 (status passed through, not hardcoded)',
      weight: 2,
      run: () => runWithShim('update', 'exit 1').status === 1,
    },
    {
      id: 'update-spawn-error',
      description: 'update exits non-zero when npx cannot be spawned',
      weight: 3,
      run: () => {
        const r = runWithShim('update', null);
        return r.status !== 0 && r.status !== null;
      },
    },
    {
      id: 'uninstall-spawn-error',
      description: 'uninstall exits non-zero when npx cannot be spawned',
      weight: 3,
      run: () => {
        const r = runWithShim('uninstall', null);
        return r.status !== 0 && r.status !== null;
      },
    },
    {
      id: 'update-killed-by-signal',
      description: 'update exits non-zero when the child is killed by a signal',
      weight: 2,
      run: () => {
        const r = runWithShim('update', 'kill -TERM $$');
        return r.status !== 0 && r.status !== null;
      },
    },
    {
      id: 'guard-update-success',
      description: 'guard: successful update exits 0 and calls `npx -y skills update`',
      weight: 2,
      run: () => {
        const r = runWithShim('update', 'exit 0');
        return r.status === 0 && JSON.stringify(r.args?.slice(0, 3)) === JSON.stringify(['-y', 'skills', 'update']);
      },
    },
    {
      id: 'guard-uninstall-success',
      description: 'guard: successful uninstall exits 0 and calls `npx -y skills remove`',
      weight: 2,
      run: () => {
        const r = runWithShim('uninstall', 'exit 0');
        return r.status === 0 && JSON.stringify(r.args?.slice(0, 3)) === JSON.stringify(['-y', 'skills', 'remove']);
      },
    },
  ],
});
