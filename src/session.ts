import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getProfile, keyhopRefs, KEYHOP_NAME, PROFILE_NAME, type Config } from './config.ts';
import type { Keyhop } from './keyhop.ts';
import { RequestInput, type HttpRequest, type HttpResponse } from './request.ts';

const SessionRequest = z.strictObject({
  profile: z.string().regex(PROFILE_NAME),
  url: RequestInput.url,
  method: RequestInput.method,
  headers: RequestInput.headers,
  body: RequestInput.body,
  timeoutSeconds: z.number().int().min(1).max(60).default(30),
});
const SessionCall = z.strictObject({
  profileHash: z.string().regex(/^[a-f0-9]{64}$/),
  request: SessionRequest,
  values: z.record(z.string().regex(KEYHOP_NAME), z.string()),
});

/** Public metadata for an exact plan. Reading it does not start Docker or contact Keyhop. */
export function sessionProfile(config: Config, name: string) {
  const profile = getProfile(config, name);
  if (('config' in profile && typeof profile.config === 'string') ||
      ('caCert' in profile && profile.caCert) ||
      Object.values(profile).some((v) => v && typeof v === 'object' && !Array.isArray(v) && !('keyhop' in v)))
    throw new Error('A session profile requires Keyhop-backed credentials and self-contained profile files. Use vpnhop add.');
  const profileHash = createHash('sha256').update(JSON.stringify([
    name, profile, config.path, config.idleMinutes, config.connectTimeoutSeconds,
  ])).digest('hex');
  return { profile: name, profileHash, secretNames: keyhopRefs(profile).sort(), allowHosts: profile.allowHosts };
}

type RunRequest = (config: Config, keyhop: Keyhop, request: HttpRequest) => Promise<HttpResponse>;

/** Consumes only the approved values supplied by Keyhop for this one request. */
export async function runSessionRequest(config: Config, input: unknown, runRequest: RunRequest): Promise<HttpResponse> {
  const call = SessionCall.parse(input);
  const { profileHash, secretNames } = sessionProfile(config, call.request.profile);
  if (call.profileHash !== profileHash) throw new Error('The VPN profile changed. Prepare a new plan with session_profile.');
  if (Object.keys(call.values).length !== secretNames.length || !secretNames.every((name) => Object.hasOwn(call.values, name)))
    throw new Error('The approved secret names do not match this VPN profile.');
  const keyhop: Keyhop = {
    async get(names) {
      if (!names.every((name) => Object.hasOwn(call.values, name)))
        throw new Error('The VPN attempted to use a secret outside this plan.');
      return Object.fromEntries(names.map((name) => [name, call.values[name]!]));
    },
    async put() { throw new Error('A VPN session cannot change credentials.'); },
  };
  return runRequest(config, keyhop, { ...call.request, insecure: false, followRedirects: false, maxBodyBytes: 64 << 10 });
}

export async function readSessionCall(): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16 << 20) throw new Error('VPN session input is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Invalid VPN session input.');
  }
}
