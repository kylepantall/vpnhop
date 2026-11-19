import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { sessionProfile, runSessionRequest } from '../src/session.ts';
import { rewriteOvpn } from '../src/stage.ts';

const config = (allowHosts = ['example.internal']) => parseConfig(JSON.stringify({
  profiles: { work: { type: 'wireguard', config: { keyhop: 'VPNHOP_WORK_CONFIG' }, allowHosts } },
}), '/config.json');

const request = { profile: 'work', url: 'https://example.internal/status' };
const values = { VPNHOP_WORK_CONFIG: 'test-key' };

test('a plan only hands the matching profile its approved values and uses a single verified HTTP target', async () => {
  const selected = config();
  const { profileHash, secretNames } = sessionProfile(selected, 'work');
  assert.deepEqual(secretNames, ['VPNHOP_WORK_CONFIG']);
  let called = false;
  await runSessionRequest(selected, { profileHash, request, values }, async (received, keyhop, http) => {
    called = true;
    assert.equal(received, selected);
    assert.deepEqual(await keyhop.get(secretNames, 'Connect'), values);
    await assert.rejects(keyhop.get(['OTHER'], 'Connect'), /outside this plan/);
    assert.equal(http.followRedirects, false);
    assert.equal(http.insecure, false);
    assert.equal(http.maxBodyBytes, 64 << 10);
    return { url: http.url, status: 200, headers: {}, body: 'healthy', bodyEncoding: 'utf8', truncated: false, timeMs: 0 };
  });
  assert.equal(called, true);
});

test('a changed profile, extra secrets or unsafe overrides fail before starting a tunnel', async () => {
  const selected = config();
  const { profileHash } = sessionProfile(selected, 'work');
  const run = () => assert.fail('must not run the VPN');
  await assert.rejects(runSessionRequest(config(['another.internal']), { profileHash, request, values }, run), /profile changed/);
  await assert.rejects(runSessionRequest(selected, { profileHash, request, values: { ...values, EXTRA: 'unused' } }, run), /do not match/);
  await assert.rejects(runSessionRequest(selected, { profileHash, request: { ...request, followRedirects: true }, values }, run), /followRedirects/);
  const legacy = parseConfig('{"profiles":{"work":{"type":"wireguard","config":"/home/user/.wg.conf"}}}', '/config.json');
  assert.throws(() => sessionProfile(legacy, 'work'), /self-contained/);
  await assert.rejects(rewriteOvpn('ca /any/host/path\n'), /must inline ca/);
});
