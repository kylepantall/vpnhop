import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { keyhopName, keyhopRefs, loadConfig } from '../src/config.ts';
import type { Keyhop } from '../src/keyhop.ts';
import { detectType, inlineOvpn, planAdd, removeProfile, saveProfile, slug } from '../src/profiles.ts';

const dir = mkdtempSync(join(tmpdir(), 'vpnhop-profiles-'));
writeFileSync(join(dir, 'ca.crt'), 'CA-PEM\n');
writeFileSync(join(dir, 'ta.key'), 'TA-KEY\n');
writeFileSync(join(dir, 'client.p12'), Buffer.from([0, 1, 2, 255]));
writeFileSync(join(dir, 'creds.txt'), 'alice\ns3cret\n');

function fakeKeyhop(): Keyhop & { db: Record<string, string>; puts: number } {
  const k = {
    db: {} as Record<string, string>,
    puts: 0,
    async get(names: string[]) {
      return Object.fromEntries(names.map((n) => [n, k.db[n]!]));
    },
    async put(values: Record<string, string>, remove: string[]) {
      k.puts++;
      Object.assign(k.db, values);
      for (const n of remove) delete k.db[n];
    },
  };
  return k;
}

test('inlineOvpn makes a self-contained profile and lifts auth-user-pass credentials out', () => {
  const ovpn = ['client', 'setenv FRIENDLY_NAME "Work VPN"', 'ca ca.crt', 'tls-auth ta.key 1', 'pkcs12 client.p12',
    'auth-user-pass creds.txt', '<cert>', 'ca not-a-directive.crt', '</cert>'].join('\n');
  const r = inlineOvpn(ovpn, dir);
  assert.equal(r.username, 'alice');
  assert.equal(r.password, 's3cret');
  assert.equal(r.auth, true);
  assert.equal(r.name, 'Work VPN');
  const lines = r.text.split('\n');
  assert.ok(lines.includes('<ca>') && lines.includes('CA-PEM') && lines.includes('</ca>'));
  assert.ok(lines.includes('<tls-auth>') && lines.includes('key-direction 1'));
  assert.ok(lines.includes(Buffer.from([0, 1, 2, 255]).toString('base64')));
  assert.ok(lines.includes('auth-user-pass'));
  assert.ok(!r.text.includes('s3cret'));
  assert.ok(lines.includes('ca not-a-directive.crt'), 'inline blocks are left alone');
});

test('planAdd keeps every secret out of the profile and names keyhop entries per profile', () => {
  writeFileSync(join(dir, 'w.ovpn'), 'client\nremote vpn.example.com\nauth-user-pass creds.txt\n');
  const { profile, values, needs } = planAdd({ name: 'work-1', file: join(dir, 'w.ovpn'), allowHosts: ['*.internal'] });
  assert.deepEqual(needs, []);
  assert.deepEqual(Object.keys(values).sort(), ['VPNHOP_WORK_1_CONFIG', 'VPNHOP_WORK_1_PASSWORD', 'VPNHOP_WORK_1_USERNAME']);
  assert.ok(!JSON.stringify(profile).includes('s3cret'));
  assert.deepEqual(profile.config, { keyhop: 'VPNHOP_WORK_1_CONFIG' });
  assert.deepEqual(profile.allowHosts, ['*.internal']);
});

test('planAdd reports what it still needs to ask for', () => {
  writeFileSync(join(dir, 'ask.ovpn'), 'client\nremote vpn.example.com\nauth-user-pass\n');
  assert.deepEqual(planAdd({ name: 'a', file: join(dir, 'ask.ovpn') }).needs, ['username', 'password']);
  assert.deepEqual(planAdd({ name: 'b', type: 'openconnect', server: 'vpn.example.com' }).needs, ['password']);
  assert.deepEqual(planAdd({ name: 'c', type: 'ipsec', server: 'ike.example.com', psk: 'k' }).needs, []);
  assert.throws(() => planAdd({ name: 'Bad Name', type: 'openconnect', server: 's' }));
  assert.throws(() => planAdd({ name: 'x' }));
});

test('detectType and slug', () => {
  assert.equal(detectType('[Interface]\nPrivateKey = k\n', 'x.conf'), 'wireguard');
  assert.equal(detectType('client\n', 'x.ovpn'), 'openvpn');
  assert.throws(() => detectType('hello', 'x.txt'));
  assert.equal(slug('AWS Client VPN (eu-west-2)'), 'aws-client-vpn-eu-west-2');
});

test('save then remove: keyhop holds values, config only refs; stale names are cleaned up', async () => {
  const cfg = join(dir, 'config.json');
  const k = fakeKeyhop();
  writeFileSync(join(dir, 'wg.conf'), '[Interface]\nPrivateKey = PRIV\n[Peer]\nPublicKey = PUB\n');
  await saveProfile(k, { name: 'office', file: join(dir, 'w.ovpn') }, cfg);
  assert.ok(k.db.VPNHOP_OFFICE_PASSWORD);
  // Re-saving as WireGuard drops the old username/password entries.
  await saveProfile(k, { name: 'office', file: join(dir, 'wg.conf') }, cfg);
  assert.deepEqual(Object.keys(k.db), ['VPNHOP_OFFICE_CONFIG']);
  const text = readFileSync(cfg, 'utf8');
  assert.ok(!text.includes('PRIV'));
  assert.equal((await import('node:fs')).statSync(cfg).mode & 0o777, 0o600);
  const config = loadConfig(cfg);
  assert.deepEqual(keyhopRefs(config.profiles.office!), ['VPNHOP_OFFICE_CONFIG']);
  await removeProfile(k, config, 'office', cfg);
  assert.deepEqual(k.db, {});
  assert.equal(loadConfig(cfg).profiles.office, undefined);
});

test('removeProfile leaves keyhop secrets it does not own', async () => {
  const cfg = join(dir, 'config2.json');
  writeFileSync(cfg, JSON.stringify({ profiles: { corp: { type: 'openconnect', server: 's', password: { keyhop: 'CORP_VPN_PASSWORD' } } } }));
  const k = fakeKeyhop();
  k.db.CORP_VPN_PASSWORD = 'synced-from-1password';
  await removeProfile(k, loadConfig(cfg), 'corp', cfg);
  assert.equal(k.db.CORP_VPN_PASSWORD, 'synced-from-1password');
  assert.equal(keyhopName('my-vpn', 'totp'), 'VPNHOP_MY_VPN_TOTP');
});

test('save_profile refuses files that are not the VPN config they claim to be', () => {
  writeFileSync(join(dir, 'creds'), 'https://user:token@github.com\n');
  assert.throws(() => planAdd({ name: 'git', file: join(dir, 'creds'), type: 'openvpn' }));
  assert.throws(() => planAdd({ name: 'git', file: join(dir, 'creds'), type: 'wireguard' }));
  writeFileSync(join(dir, 'half.conf'), '[Interface]\nPrivateKey = k\n');
  assert.throws(() => planAdd({ name: 'w', file: join(dir, 'half.conf') }));
});

test('read errors for referenced files carry no path from the profile text', () => {
  writeFileSync(join(dir, 'missing.ovpn'), 'client\nremote vpn.example.com\nkey sk_live_secretish_name\n');
  const err = (() => {
    try {
      planAdd({ name: 'm', file: join(dir, 'missing.ovpn') });
    } catch (e) {
      return e as Error;
    }
  })();
  assert.ok(err && !err.message.includes('sk_live_secretish_name'));
});

test('profiles differing only by - and _ are refused (they would share keyhop names)', async () => {
  const cfg = join(dir, 'clash.json');
  const k = fakeKeyhop();
  await saveProfile(k, { name: 'aws-prod', file: join(dir, 'w.ovpn') }, cfg);
  const before = { ...k.db };
  await assert.rejects(saveProfile(k, { name: 'aws_prod', file: join(dir, 'w.ovpn') }, cfg));
  assert.deepEqual(k.db, before, 'nothing written to keyhop');
  const { parseConfig } = await import('../src/config.ts');
  assert.throws(() => parseConfig(JSON.stringify({ profiles: { 'a-b': { type: 'openvpn', config: 'x' }, a_b: { type: 'openvpn', config: 'y' } } }), '/c.json'));
});
