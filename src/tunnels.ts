import { createHash } from 'node:crypto';
import type { Config, Profile, VpnType } from './config.ts';
import { getProfile, keyhopRefs } from './config.ts';
import type { Docker } from './docker.ts';
import { hostAllowed } from './hosts.ts';
import type { Keyhop } from './keyhop.ts';
import { redactor } from './redact.ts';
import type { HttpRequest, HttpResponse } from './request.ts';
import { curlArgs, parseCurl, targetUrl } from './request.ts';
import type { SecretResolver } from './secrets.ts';
import { stage } from './stage.ts';
import { tar } from './tar.ts';

export type TunnelState = 'connected' | 'connecting' | 'stopped' | 'exited';

export type TunnelStatus = {
  profile: string;
  type: VpnType;
  description?: string;
  state: TunnelState;
  container: string;
  allowHosts?: string[];
  /** When the lease runs out and the tunnel stops itself, unless used again. */
  expiresAt?: string;
  logs?: string;
};

export type ProxyInfo = { profile: string; host: string; port: number; expiresAt: string };

export type TunnelDeps = {
  docker: Docker;
  loadConfig: () => Config;
  resolver: (config: Config, keyhop: Record<string, string>) => SecretResolver;
  keyhop: Keyhop;
  ensureImage: () => Promise<string>;
  sleep?: (ms: number) => Promise<void>;
};

type Live = { redact: (text: string) => string };

const LOG_TAIL = 40;
const MAX_REDIRECTS = 10;
export const containerName = (profile: string) => `vpnhop-${profile}`;

/** Labels let a restarted server reuse a tunnel only if the profile hasn't changed. */
export function profileHash(profile: Profile, image: string): string {
  return createHash('sha256').update(image).update(JSON.stringify(profile)).digest('hex').slice(0, 16);
}

export class Tunnels {
  readonly #deps: TunnelDeps;
  readonly #live = new Map<string, Live>();
  readonly #pending = new Map<string, Promise<TunnelStatus>>();
  /** keyhop values fetched by this process, so a reconnect doesn't ask for Touch ID again. */
  readonly #secrets = new Map<string, string>();
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(deps: TunnelDeps) {
    this.#deps = deps;
    this.#sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async #inspect(container: string): Promise<{ running: boolean; hash?: string } | undefined> {
    const r = await this.#deps.docker(
      ['inspect', '-f', '{{.State.Running}} {{index .Config.Labels "vpnhop.hash"}}', container],
      { timeoutMs: 20_000 }
    );
    if (r.code !== 0) return undefined;
    const [running, hash] = r.stdout.toString('utf8').trim().split(' ');
    return { running: running === 'true', hash };
  }

  async #isReady(container: string): Promise<boolean> {
    return (await this.#deps.docker(['exec', container, 'test', '-f', '/run/vpnhop/ready'], { timeoutMs: 20_000 })).code === 0;
  }

  async #logs(container: string, redact: (t: string) => string, lines = LOG_TAIL): Promise<string> {
    const r = await this.#deps.docker(['logs', '--tail', String(lines), container], { timeoutMs: 20_000 });
    return redact(`${r.stdout.toString('utf8')}${r.stderr}`).trim();
  }

  #idleSeconds(config: Config, profile: Profile): number {
    return (profile.idleMinutes ?? config.idleMinutes) * 60;
  }

  /** Lease expiry, read from the container (any process may have extended it). */
  async #expiresAt(container: string, idleSeconds: number): Promise<string | undefined> {
    const r = await this.#deps.docker(['exec', container, 'stat', '-c', '%Y', '/run/vpnhop/lease'], { timeoutMs: 20_000 });
    const touched = Number(r.stdout.toString('utf8').trim());
    return r.code === 0 && touched ? new Date((touched + idleSeconds) * 1000).toISOString() : undefined;
  }

  connect(name: string): Promise<TunnelStatus> {
    // Concurrent calls for one profile share a single connect.
    const existing = this.#pending.get(name);
    if (existing) return existing;
    const work = this.#connect(name).finally(() => this.#pending.delete(name));
    this.#pending.set(name, work);
    return work;
  }

  async #connect(name: string): Promise<TunnelStatus> {
    const { docker } = this.#deps;
    const config = this.#deps.loadConfig();
    const profile = getProfile(config, name);
    const container = containerName(name);
    const image = await this.#deps.ensureImage();
    const hash = profileHash(profile, image);
    const idle = this.#idleSeconds(config, profile);

    // A running tunnel for this exact profile (any process may have started it) is shared:
    // extend its lease. No secrets needed, so no Touch ID.
    const current = await this.#inspect(container);
    if (current?.running && current.hash === hash && (await this.#isReady(container))) {
      await docker(['exec', container, 'touch', '/run/vpnhop/lease'], { timeoutMs: 20_000 });
      return this.#status(name, profile, 'connected', await this.#expiresAt(container, idle));
    }
    if (current) await docker(['rm', '-f', container], { timeoutMs: 30_000 });

    // One keyhop call (one Touch ID) for every keyhop secret the profile uses.
    const wanted = keyhopRefs(profile).filter((n) => !this.#secrets.has(n));
    if (wanted.length)
      for (const [k, v] of Object.entries(await this.#deps.keyhop.get(wanted, `Connect VPN profile "${name}"`))) this.#secrets.set(k, v);
    const staged = await stage(profile, config.dir, this.#deps.resolver(config, Object.fromEntries(this.#secrets)));
    const redact = redactor(staged.secrets);

    const create = await docker([
      'create', '--name', container,
      '--label', 'vpnhop.profile=' + name, '--label', 'vpnhop.hash=' + hash,
      '--cap-add', 'NET_ADMIN', '--device', '/dev/net/tun',
      '-e', `VPNHOP_IDLE_SECONDS=${idle}`,
      // SOCKS5 for other tools (vpnhop proxy); loopback only, and nothing listens until asked.
      '-p', '127.0.0.1::1080',
      ...staged.dockerArgs,
      image, profile.type,
    ]);
    if (create.code !== 0) throw new Error(`docker create failed: ${redact(create.stderr).trim()}`);
    // Secrets travel as a tar on stdin into the container's own filesystem: no host file, no env, no mount.
    const cp = await docker(['cp', '-', `${container}:/`], { input: tar(staged.entries) });
    const fail = async (message: string): Promise<never> => {
      const logs = await this.#logs(container, redact).catch(() => '');
      await docker(['rm', '-f', container], { timeoutMs: 30_000 });
      this.#live.delete(name);
      throw new Error(`${message}${logs ? `\n--- tunnel log ---\n${logs}` : ''}`);
    };
    if (cp.code !== 0) await fail(`staging files failed: ${redact(cp.stderr).trim()}`);
    const start = await docker(['start', container]);
    if (start.code !== 0) await fail(`docker start failed: ${redact(start.stderr).trim()}`);

    const deadline = Date.now() + (profile.connectTimeoutSeconds ?? config.connectTimeoutSeconds) * 1000;
    while (Date.now() < deadline) {
      if (await this.#isReady(container)) {
        this.#live.set(name, { redact });
        return this.#status(name, profile, 'connected', await this.#expiresAt(container, idle));
      }
      const state = await this.#inspect(container);
      if (!state?.running) await fail(`Tunnel "${name}" exited before connecting.`);
      await this.#sleep(500);
    }
    return fail(`Tunnel "${name}" did not connect within ${(profile.connectTimeoutSeconds ?? config.connectTimeoutSeconds)}s.`);
  }

  async disconnect(name: string): Promise<{ profile: string; state: 'stopped' }> {
    this.#live.delete(name);
    await this.#deps.docker(['rm', '-f', containerName(name)], { timeoutMs: 30_000 });
    return { profile: name, state: 'stopped' };
  }

  #status(name: string, profile: Profile, state: TunnelState, expiresAt?: string, logs?: string): TunnelStatus {
    return {
      profile: name,
      type: profile.type,
      ...(profile.description ? { description: profile.description } : {}),
      state,
      container: containerName(name),
      ...(profile.allowHosts ? { allowHosts: profile.allowHosts } : {}),
      ...(state === 'connected' && expiresAt ? { expiresAt } : {}),
      ...(logs ? { logs } : {}),
    };
  }

  async status(name?: string, { logs = false } = {}): Promise<TunnelStatus[]> {
    const config = this.#deps.loadConfig();
    const names = name ? [name] : Object.keys(config.profiles);
    return Promise.all(
      names.map(async (n) => {
        const profile = getProfile(config, n);
        const container = containerName(n);
        const info = await this.#inspect(container);
        let state: TunnelState = 'stopped';
        if (this.#pending.has(n)) state = 'connecting';
        else if (info?.running) state = (await this.#isReady(container)) ? 'connected' : 'connecting';
        else if (info) state = 'exited';
        const expires = state === 'connected' ? await this.#expiresAt(container, this.#idleSeconds(config, profile)) : undefined;
        // Logs only when this server knows the secrets to redact them with.
        const live = this.#live.get(n);
        const text = logs && info && live ? await this.#logs(container, live.redact) : undefined;
        return this.#status(n, profile, state, expires, text);
      })
    );
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const config = this.#deps.loadConfig();
    const profile = getProfile(config, req.profile);
    let current: HttpRequest = { ...req, url: this.#allowed(targetUrl(req.url), req.profile, profile.allowHosts) };
    const container = containerName(req.profile);
    if (!(await this.#isReady(container))) await this.connect(req.profile);
    for (let hop = 0; ; hop++) {
      const { args, input } = curlArgs(current);
      // lease-exec.sh extends the lease, then execs curl.
      const r = await this.#deps.docker(['exec', ...(input ? ['-i'] : []), container, '/vpnhop/lease-exec.sh', ...args], {
        input,
        timeoutMs: (current.timeoutSeconds + 15) * 1000,
        maxStdout: current.maxBodyBytes,
      });
      const response = parseCurl(r.code, r.stdout, r.stderr, r.truncated);
      if (!req.followRedirects || !response.redirectUrl || hop >= MAX_REDIRECTS) return response;
      current = this.#redirect(current, response, profile.allowHosts);
    }
  }

  #allowed(url: URL, name: string, allowHosts: string[] | undefined): string {
    if (!hostAllowed(url.hostname, allowHosts))
      throw new Error(`Host ${url.hostname} is not in allowHosts for profile "${name}": ${allowHosts?.join(', ')}`);
    return url.href;
  }

  /** Same method/body rules as browsers and `curl -L`; credentials dropped when the host changes. */
  #redirect(prev: HttpRequest, response: HttpResponse, allowHosts: string[] | undefined): HttpRequest {
    const from = new URL(prev.url);
    const to = targetUrl(new URL(response.redirectUrl!, from).href);
    const next: HttpRequest = { ...prev, url: this.#allowed(to, prev.profile, allowHosts) };
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && prev.method === 'POST')) {
      next.method = prev.method === 'HEAD' ? 'HEAD' : 'GET';
      delete next.body;
      delete next.bodyBase64;
    }
    if (to.host !== from.host) {
      next.headers = Object.fromEntries(
        Object.entries(prev.headers).filter(([k]) => !/^(authorization|cookie|proxy-authorization)$/i.test(k))
      );
    }
    return next;
  }

  /** The tunnel's SOCKS5 proxy for other tools (contract B): connects if needed, extends the lease. */
  async proxy(name: string): Promise<ProxyInfo> {
    const config = this.#deps.loadConfig();
    const profile = getProfile(config, name);
    const container = containerName(name);
    await this.connect(name);
    const socks = await this.#deps.docker(['exec', container, '/vpnhop/socks.sh'], { timeoutMs: 30_000 });
    if (socks.code !== 0) throw new Error(`Starting the SOCKS proxy failed: ${socks.stderr.trim().slice(0, 300)}`);
    const port = await this.#deps.docker(['port', container, '1080/tcp'], { timeoutMs: 20_000 });
    const m = /^127\.0\.0\.1:(\d+)$/m.exec(port.stdout.toString('utf8'));
    if (port.code !== 0 || !m) throw new Error('The tunnel has no loopback SOCKS port; disconnect and connect it again');
    const expiresAt = (await this.#expiresAt(container, this.#idleSeconds(config, profile))) ?? new Date().toISOString();
    return { profile: name, host: '127.0.0.1', port: Number(m[1]), expiresAt };
  }

  /** Drops what this process holds (fetched secrets, log redactors). Tunnels are shared and stay up. */
  forget(): void {
    this.#secrets.clear();
    this.#live.clear();
  }
}
