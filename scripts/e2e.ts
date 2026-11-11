// End-to-end: real VPN servers in Docker, each serving HTTP only on its tunnel IP.
// Run: node scripts/e2e.ts   (needs Docker; leaves nothing behind)
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { createKeyhop } from '../src/keyhop.ts';
import { saveProfile } from '../src/profiles.ts';
import { createDocker } from '../src/docker.ts';
import { ensureImage } from '../src/image.ts';
import { createResolver } from '../src/secrets.ts';
import { Tunnels } from '../src/tunnels.ts';

const docker = createDocker();
const dir = fileURLToPath(new URL('../.e2e/', import.meta.url));
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const servers: string[] = [];

async function sh(args: string[], input?: string): Promise<string> {
  const r = await docker(args, { input, timeoutMs: 300_000 });
  if (r.code !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${r.stderr.slice(-800)}`);
  return r.stdout.toString('utf8').trim();
}

async function server(name: string, image: string, script: string): Promise<string> {
  const container = `vpnhopsrv-${name}`;
  await docker(['rm', '-f', container]);
  servers.push(container);
  await sh(['run', '-d', '--name', container, '--cap-add', 'NET_ADMIN', '--device', '/dev/net/tun',
    '--sysctl', 'net.ipv4.ip_forward=1', '--entrypoint', 'sh', image, '-c', script]);
  const ip = await sh(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', container]);
  for (let i = 0; i < 60; i++) {
    if ((await docker(['exec', container, 'test', '-f', '/tmp/server-ready'])).code === 0) return ip;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name} server did not start:\n${await sh(['logs', container]).catch((e) => e.message)}`);
}

const httpd = (ip: string, text: string) =>
  `apk add -q --no-cache busybox-extras >/dev/null && mkdir -p /www && echo '${text}' > /www/hello && httpd -p ${ip}:8080 -h /www && touch /tmp/server-ready && tail -f /dev/null`;

async function main(): Promise<void> {
  const image = await ensureImage(docker);
  const results: [string, boolean, string][] = [];

  // --- WireGuard ---------------------------------------------------------------
  const wgKey = async () => sh(['run', '--rm', '--entrypoint', 'wg', image, 'genkey']);
  const wgPub = async (k: string) => sh(['run', '--rm', '-i', '--entrypoint', 'wg', image, 'pubkey'], k);
  const [sk, ck] = [await wgKey(), await wgKey()];
  const wgIp = await server('wg', image, `
    mkdir -p /etc/wireguard && cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey = ${sk}
Address = 10.99.0.1/24
ListenPort = 51820
[Peer]
PublicKey = ${await wgPub(ck)}
AllowedIPs = 10.99.0.2/32
EOF
    ip link add p type wireguard 2>/dev/null && ip link del p || export WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go
    mkdir -p /www/cgi-bin
    printf '#!/bin/sh\\nprintf "Status: 302 Found\\\\r\\\\nLocation: %%s\\\\r\\\\n\\\\r\\\\n" "$QUERY_STRING"\\n' > /www/cgi-bin/go && chmod 755 /www/cgi-bin/go
    wg-quick up wg0 && ${httpd('10.99.0.1', 'hello over wireguard')}`);
  // A complete wg-quick file, saved into (fake) keyhop by saveProfile below.
  writeFileSync(`${dir}wg.conf`, `[Interface]\nPrivateKey = ${ck}\nAddress = 10.99.0.2/32\nDNS = 10.99.0.1, e2e.internal\n[Peer]\nPublicKey = ${await wgPub(sk)}\nEndpoint = ${wgIp}:51820\nAllowedIPs = 10.99.0.0/24\nPersistentKeepalive = 5\n`);

  // --- OpenVPN (certs + username/password) ------------------------------------
  const ovpnIp = await server('ovpn', image, `
    set -e; apk add -q --no-cache openssl >/dev/null; mkdir -p /pki && cd /pki
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout ca.key -out ca.crt -days 2 -subj /CN=e2e-ca 2>/dev/null
    for n in server client; do
      openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout $n.key -out $n.csr -subj /CN=$n 2>/dev/null
      printf "keyUsage=digitalSignature,keyAgreement\\nextendedKeyUsage=%s\\n" $([ $n = server ] && echo serverAuth || echo clientAuth) > $n.ext
      openssl x509 -req -in $n.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out $n.crt -days 2 -extfile $n.ext 2>/dev/null
    done
    printf '#!/bin/sh\\n[ "$(sed -n 1p "$1")" = e2e-user ] && [ "$(sed -n 2p "$1")" = "e2e pass!" ]\\n' > /check.sh; chmod 755 /check.sh
    cat > /server.conf <<EOF
dev tun
proto udp
port 1194
topology subnet
server 10.98.0.0 255.255.255.0
ca /pki/ca.crt
cert /pki/server.crt
key /pki/server.key
dh none
script-security 2
auth-user-pass-verify /check.sh via-file
push "dhcp-option DNS 10.98.0.1"
push "dhcp-option DOMAIN e2e.internal"
EOF
    openvpn --config /server.conf --daemon --log /tmp/ovpn.log
    for i in $(seq 1 40); do ip addr show tun0 >/dev/null 2>&1 && break; sleep 0.25; done
    ${httpd('10.98.0.1', 'hello over openvpn')}`);
  const pki = async (f: string) => sh(['exec', 'vpnhopsrv-ovpn', 'cat', `/pki/${f}`]);
  mkdirSync(`${dir}ovpn`, { recursive: true });
  writeFileSync(`${dir}ovpn/client.crt`, await pki('client.crt'));
  writeFileSync(`${dir}ovpn/client.key`, await pki('client.key'));
  writeFileSync(`${dir}ovpn/client.ovpn`, `client\ndev tun\nproto udp\nremote ${ovpnIp} 1194\nnobind\nremote-cert-tls server\nauth-user-pass\nup /etc/openvpn/update-resolv-conf\ncert client.crt\nkey client.key\n<ca>\n${await pki('ca.crt')}\n</ca>\n`);
  writeFileSync(`${dir}ovpn-pass.txt`, 'e2e pass!\n');

  // --- IPsec IKEv2 PSK ----------------------------------------------------------
  await server('ike', image, `
    ip link add dummy0 type dummy && ip addr add 10.97.1.1/32 dev dummy0 && ip link set dummy0 up
    cat > /etc/swanctl/swanctl.conf <<EOF
connections {
  rw {
    version = 2
    pools = pool
    local { auth = psk
      id = server.e2e }
    remote { auth = psk
      id = client.e2e }
    children { rw { local_ts = 10.97.1.0/24 } }
  }
}
pools { pool { addrs = 10.97.0.0/24 } }
secrets { ike { id-1 = client.e2e
  id-2 = server.e2e
  secret = "e2e-psk-value" } }
EOF
    /usr/lib/strongswan/charon >/tmp/charon.log 2>&1 &
    for i in $(seq 1 50); do [ -S /var/run/charon.vici ] && break; sleep 0.2; done
    swanctl --load-all >/dev/null && ${httpd('10.97.1.1', 'hello over ipsec')}`);
  const ikeIp = await sh(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', 'vpnhopsrv-ike']);

  // Stand-in for keyhop's client interface (contract A): a JSON file, and a log of calls.
  const store = `${dir}keyhop-store.json`;
  writeFileSync(store, '{}');
  writeFileSync(`${dir}fake-keyhop.cjs`, `#!/usr/bin/env node
const fs = require('fs');
const [, , group, sub] = process.argv;
const req = JSON.parse(fs.readFileSync(0, 'utf8'));
const db = JSON.parse(fs.readFileSync(${JSON.stringify(store)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(`${dir}keyhop-calls.log`)}, sub + ' ' + (req.names || Object.keys(req.values || {})).join(',') + '\\n');
if (group !== 'client' || req.client !== 'vpnhop') process.exit(3);
if (sub === 'get') {
  const missing = req.names.filter((n) => !(n in db));
  if (missing.length) { console.error('unknown: ' + missing.join(',')); process.exit(5); }
  console.log(JSON.stringify({ values: Object.fromEntries(req.names.map((n) => [n, db[n]])) }));
} else if (sub === 'put') {
  if ([...Object.keys(req.values), ...req.remove].some((n) => !n.startsWith('VPNHOP_'))) process.exit(3);
  Object.assign(db, req.values); for (const n of req.remove) delete db[n];
  fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify(db));
  console.log(JSON.stringify({ saved: Object.keys(req.values), removed: req.remove }));
} else process.exit(1);
`);
  chmodSync(`${dir}fake-keyhop.cjs`, 0o755);
  process.env.VPNHOP_KEYHOP_BIN = `${dir}fake-keyhop.cjs`;
  const keyhopCalls = () => readFileSync(`${dir}keyhop-calls.log`, 'utf8').split('\n').filter((l) => l.startsWith('get ')).length;

  const configText = JSON.stringify({
    defaults: { idleMinutes: 5, connectTimeoutSeconds: 45 },
    profiles: {
      'e2e-ovpn': { type: 'openvpn', config: 'ovpn/client.ovpn', username: { env: 'E2E_OVPN_USER' }, password: { file: 'ovpn-pass.txt' } },
      'e2e-ike': { type: 'ipsec', server: ikeIp, auth: 'psk', username: { env: 'E2E_IKE_ID' }, psk: { command: ['printf', 'e2e-psk-value'] }, remoteId: 'server.e2e', subnets: ['10.97.1.0/24'], idleMinutes: 1 },
    },
  });
  const configFile = `${dir}config.json`;
  writeFileSync(configFile, configText);
  const keyhop = createKeyhop();
  await saveProfile(keyhop, { name: 'e2e-wg', file: `${dir}wg.conf`, allowHosts: ['10.99.0.0/24'] }, configFile);
  const config = loadConfig(configFile);
  const env = { ...process.env, E2E_OVPN_USER: 'e2e-user', E2E_IKE_ID: 'client.e2e' };
  const tunnels = new Tunnels({ docker, keyhop, loadConfig: () => loadConfig(configFile), resolver: (c, v) => createResolver(c.dir, env, v), ensureImage: async () => image });

  const check = async (label: string, fn: () => Promise<string | void>) => {
    try {
      results.push([label, true, (await fn()) ?? '']);
    } catch (error) {
      results.push([label, false, (error as Error).message.slice(0, 1500)]);
    }
  };
  const expectBody = async (profile: string, url: string, text: string) => {
    const r = await tunnels.request({ profile, url, method: 'GET', headers: {}, timeoutSeconds: 10, followRedirects: false, insecure: false, maxBodyBytes: 4096 });
    if (r.status !== 200 || r.body.trim() !== text) throw new Error(`got ${r.status}: ${r.body}`);
    return `${r.status} in ${r.timeMs}ms`;
  };

  await check('baseline: tunnel IP unreachable without vpnhop', async () => {
    const r = await docker(['run', '--rm', '--entrypoint', 'curl', image, '-sS', '--max-time', '3', 'http://10.99.0.1:8080/hello']);
    if (r.code === 0) throw new Error('reachable without tunnel: test is invalid');
  });
  await check('wireguard: http_request auto-connects', () => expectBody('e2e-wg', 'http://10.99.0.1:8080/hello', 'hello over wireguard'));
  await check('wireguard: DNS line applied in container', async () => {
    const resolv = await sh(['exec', 'vpnhop-e2e-wg', 'cat', '/etc/resolv.conf']);
    if (!/nameserver 10\.99\.0\.1/.test(resolv) || !/search e2e\.internal/.test(resolv)) throw new Error(resolv);
  });
  await check('wireguard: allowHosts blocks other hosts', async () => {
    try {
      await expectBody('e2e-wg', 'http://example.com/', '');
    } catch (e) {
      if (/allowHosts/.test((e as Error).message)) return;
      throw e;
    }
    throw new Error('request was allowed');
  });
  const get = (url: string) => tunnels.request({ profile: 'e2e-wg', url, method: 'GET', headers: {}, timeoutSeconds: 10, followRedirects: true, insecure: false, maxBodyBytes: 4096 });
  await check('redirects: allowed hop is followed', async () => {
    const r = await get('http://10.99.0.1:8080/cgi-bin/go?http://10.99.0.1:8080/hello');
    if (r.status !== 200 || r.body.trim() !== 'hello over wireguard') throw new Error(`${r.status} ${r.body}`);
  });
  await check('redirects: hop to a disallowed host is refused', async () => {
    try {
      await get('http://10.99.0.1:8080/cgi-bin/go?http://example.com/');
    } catch (e) {
      if (/allowHosts/.test((e as Error).message)) return;
      throw e;
    }
    throw new Error('redirect left allowHosts');
  });
  await check('backslash userinfo trick stays on the checked host', async () => {
    const r = await get('http://10.99.0.1:8080\\@1.1.1.1/hello');
    if (!r.url.startsWith('http://10.99.0.1:8080/')) throw new Error(r.url);
  });
  await check('openvpn: certs as files + user/pass', () => expectBody('e2e-ovpn', 'http://10.98.0.1:8080/hello', 'hello over openvpn'));
  await check('openvpn: pushed DNS applied', async () => {
    const resolv = await sh(['exec', 'vpnhop-e2e-ovpn', 'cat', '/etc/resolv.conf']);
    if (!/nameserver 10\.98\.0\.1/.test(resolv) || !/search e2e\.internal/.test(resolv)) throw new Error(resolv);
  });
  await check('openvpn: logs redact the password', async () => {
    const [s] = await tunnels.status('e2e-ovpn', { logs: true });
    if (!s?.logs || s.state !== 'connected') throw new Error(JSON.stringify(s));
    if (s.logs.includes('e2e pass!')) throw new Error('password in logs');
  });
  await check('openvpn: wrong password fails with log', async () => {
    writeFileSync(`${dir}ovpn-pass.txt`, 'wrong\n');
    await tunnels.disconnect('e2e-ovpn');
    const fast = { ...config, profiles: { ...config.profiles, 'e2e-ovpn': { ...config.profiles['e2e-ovpn']!, connectTimeoutSeconds: 15 } } };
    const t = new Tunnels({ docker, keyhop, loadConfig: () => fast, resolver: (c, v) => createResolver(c.dir, env, v), ensureImage: async () => image });
    try {
      await t.connect('e2e-ovpn');
    } catch (e) {
      if ((e as Error).message.includes('wrong')) throw new Error('password leaked in error');
      return 'rejected as expected';
    } finally {
      writeFileSync(`${dir}ovpn-pass.txt`, 'e2e pass!\n');
      await t.disconnect('e2e-ovpn');
    }
    throw new Error('connected with wrong password');
  });
  await check('ipsec: IKEv2 PSK', () => expectBody('e2e-ike', 'http://10.97.1.1:8080/hello', 'hello over ipsec'));
  await check('reuse: second connect is the same container', async () => {
    const before = await sh(['inspect', '-f', '{{.Id}}', 'vpnhop-e2e-wg']);
    await tunnels.connect('e2e-wg');
    if ((await sh(['inspect', '-f', '{{.Id}}', 'vpnhop-e2e-wg'])) !== before) throw new Error('container was recreated');
  });
  await check('keyhop: saved profile stores no secret in config.json', async () => {
    const text = readFileSync(configFile, 'utf8');
    if (text.includes(ck) || !/"keyhop": "VPNHOP_E2E_WG_CONFIG"/.test(text)) throw new Error(text);
  });
  await check('keyhop: one Touch ID (get) for the first connect, none for reuse', async () => {
    const before = keyhopCalls();
    await tunnels.connect('e2e-wg');
    const t2 = new Tunnels({ docker, keyhop, loadConfig: () => loadConfig(configFile), resolver: (c, v) => createResolver(c.dir, env, v), ensureImage: async () => image });
    await t2.connect('e2e-wg'); // another process sharing the running tunnel
    if (before !== 1 || keyhopCalls() !== 1) throw new Error(`keyhop get calls: ${before} then ${keyhopCalls()}`);
  });
  await check('proxy: vpnhop proxy --json gives a SOCKS5 proxy into the tunnel', async () => {
    const out = execFileSync(process.execPath, [fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'proxy', 'e2e-wg', '--json'], {
      env: { ...process.env, VPNHOP_CONFIG: configFile },
      encoding: 'utf8',
    });
    const info = JSON.parse(out) as { host: string; port: number; expiresAt: string; profile: string };
    if (info.host !== '127.0.0.1' || !info.port || info.profile !== 'e2e-wg' || !(Date.parse(info.expiresAt) > Date.now())) throw new Error(out);
    const body = execFileSync('curl', ['-sS', '--max-time', '10', '--socks5-hostname', `127.0.0.1:${info.port}`, 'http://10.99.0.1:8080/hello'], { encoding: 'utf8' });
    if (body.trim() !== 'hello over wireguard') throw new Error(body);
    return `port ${info.port}`;
  });
  await check('lease: an idle tunnel stops itself (idleMinutes 1)', async () => {
    for (let i = 0; i < 120; i++) {
      const r = await docker(['inspect', '-f', '{{.State.Running}}', 'vpnhop-e2e-ike']);
      if (r.stdout.toString().trim() === 'false') return `stopped after ≈${i}s more`;
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new Error('still running 120s after its 60s lease');
  });
  // VPNHOP_E2E_HOLD=1: keep everything up for cross-repo checks (hopsql) until SIGTERM.
  if (process.env.VPNHOP_E2E_HOLD === '1') {
    console.log(`HOLD config=${configFile} keyhop=${process.env.VPNHOP_KEYHOP_BIN}`);
    // A pending promise alone doesn't keep Node alive; the interval does.
    const keepAlive = setInterval(() => {}, 1 << 30);
    await new Promise((resolve) => process.once('SIGTERM', resolve));
    clearInterval(keepAlive);
  }
  await check('disconnect removes containers', async () => {
    for (const p of ['e2e-wg', 'e2e-ovpn', 'e2e-ike']) await tunnels.disconnect(p);
    const left = await sh(['ps', '-a', '--filter', 'label=vpnhop.profile', '--format', '{{.Names}}']);
    if (/vpnhop-e2e-(wg|ovpn|ike)$/m.test(left)) throw new Error(left);
  });

  for (const [label, ok, detail] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (results.some(([, ok]) => !ok)) process.exitCode = 1;
}

try {
  await main();
} finally {
  for (const p of ['e2e-wg', 'e2e-ovpn', 'e2e-ike']) await docker(['rm', '-f', `vpnhop-${p}`]);
  await docker(['rm', '-f', ...servers]);
  rmSync(dir, { recursive: true, force: true });
}
