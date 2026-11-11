import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Profile } from '../src/config.ts';
import type { SecretResolver } from '../src/secrets.ts';
import { rewriteOvpn, setWireGuardKey, stage, swanctlConf } from '../src/stage.ts';

const dir = mkdtempSync(join(tmpdir(), 'vpnhop-stage-'));
writeFileSync(join(dir, 'ca.crt'), 'CA');
writeFileSync(join(dir, 'ta.key'), 'TA');
const fake: SecretResolver = async (ref) => ('env' in ref ? `val-${ref.env}` : 'x');
const entry = (s: Awaited<ReturnType<typeof stage>>, name: string) => s.entries.find((e) => e.name === name)?.data?.toString();

test('openvpn: external files are copied and rewritten, hooks dropped, inline blocks untouched', async () => {
  const ovpn = ['client', `ca ${join(dir, 'ca.crt')}`, 'tls-auth "ta.key" 1', 'up /etc/openvpn/update-resolv-conf',
    '<cert>', 'up+lookslikeadirective', 'key abc', '</cert>', '# ca commented.crt'].join('\n');
  const { config, files } = await rewriteOvpn(ovpn, dir);
  const lines = config.split('\n');
  assert.ok(lines.includes('ca ca.crt'));
  assert.ok(lines.includes('tls-auth ta.key 1'));
  assert.ok(!lines.includes('up /etc/openvpn/update-resolv-conf'));
  assert.ok(lines.includes('up+lookslikeadirective') && lines.includes('key abc'));
  assert.ok(lines.includes('# ca commented.crt'));
  assert.deepEqual(files.map((f) => f.name).sort(), ['vpn/files/ca.crt', 'vpn/files/ta.key']);
});

test('openvpn: credentials go to auth.txt and are tracked for redaction', async () => {
  writeFileSync(join(dir, 'c.ovpn'), 'client\nremote vpn.example.com 1194\n');
  const p: Profile = { type: 'openvpn', config: 'c.ovpn', username: { env: 'U' }, password: { env: 'P' }, dns: ['10.0.0.2'] };
  const s = await stage(p, dir, fake);
  assert.equal(entry(s, 'vpn/auth.txt'), 'val-U\nval-P\n');
  assert.equal(entry(s, 'vpn/resolv.conf'), 'nameserver 10.0.0.2\n');
  assert.deepEqual(Object.keys(s.secrets).sort(), ['password', 'username']);
  await assert.rejects(stage({ type: 'openvpn', config: 'c.ovpn', username: { env: 'U' } }, dir, fake));
});

test('wireguard: privateKey ref replaces the key and adds the sysctl', async () => {
  writeFileSync(join(dir, 'wg.conf'), '[Interface]\nPrivateKey = OLD\nAddress = 10.9.0.2/32\n[Peer]\nPublicKey = PUB\n');
  const s = await stage({ type: 'wireguard', config: 'wg.conf', privateKey: { env: 'K' } }, dir, fake);
  const conf = entry(s, 'vpn/wg0.conf')!;
  assert.match(conf, /^\[Interface\]\nPrivateKey = val-K\n/);
  assert.doesNotMatch(conf, /OLD/);
  assert.ok(s.dockerArgs.includes('net.ipv4.conf.all.src_valid_mark=1'));
  assert.throws(() => setWireGuardKey('[Peer]\n', 'k'));
});

test('openconnect: args per line, password and TOTP in their own files', async () => {
  const s = await stage(
    { type: 'openconnect', protocol: 'gp', server: 'vpn.example.com', username: { env: 'U' }, password: { env: 'P' }, totpSecret: { env: 'T' }, serverCert: 'pin-sha256:abc' },
    dir, fake
  );
  const args = entry(s, 'vpn/args')!.trim().split('\n');
  assert.ok(args.includes('--protocol=gp') && args.includes('--user=val-U') && args.includes('--servercert=pin-sha256:abc'));
  assert.ok(args.includes('--token-secret=@/vpn/totp'));
  assert.equal(entry(s, 'vpn/password'), 'val-P\n');
  assert.equal(entry(s, 'vpn/totp'), 'val-T');
  assert.ok(!args.some((a) => a.includes('val-P')));
});

test('ipsec: secrets are base64 in swanctl.conf; unsafe tokens rejected', () => {
  const p = { type: 'ipsec', server: 'ike.example.com', auth: 'eap', subnets: ['10.0.0.0/8'] } as Extract<Profile, { type: 'ipsec' }>;
  const conf = swanctlConf(p, { username: 'me', password: 'pa"ss' });
  assert.match(conf, /secret = 0s/);
  assert.doesNotMatch(conf, /pa"ss/);
  assert.match(conf, /remote_ts = 10\.0\.0\.0\/8/);
  assert.throws(() => swanctlConf({ ...p, server: 'a b' }, { username: 'me', password: 'x' }));
  assert.throws(() => swanctlConf(p, { username: 'm"e', password: 'x' }));
});
