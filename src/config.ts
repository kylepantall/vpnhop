import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

/** Where a secret comes from. Values never live in the config file itself. */
export const KEYHOP_NAME = /^[A-Z_][A-Z0-9_]*$/;

export const SecretRef = z.union([
  z
    .object({ keyhop: z.string().regex(KEYHOP_NAME) })
    .strict()
    .describe('Name of a secret in the keyhop vault (encrypted, Touch ID). `vpnhop add` creates these.'),
  z.object({ env: z.string().min(1) }).strict(),
  z.object({ file: z.string().min(1) }).strict(),
  z
    .object({ command: z.array(z.string()).min(1) })
    .strict()
    .describe('Program and args, e.g. ["op","read","op://Work/VPN/password"]. Stdout is the value.'),
]);
export type SecretRef = z.infer<typeof SecretRef>;
export type KeyhopRef = Extract<SecretRef, { keyhop: string }>;

/** A profile file: a path on disk, or its whole contents kept in keyhop. */
const ConfigSource = z.union([z.string().min(1), z.object({ keyhop: z.string().regex(KEYHOP_NAME) }).strict()]);
export type ConfigSource = z.infer<typeof ConfigSource>;

const common = {
  description: z.string().optional(),
  /** Nameservers (and `search` domains) forced inside the tunnel, overriding pushed DNS. */
  dns: z.array(z.string().min(1)).optional(),
  searchDomains: z.array(z.string().min(1)).optional(),
  /** Hosts http_request may reach: exact names, `*.suffix`, IPv4 CIDRs, or `*`. Omitted = any. */
  allowHosts: z.array(z.string().min(1)).optional(),
  idleMinutes: z.number().int().min(1).max(24 * 60).optional(),
  connectTimeoutSeconds: z.number().int().min(5).max(300).optional(),
};

const OpenVpnProfile = z
  .object({
    type: z.literal('openvpn'),
    config: ConfigSource.describe('Path to the .ovpn file, or { keyhop } holding its contents.'),
    username: SecretRef.optional(),
    password: SecretRef.optional(),
    ...common,
  })
  .strict();

const WireGuardProfile = z
  .object({
    type: z.literal('wireguard'),
    config: ConfigSource.describe('Path to a wg-quick .conf file, or { keyhop } holding its contents.'),
    privateKey: SecretRef.optional().describe('Replaces/sets [Interface] PrivateKey.'),
    ...common,
  })
  .strict();

export const OPENCONNECT_PROTOCOLS = ['anyconnect', 'gp', 'nc', 'pulse', 'f5', 'fortinet', 'array'] as const;

const OpenConnectProfile = z
  .object({
    type: z.literal('openconnect'),
    protocol: z.enum(OPENCONNECT_PROTOCOLS).default('anyconnect'),
    server: z.string().min(1),
    username: SecretRef.optional(),
    password: SecretRef.optional(),
    totpSecret: SecretRef.optional().describe('Base32 TOTP seed, for servers that ask for a one-time code.'),
    serverCert: z.string().optional().describe('Pin, e.g. pin-sha256:...'),
    authGroup: z.string().optional(),
    userAgent: z.string().optional(),
    extraArgs: z.array(z.string()).optional(),
    ...common,
  })
  .strict();

const IpsecProfile = z
  .object({
    type: z.literal('ipsec'),
    server: z.string().min(1),
    auth: z.enum(['eap', 'psk']).describe('IKEv2 EAP-MSCHAPv2 (username/password) or pre-shared key.'),
    username: SecretRef.optional().describe('EAP identity, or local IKE identity for psk.'),
    password: SecretRef.optional(),
    psk: SecretRef.optional(),
    remoteId: z.string().optional(),
    caCert: z.string().optional().describe('PEM file; defaults to the system CA bundle.'),
    subnets: z.array(z.string()).default(['0.0.0.0/0']),
    ...common,
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.auth === 'eap' && (!p.username || !p.password))
      ctx.addIssue({ code: 'custom', message: 'eap needs username and password' });
    if (p.auth === 'psk' && !p.psk) ctx.addIssue({ code: 'custom', message: 'psk auth needs psk' });
  });

export const Profile = z.discriminatedUnion('type', [OpenVpnProfile, WireGuardProfile, OpenConnectProfile, IpsecProfile]);
export type Profile = z.infer<typeof Profile>;
export type VpnType = Profile['type'];

export const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,40}$/;

export const ConfigFile = z
  .object({
    defaults: z.object({ idleMinutes: common.idleMinutes, connectTimeoutSeconds: common.connectTimeoutSeconds }).optional(),
    profiles: z.record(z.string().regex(PROFILE_NAME, 'lowercase letters, digits, - and _'), Profile),
  })
  .strict()
  .superRefine((c, ctx) => {
    // aws-prod and aws_prod would read and overwrite each other's keyhop secrets.
    const seen = new Map<string, string>();
    for (const name of Object.keys(c.profiles)) {
      const key = name.replace(/-/g, '_');
      const other = seen.get(key);
      if (other) ctx.addIssue({ code: 'custom', message: `profiles "${other}" and "${name}" differ only by - and _` });
      seen.set(key, name);
    }
  });

export type Config = { path: string; dir: string; profiles: Record<string, Profile>; idleMinutes: number; connectTimeoutSeconds: number };

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.VPNHOP_CONFIG ?? join(homedir(), '.config', 'vpnhop', 'config.json');
}

/** Resolves `~/x` and paths relative to the config file. */
export function resolvePath(path: string, baseDir: string): string {
  if (path === '~' || path.startsWith('~/')) return join(homedir(), path.slice(1));
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

export function parseConfig(text: string, path: string): Config {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`vpnhop config is not valid JSON (${path}): ${(error as Error).message}`);
  }
  const parsed = ConfigFile.safeParse(raw);
  if (!parsed.success) throw new Error(`vpnhop config is invalid (${path}):\n${z.prettifyError(parsed.error)}`);
  return {
    path,
    dir: dirname(path),
    profiles: parsed.data.profiles,
    idleMinutes: parsed.data.defaults?.idleMinutes ?? 30,
    connectTimeoutSeconds: parsed.data.defaults?.connectTimeoutSeconds ?? 60,
  };
}

export function loadConfig(path = configPath()): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`No vpnhop config at ${path}. Create it (see examples/config.json) or set VPNHOP_CONFIG.`);
  }
  return parseConfig(text, path);
}

/** keyhop secret name for one field of a profile: aws + password → VPNHOP_AWS_PASSWORD. */
export function keyhopName(profile: string, field: string): string {
  return `VPNHOP_${profile}_${field}`.toUpperCase().replace(/-/g, '_');
}

/** Every keyhop name a profile uses, so one keyhop call (one Touch ID) can fetch them all. */
export function keyhopRefs(profile: Profile): string[] {
  const names = new Set<string>();
  for (const value of Object.values(profile))
    if (value && typeof value === 'object' && !Array.isArray(value) && 'keyhop' in value) names.add((value as KeyhopRef).keyhop);
  return [...names];
}

type RawConfig = z.input<typeof ConfigFile>;

/** Reads the raw file (or an empty one), applies `change`, validates, and writes it back owner-only and atomically. */
export function editConfig(change: (raw: RawConfig) => void, path = configPath()): Config {
  let raw: RawConfig = { profiles: {} };
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as RawConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot read vpnhop config (${path}): ${(error as Error).message}`);
  }
  raw.profiles ??= {};
  change(raw);
  const text = `${JSON.stringify(raw, null, 2)}\n`;
  const config = parseConfig(text, path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  renameSync(temp, path);
  return config;
}

export function getProfile(config: Config, name: string): Profile {
  const profile = Object.hasOwn(config.profiles, name) ? config.profiles[name] : undefined;
  if (!profile) {
    const known = Object.keys(config.profiles).join(', ') || 'none';
    throw new Error(`Unknown profile "${name}". Known: ${known}`);
  }
  return profile;
}
