// Regression test for the npm-workspaces cwd bug: `npm run dev` sets cwd to
// packages/server, so a naive `dotenv/config` (which loads `${cwd}/.env`)
// silently misses the repo-root .env and the AI key never gets read. See
// env.ts — resolution must be anchored to this module's own file location,
// not process.cwd().
//
// Checked against .env.example + root package.json (both committed) rather
// than the gitignored .env itself, so this passes on a fresh clone / CI.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readAppVersion, rootEnvPath } from '../env.js';

function assertIsRepoRoot(dir: string) {
  expect(existsSync(join(dir, '.env.example'))).toBe(true);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  expect(pkg.workspaces).toBeDefined();
}

describe('rootEnvPath', () => {
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
  });
  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('resolves to <repo-root>/.env, not packages/server/.env', () => {
    const path = rootEnvPath();
    expect(basename(path)).toBe('.env');
    assertIsRepoRoot(dirname(path));
  });

  it('is unaffected by process.cwd() (the bug this guards against)', () => {
    const fromOriginalCwd = rootEnvPath();
    process.chdir(dirname(dirname(process.cwd()))); // hop up a couple levels, like npm workspaces do
    const fromElsewhere = rootEnvPath();
    expect(fromElsewhere).toBe(fromOriginalCwd);
    assertIsRepoRoot(dirname(fromElsewhere));
  });
});

describe('readAppVersion', () => {
  it('reads the real semver from the repo-root package.json', () => {
    const repoRoot = dirname(rootEnvPath()); // proven to be the repo root above
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(readAppVersion()).toBe(rootPkg.version);
    expect(readAppVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
