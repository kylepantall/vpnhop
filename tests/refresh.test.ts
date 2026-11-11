import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findServers, isStale } from '../src/refresh.ts';

const entry = '/home/me/.local/share/vpnhop/app/src/index.ts';
const resolve = (file: string) => (file === entry || file === '/home/me/.local/bin/../share/vpnhop/app/src/index.ts' ? entry : null);

test('finds this install’s servers with ppid and start time, never CLI subcommands', () => {
  const ps = [
    `  101   900 Mon Nov  2 08:54:37 2026 /usr/bin/node ${entry}`,
    `  102     1 Mon Nov  2 08:55:00 2026 /usr/bin/node ${entry} serve`,
    `  103   900 Mon Nov  2 08:55:00 2026 /usr/bin/node ${entry} status`,
    `  104   900 Mon Nov  2 08:55:00 2026 /usr/bin/node /elsewhere/app/src/index.ts`,
    `  105   900 Mon Nov  2 08:55:00 2026 /usr/bin/node /home/me/.local/bin/../share/vpnhop/app/src/index.ts`,
  ].join('\n');
  const found = findServers(ps, entry, 999, resolve);
  assert.deepEqual(found.map((s) => [s.pid, s.ppid]), [[101, 900], [102, 1], [105, 900]]);
  assert.deepEqual(findServers(ps, entry, 101, resolve).map((s) => s.pid), [102, 105]);
});

test('stale means started more than a second before the install', () => {
  const builtAt = new Date('2026-11-02T08:55:00Z');
  assert.equal(isStale({ pid: 1, ppid: 1, startedAt: new Date('2026-11-02T08:54:58Z') }, builtAt), true);
  assert.equal(isStale({ pid: 1, ppid: 1, startedAt: new Date('2026-11-02T08:54:59.5Z') }, builtAt), false);
});

test('danglingReason keeps healthy shared tunnels, removes stopped, orphaned and outdated ones', async () => {
  const { danglingReason } = await import('../src/refresh.ts');
  const { profileHash } = await import('../src/tunnels.ts');
  const { parseConfig } = await import('../src/config.ts');
  const config = parseConfig(JSON.stringify({ profiles: { aws: { type: 'openvpn', config: 'a.ovpn' } } }), '/c/config.json');
  const hash = profileHash(config.profiles.aws!, 'img:1');
  assert.equal(danglingReason({ state: 'running', profile: 'aws', hash }, config, 'img:1'), null);
  assert.ok(danglingReason({ state: 'exited', profile: 'aws', hash }, config, 'img:1'));
  assert.ok(danglingReason({ state: 'running', profile: 'gone', hash }, config, 'img:1'));
  assert.ok(danglingReason({ state: 'running', profile: 'aws', hash }, config, 'img:2'));
  assert.equal(danglingReason({ state: 'running', profile: 'gone', hash }, null, 'img:1'), null);
});
