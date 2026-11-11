/**
 * Saved profiles: the non-secret part goes in config.json, everything secret (the profile
 * file itself, passwords, keys, TOTP seeds) goes into keyhop under VPNHOP_<PROFILE>_*.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Config, ConfigSource, Profile } from './config.ts';
import { configPath, editConfig, keyhopName, keyhopRefs, loadConfig, OPENCONNECT_PROTOCOLS, PROFILE_NAME, resolvePath } from './config.ts';
import type { Keyhop } from './keyhop.ts';

// Directives whose file can be inlined as <directive>…</directive>.
const INLINE = new Set(['ca', 'cert', 'key', 'extra-certs', 'dh', 'tls-auth', 'tls-crypt', 'tls-crypt-v2', 'crl-verify', 'secret', 'pkcs12', 'http-proxy-user-pass']);
const BINARY = new Set(['pkcs12']);

export type InlinedOvpn = { text: string; username?: string; password?: string; auth: boolean; name?: string };

/**
 * Makes an .ovpn self-contained: referenced cert/key files become inline blocks, and an
 * `auth-user-pass <file>` becomes bare `auth-user-pass` with its credentials returned separately.
 */
export function inlineOvpn(text: string, dir: string, read: (path: string) => Buffer = (p) => readFileSync(p)): InlinedOvpn {
  const out: string[] = [];
  let block: string | undefined;
  let auth = false;
  let username: string | undefined;
  let password: string | undefined;
  let name: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (block) {
      if (line.trim() === `</${block}>`) block = undefined;
      out.push(line);
      continue;
    }
    const open = /^\s*<([a-z0-9-]+)>\s*$/.exec(line);
    if (open) {
      block = open[1];
      out.push(line);
      continue;
    }
    const friendly = /^\s*setenv\s+FRIENDLY_NAME\s+"?([^"]+)"?\s*$/i.exec(line);
    if (friendly) name = friendly[1]!.trim();
    const m = /^(\s*)([a-z][a-z0-9-]*)(?:\s+(?:"([^"]*)"|(\S+)))?(\s.*)?$/.exec(line);
    const directive = m?.[2];
    const arg = m?.[3] ?? m?.[4];
    if (directive === 'auth-user-pass') {
      auth = true;
      if (arg && arg !== 'stdin') {
        const [u, p] = read(resolvePath(arg, dir)).toString('utf8').split(/\r?\n/);
        username = u || undefined;
        password = p || undefined;
      }
      out.push('auth-user-pass');
      continue;
    }
    if (directive && arg && arg !== '[inline]' && INLINE.has(directive)) {
      const data = read(resolvePath(arg, dir));
      const body = BINARY.has(directive) ? data.toString('base64').replace(/(.{64})/g, '$1\n') : data.toString('utf8');
      out.push(`<${directive}>`, body.replace(/\n$/, ''), `</${directive}>`);
      // tls-auth's direction argument becomes key-direction when inlined.
      const rest = m?.[5]?.trim();
      if (directive === 'tls-auth' && rest) out.push(`key-direction ${rest}`);
      continue;
    }
    out.push(line);
  }
  return { text: `${out.join('\n').replace(/\n*$/, '')}\n`, username, password, auth, name };
}

export type AddRequest = {
  name: string;
  type?: Profile['type'];
  /** Profile file (.ovpn / wg .conf). */
  file?: string;
  server?: string;
  protocol?: (typeof OPENCONNECT_PROTOCOLS)[number];
  ipsecAuth?: 'eap' | 'psk';
  remoteId?: string;
  subnets?: string[];
  serverCert?: string;
  description?: string;
  allowHosts?: string[];
  /** Asked for when the profile needs them and they weren't in the file. */
  username?: string;
  password?: string;
  totpSecret?: string;
  psk?: string;
};

export function detectType(text: string, file: string): Profile['type'] {
  if (/^\s*\[Interface\]\s*$/im.test(text)) return 'wireguard';
  if (/\.ovpn$/i.test(file) || /^\s*(client|remote)\b/m.test(text)) return 'openvpn';
  throw new Error(`Can't tell what kind of VPN ${file} is; pass --type openvpn|wireguard`);
}

/** What `add` will save: the config.json profile and the keyhop values. */
export function planAdd(req: AddRequest): { profile: Record<string, unknown>; values: Record<string, string>; needs: ('username' | 'password')[] } {
  if (!PROFILE_NAME.test(req.name)) throw new Error('Profile names are lowercase letters, digits, - and _ (max 41)');
  const values: Record<string, string> = {};
  const ref = (field: string, value: string | undefined) => {
    if (value === undefined || value === '') return undefined;
    values[keyhopName(req.name, field)] = value;
    return { keyhop: keyhopName(req.name, field) };
  };
  const common = {
    ...(req.description ? { description: req.description } : {}),
    ...(req.allowHosts?.length ? { allowHosts: req.allowHosts } : {}),
  };
  const needs: ('username' | 'password')[] = [];

  if (req.file) {
    const path = resolvePath(req.file, process.cwd());
    const raw = readFileSync(path, 'utf8');
    const type = req.type ?? detectType(raw, path);
    if (type === 'openvpn') {
      const ovpn = inlineOvpn(raw, dirname(path));
      const username = req.username ?? ovpn.username;
      const password = req.password ?? ovpn.password;
      if (ovpn.auth && !username) needs.push('username');
      if (ovpn.auth && !password) needs.push('password');
      const profile = {
        type,
        config: ref('CONFIG', ovpn.text) as ConfigSource,
        ...(ref('USERNAME', username) ? { username: { keyhop: keyhopName(req.name, 'USERNAME') } } : {}),
        ...(ref('PASSWORD', password) ? { password: { keyhop: keyhopName(req.name, 'PASSWORD') } } : {}),
        ...(common.description || !ovpn.name ? {} : { description: ovpn.name }),
        ...common,
      };
      return { profile, values, needs };
    }
    if (type === 'wireguard') {
      if (!/^\s*PrivateKey\s*=/im.test(raw)) throw new Error('WireGuard config has no PrivateKey');
      return { profile: { type, config: ref('CONFIG', raw), ...common }, values, needs };
    }
    throw new Error(`${type} profiles don't come from a file; use --server`);
  }

  if (req.type === 'openconnect') {
    if (!req.server) throw new Error('openconnect needs --server');
    if (!req.password) needs.push('password');
    const profile = {
      type: 'openconnect',
      server: req.server,
      protocol: req.protocol ?? 'anyconnect',
      ...(ref('USERNAME', req.username) ? { username: { keyhop: keyhopName(req.name, 'USERNAME') } } : {}),
      ...(ref('PASSWORD', req.password) ? { password: { keyhop: keyhopName(req.name, 'PASSWORD') } } : {}),
      ...(ref('TOTP', req.totpSecret) ? { totpSecret: { keyhop: keyhopName(req.name, 'TOTP') } } : {}),
      ...(req.serverCert ? { serverCert: req.serverCert } : {}),
      ...common,
    };
    return { profile, values, needs };
  }

  if (req.type === 'ipsec') {
    if (!req.server) throw new Error('ipsec needs --server');
    const auth = req.ipsecAuth ?? (req.psk ? 'psk' : 'eap');
    if (auth === 'eap' && !req.username) needs.push('username');
    if (auth === 'eap' && !req.password) needs.push('password');
    const profile = {
      type: 'ipsec',
      server: req.server,
      auth,
      ...(ref('USERNAME', req.username) ? { username: { keyhop: keyhopName(req.name, 'USERNAME') } } : {}),
      ...(ref('PASSWORD', req.password) ? { password: { keyhop: keyhopName(req.name, 'PASSWORD') } } : {}),
      ...(ref('PSK', req.psk) ? { psk: { keyhop: keyhopName(req.name, 'PSK') } } : {}),
      ...(req.remoteId ? { remoteId: req.remoteId } : {}),
      ...(req.subnets?.length ? { subnets: req.subnets } : {}),
      ...common,
    };
    return { profile, values, needs };
  }
  throw new Error('Give a profile file, or --type openconnect|ipsec with --server');
}

/** Saves secrets to keyhop first, then the profile; an old profile's leftover keyhop names are removed. */
export async function saveProfile(keyhop: Keyhop, req: AddRequest, path = configPath()): Promise<{ profile: string; type: string; keyhop: string[] }> {
  const { profile, values, needs } = planAdd(req);
  if (needs.length) throw new Error(`Profile "${req.name}" needs ${needs.join(' and ')}; run vpnhop add in a terminal to be asked for them`);
  let previous: string[] = [];
  try {
    const old = loadConfig(path).profiles[req.name];
    previous = old ? keyhopRefs(old) : [];
  } catch {
    // No config yet.
  }
  const stale = previous.filter((n) => !(n in values) && n.startsWith(keyhopName(req.name, '')));
  await keyhop.put(values, stale, `Save VPN profile "${req.name}"`);
  editConfig((raw) => {
    raw.profiles![req.name] = profile as never;
  }, path);
  return { profile: req.name, type: String(profile.type), keyhop: Object.keys(values) };
}

export async function removeProfile(keyhop: Keyhop, config: Config, name: string, path = configPath()): Promise<{ profile: string; removed: string[] }> {
  const profile = config.profiles[name];
  if (!profile) throw new Error(`Unknown profile "${name}"`);
  // Only names vpnhop owns: a ref to another keyhop secret (e.g. synced from 1Password) is left alone.
  const own = keyhopRefs(profile).filter((n) => n.startsWith(keyhopName(name, '')));
  await keyhop.put({}, own, `Remove VPN profile "${name}"`);
  editConfig((raw) => {
    delete raw.profiles![name];
  }, path);
  return { profile: name, removed: own };
}

export const OPENVPN_CONNECT_DIR = join(homedir(), 'Library', 'Application Support', 'OpenVPN Connect', 'profiles');

/** Profiles saved in the OpenVPN Connect app, with their friendly names. */
export function openVpnConnectProfiles(dir = OPENVPN_CONNECT_DIR): { id: string; name: string; file: string }[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.ovpn'));
  } catch {
    return [];
  }
  return files.map((f) => {
    const file = join(dir, f);
    const text = readFileSync(file, 'utf8');
    const name = /^\s*setenv\s+FRIENDLY_NAME\s+"?([^"\r\n]+)"?/im.exec(text)?.[1]?.trim()
      ?? /^\s*remote\s+(\S+)/m.exec(text)?.[1]
      ?? basename(f, '.ovpn');
    return { id: basename(f, '.ovpn'), name, file };
  });
}

/** A profile name from a friendly name: "AWS Client VPN (eu-west-2)" → aws-client-vpn-eu-west-2. */
export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 41) || 'vpn';
}
