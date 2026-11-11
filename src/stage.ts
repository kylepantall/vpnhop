import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { ConfigSource, Profile, SecretRef } from './config.ts';
import { resolvePath } from './config.ts';
import type { SecretResolver } from './secrets.ts';
import type { TarEntry } from './tar.ts';

/** Everything the container needs, staged into /vpn by `docker cp` (never a bind mount). */
export type Staged = {
  entries: TarEntry[];
  /** Resolved values by label, for log redaction. */
  secrets: Record<string, string>;
  /** Extra `docker create` flags this VPN type needs. */
  dockerArgs: string[];
};

// Directives whose argument is a file the client must be able to read.
const OVPN_FILE_DIRECTIVES = new Set([
  'ca', 'cert', 'key', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'pkcs12', 'crl-verify', 'dh', 'extra-certs',
  'secret', 'auth-user-pass', 'askpass', 'http-proxy-user-pass',
]);
// Host-side hook scripts in desktop/Linux profiles won't exist in the container.
const OVPN_DROP_DIRECTIVES = new Set(['up', 'down', 'route-up', 'route-pre-down', 'ipchange', 'script-security']);

const SAFE_TOKEN = /^[^\s"'{}\\]+$/;

function assertToken(value: string, what: string): string {
  if (!SAFE_TOKEN.test(value)) throw new Error(`${what} contains whitespace, quotes or braces: not allowed`);
  return value;
}

function assertLine(value: string, what: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error(`${what} must not contain newlines`);
  return value;
}

async function readProfileFile(path: string, baseDir: string, what: string): Promise<Buffer> {
  try {
    return await readFile(resolvePath(path, baseDir));
  } catch {
    throw new Error(`${what}: cannot read ${path}`);
  }
}

function resolvConf(profile: Profile): string | undefined {
  if (!profile.dns?.length && !profile.searchDomains?.length) return undefined;
  const lines = [];
  if (profile.searchDomains?.length) lines.push(`search ${profile.searchDomains.map((d) => assertToken(d, 'searchDomains')).join(' ')}`);
  for (const ns of profile.dns ?? []) lines.push(`nameserver ${assertToken(ns, 'dns')}`);
  return `${lines.join('\n')}\n`;
}

export async function rewriteOvpn(
  text: string,
  configDir: string
): Promise<{ config: string; files: TarEntry[] }> {
  const files = new Map<string, Buffer>();
  const out: string[] = [];
  let inlineBlock: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    // Inline <ca>...</ca> blocks hold base64 that can look like directives.
    if (inlineBlock) {
      if (line.trim() === `</${inlineBlock}>`) inlineBlock = undefined;
      out.push(line);
      continue;
    }
    const open = /^\s*<([a-z0-9-]+)>\s*$/.exec(line);
    if (open) {
      inlineBlock = open[1];
      out.push(line);
      continue;
    }
    const m = /^(\s*)([a-z][a-z0-9-]*)(?:\s+(?:"([^"]*)"|(\S+)))?(\s.*)?$/.exec(line);
    const directive = m?.[2];
    if (!m || !directive) {
      out.push(line);
      continue;
    }
    if (OVPN_DROP_DIRECTIVES.has(directive)) {
      out.push(`# vpnhop: dropped host hook: ${line.trim()}`);
      continue;
    }
    const arg = m[3] ?? m[4];
    if (OVPN_FILE_DIRECTIVES.has(directive) && arg && arg !== '[inline]' && arg !== 'stdin') {
      const name = basename(arg);
      if (!files.has(name)) files.set(name, await readProfileFile(arg, configDir, `openvpn ${directive}`));
      out.push(`${m[1]}${directive} ${name}${m[5] ?? ''}`);
      continue;
    }
    out.push(line);
  }
  return {
    config: out.join('\n'),
    files: [...files].map(([name, data]) => ({ name: `vpn/files/${name}`, data, mode: 0o600 })),
  };
}

export function setWireGuardKey(conf: string, key: string): string {
  const lines = conf.split(/\r?\n/).filter((l) => !/^\s*PrivateKey\s*=/i.test(l));
  const i = lines.findIndex((l) => /^\s*\[Interface\]\s*$/i.test(l));
  if (i < 0) throw new Error('wireguard config has no [Interface] section');
  lines.splice(i + 1, 0, `PrivateKey = ${assertLine(key, 'wireguard privateKey')}`);
  return lines.join('\n');
}

const b64 = (s: string) => `0s${Buffer.from(s, 'utf8').toString('base64')}`;
const quoted = (s: string, what: string) => {
  if (/["\\]/.test(assertLine(s, what))) throw new Error(`${what} must not contain quotes or backslashes`);
  return `"${s}"`;
};

export function swanctlConf(p: Extract<Profile, { type: 'ipsec' }>, s: { username?: string; password?: string; psk?: string }): string {
  const server = assertToken(p.server, 'ipsec server');
  const subnets = p.subnets.map((n) => assertToken(n, 'ipsec subnets')).join(',');
  const local =
    p.auth === 'eap'
      ? [`auth = eap-mschapv2`, `eap_id = ${quoted(s.username ?? '', 'username')}`]
      : ['auth = psk', ...(s.username ? [`id = ${quoted(s.username, 'username')}`] : [])];
  const remoteAuth = p.auth === 'eap' ? 'pubkey' : 'psk';
  const secrets =
    p.auth === 'eap'
      ? `  eap-vpnhop {\n    id = ${quoted(s.username ?? '', 'username')}\n    secret = ${b64(s.password ?? '')}\n  }`
      : `  ike-vpnhop {\n    secret = ${b64(s.psk ?? '')}\n  }`;
  return `connections {
  vpnhop {
    version = 2
    remote_addrs = ${server}
    vips = 0.0.0.0
    local {
      ${local.join('\n      ')}
    }
    remote {
      auth = ${remoteAuth}
      id = ${quoted(p.remoteId ?? p.server, 'remoteId')}
    }
    children {
      vpnhop {
        remote_ts = ${subnets}
        start_action = none
      }
    }
  }
}
secrets {
${secrets}
}
`;
}

/** A profile file from disk, or from keyhop (then it is a secret, and has no sibling files). */
async function profileText(source: ConfigSource, baseDir: string, what: string, resolve: SecretResolver, secrets: Record<string, string>): Promise<{ text: string; dir?: string }> {
  if (typeof source === 'string') {
    return { text: (await readProfileFile(source, baseDir, what)).toString('utf8'), dir: dirname(resolvePath(source, baseDir)) };
  }
  const text = await resolve(source, what);
  secrets[what] = text;
  return { text };
}

export async function stage(profile: Profile, baseDir: string, resolve: SecretResolver): Promise<Staged> {
  const secrets: Record<string, string> = {};
  const get = async (ref: SecretRef | undefined, label: string) => {
    if (!ref) return undefined;
    const value = await resolve(ref, label);
    secrets[label] = value;
    return value;
  };
  const entries: TarEntry[] = [{ name: 'vpn', dir: true, mode: 0o700 }];
  const dockerArgs: string[] = [];
  const dns = resolvConf(profile);
  if (dns) entries.push({ name: 'vpn/resolv.conf', data: dns, mode: 0o644 });

  switch (profile.type) {
    case 'openvpn': {
      const { text, dir } = await profileText(profile.config, baseDir, 'openvpn config', resolve, secrets);
      // A keyhop-held profile is self-contained (vpnhop add inlines its files); `dir` only exists on disk.
      const { config, files } = await rewriteOvpn(text, dir ?? '/nonexistent');
      entries.push({ name: 'vpn/files', dir: true, mode: 0o700 }, ...files, { name: 'vpn/config.ovpn', data: config });
      const username = await get(profile.username, 'username');
      const password = await get(profile.password, 'password');
      if (username !== undefined || password !== undefined) {
        if (username === undefined || password === undefined)
          throw new Error('openvpn: username and password must be set together');
        entries.push({
          name: 'vpn/auth.txt',
          data: `${assertLine(username, 'username')}\n${assertLine(password, 'password')}\n`,
        });
      }
      break;
    }
    case 'wireguard': {
      let conf = (await profileText(profile.config, baseDir, 'wireguard config', resolve, secrets)).text;
      const key = await get(profile.privateKey, 'privateKey');
      if (key) conf = setWireGuardKey(conf, key);
      else if (!/^\s*PrivateKey\s*=/im.test(conf)) throw new Error('wireguard config has no PrivateKey and no privateKey ref');
      for (const m of conf.matchAll(/^\s*(PrivateKey|PresharedKey)\s*=\s*(\S+)/gim)) secrets[m[1]!] = m[2]!;
      entries.push({ name: 'vpn/wg0.conf', data: conf });
      dockerArgs.push('--sysctl', 'net.ipv4.conf.all.src_valid_mark=1');
      break;
    }
    case 'openconnect': {
      const args = [`--protocol=${profile.protocol}`];
      const username = await get(profile.username, 'username');
      if (username) args.push(`--user=${username}`);
      if (profile.serverCert) args.push(`--servercert=${profile.serverCert}`);
      if (profile.authGroup) args.push(`--authgroup=${profile.authGroup}`);
      if (profile.userAgent) args.push(`--useragent=${profile.userAgent}`);
      const totp = await get(profile.totpSecret, 'totpSecret');
      if (totp) {
        args.push('--token-mode=totp', '--token-secret=@/vpn/totp');
        entries.push({ name: 'vpn/totp', data: assertLine(totp, 'totpSecret') });
      }
      args.push(...(profile.extraArgs ?? []));
      args.forEach((a) => assertLine(a, 'openconnect argument'));
      entries.push({ name: 'vpn/args', data: `${args.join('\n')}\n` });
      entries.push({ name: 'vpn/server', data: assertLine(profile.server, 'server') });
      const password = await get(profile.password, 'password');
      if (password) entries.push({ name: 'vpn/password', data: `${assertLine(password, 'password')}\n` });
      break;
    }
    case 'ipsec': {
      const values = {
        username: await get(profile.username, 'username'),
        password: await get(profile.password, 'password'),
        psk: await get(profile.psk, 'psk'),
      };
      entries.push({ name: 'vpn/swanctl.conf', data: swanctlConf(profile, values) });
      if (profile.caCert) entries.push({ name: 'vpn/ca.pem', data: await readProfileFile(profile.caCert, baseDir, 'ipsec caCert'), mode: 0o644 });
      break;
    }
  }
  return { entries, secrets, dockerArgs };
}
