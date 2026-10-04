/** Check-update CLI E2E with deterministic release API responses. */
import { describe, test, expect } from 'bun:test';
import { VERSION } from '../../src/version.ts';
import { isMinorOrMajorBump, parseSemver } from '../../src/commands/check-update.ts';
import { resolve } from 'node:path';

async function runCheck(args: string[], state = 'release') {
  const proc = Bun.spawn([
    process.execPath, 'run', '--preload', resolve(import.meta.dir, '../fixtures/check-update-fetch.ts'),
    'src/cli.ts', 'check-update', ...args,
  ], {
    cwd: resolve(import.meta.dir, '../..'),
    env: { ...process.env, GBRAIN_TEST_RELEASE_STATE: state },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  expect(code).toBe(0);
  expect(stderr).not.toContain('Unexpected external request');
  return stdout;
}

describe('E2E: Check-Update', () => {
  test('check-update --json reports the fixture release and changelog', async () => {
    const output = JSON.parse(await runCheck(['--json']));
    const v = parseSemver(VERSION)!;
    const latest = `${v[0]}.${v[1] + 1}.0`;
    expect(output.current_version).toBe(VERSION);
    expect(output.current_source).toBe('package-json');
    expect(output.latest_version).toBe(latest);
    expect(output.update_available).toBe(true);
    expect(output.release_url).toBe(`https://example.invalid/releases/v${latest}`);
    expect(output.changelog_diff).toContain('Fixture release notes.');
    expect(output.changelog_diff).not.toContain('Old notes.');
    expect(typeof output.upgrade_command).toBe('string');
  });

  test('check-update without --json prints human-readable output', async () => {
    expect(await runCheck([])).toContain('GBrain update available');
  });

  test('check-update --help prints usage', async () => {
    const stdout = await runCheck(['--help']);
    expect(stdout).toContain('check-update');
    expect(stdout).toContain('--json');
  });

  test('handles a no-releases API response gracefully', async () => {
    const output = JSON.parse(await runCheck(['--json'], 'none'));
    expect(output.update_available).toBe(false);
    expect(output.latest_version).toBe('');
    expect(output.error).toBe('no_releases');
  });

  test('version comparison wiring works end-to-end', () => {
    expect(isMinorOrMajorBump('0.4.0', '0.5.0')).toBe(true);
    expect(isMinorOrMajorBump('0.4.0', '0.4.1')).toBe(false);
    expect(isMinorOrMajorBump('0.4.0', '1.0.0')).toBe(true);
    expect(isMinorOrMajorBump('0.4.0', '0.4.0')).toBe(false);
  });
});
