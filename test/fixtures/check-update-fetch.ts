// Preload only in spawned check-update E2E processes. No live API requests.
import { VERSION } from '../../src/version.ts';
import { parseSemver } from '../../src/core/semver.ts';
const v = parseSemver(VERSION)!;
const latest = `${v[0]}.${v[1] + 1}.0`;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === 'https://api.github.com/repos/garrytan/gbrain/releases/latest') {
    if (process.env.GBRAIN_TEST_RELEASE_STATE === 'none') {
      return new Response('{}', { status: 404 });
    }
    return Response.json({
      tag_name: `v${latest}`, published_at: '2026-01-01T00:00:00Z',
      html_url: `https://example.invalid/releases/v${latest}`,
    });
  }
  if (url === 'https://raw.githubusercontent.com/garrytan/gbrain/master/CHANGELOG.md') {
    return new Response(`## [${latest}]\nFixture release notes.\n## [${VERSION}]\nOld notes.\n`);
  }
  throw new Error(`Unexpected external request in check-update fixture: ${url}`);
}) as typeof fetch;
