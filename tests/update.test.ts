import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fetchLatestRelease, installLocation, isNewerVersion, updateRepository } from '../src/update-check.ts';

test('version comparison', () => {
  assert.equal(isNewerVersion('0.1.0', '0.2.0'), true);
  assert.equal(isNewerVersion('0.2.0', '0.2.0'), false);
  assert.equal(isNewerVersion('1.0.0', '0.9.9'), false);
  assert.equal(isNewerVersion('0.1.0-dev', '0.1.1'), true);
  assert.equal(isNewerVersion('0.1.0', 'latest'), false);
});

test('repo override is validated', () => {
  assert.equal(updateRepository({}), 'kylepantall/vpnhop');
  assert.throws(() => updateRepository({ VPNHOP_REPO: '../evil' }));
});

test('latest release comes from the redirect; no release is null', async () => {
  const redirect = (location: string) => (async () => new Response(null, { status: 302, headers: { location } })) as unknown as typeof fetch;
  assert.deepEqual(await fetchLatestRelease({}, redirect('https://github.com/kylepantall/vpnhop/releases/tag/v0.3.1')), {
    version: '0.3.1', tag: 'v0.3.1', url: 'https://github.com/kylepantall/vpnhop/releases/tag/v0.3.1',
  });
  assert.equal(await fetchLatestRelease({}, redirect('https://github.com/kylepantall/vpnhop/releases')), null);
  await assert.rejects(fetchLatestRelease({}, redirect('https://github.com/x/y/releases/tag/v1;rm')));
  await assert.rejects(fetchLatestRelease({}, (async () => new Response(null, { status: 404 })) as unknown as typeof fetch));
});

test('installLocation only recognises installer layouts', () => {
  const root = mkdtempSync(join(tmpdir(), 'vpnhop-loc-'));
  mkdirSync(join(root, 'app', 'src'), { recursive: true });
  writeFileSync(join(root, 'app', 'src', 'index.ts'), '');
  const loc = installLocation(join(root, 'app', 'src', 'index.ts'), { VPNHOP_LAUNCHER: '/b/vpnhop' });
  assert.equal(loc?.binDir, '/b');
  assert.ok(loc?.installDir.endsWith(root.split('/').pop()!));
  mkdirSync(join(root, 'repo', 'src'), { recursive: true });
  writeFileSync(join(root, 'repo', 'src', 'index.ts'), '');
  assert.equal(installLocation(join(root, 'repo', 'src', 'index.ts'), {}), null);
});
