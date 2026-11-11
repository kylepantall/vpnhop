import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig, getProfile } from '../src/config.ts';

const parse = (profiles: unknown, extra: object = {}) => parseConfig(JSON.stringify({ profiles, ...extra }), '/cfg/config.json');

test('accepts every VPN type and applies defaults', () => {
  const config = parse({
    aws: { type: 'openvpn', config: 'aws.ovpn' },
    wg: { type: 'wireguard', config: '~/wg.conf', privateKey: { command: ['op', 'read', 'op://x'] } },
    corp: { type: 'openconnect', server: 'vpn.example.com', password: { env: 'PW' } },
    ike: { type: 'ipsec', server: 'ike.example.com', auth: 'psk', psk: { file: 'psk.txt' } },
  });
  assert.equal(config.dir, '/cfg');
  assert.equal(config.idleMinutes, 30);
  const corp = getProfile(config, 'corp');
  assert.equal(corp.type === 'openconnect' && corp.protocol, 'anyconnect');
  const ike = getProfile(config, 'ike');
  assert.deepEqual(ike.type === 'ipsec' && ike.subnets, ['0.0.0.0/0']);
});

test('rejects literal secrets, unknown keys and bad names', () => {
  assert.throws(() => parse({ a: { type: 'openvpn', config: 'x', password: 'hunter2' } }));
  assert.throws(() => parse({ a: { type: 'openvpn', config: 'x', bogus: 1 } }));
  assert.throws(() => parse({ 'Bad Name': { type: 'openvpn', config: 'x' } }));
  assert.throws(() => parse({ a: { type: 'pptp', server: 'x' } }));
});

test('ipsec auth requires matching credentials', () => {
  assert.throws(() => parse({ a: { type: 'ipsec', server: 's', auth: 'eap', username: { env: 'U' } } }));
  assert.throws(() => parse({ a: { type: 'ipsec', server: 's', auth: 'psk' } }));
});

test('unknown profile and invalid JSON are errors', () => {
  assert.throws(() => getProfile(parse({}), 'nope'));
  assert.throws(() => parseConfig('{', '/x.json'));
});
