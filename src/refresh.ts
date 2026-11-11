/**
 * Refresh this install's MCP servers and close dangling tunnels:
 * - servers older than the installed build, or orphaned (their client died, ppid 1): SIGTERM.
 *   Each client starts the installed version on reconnect.
 * - current servers: SIGHUP, which drops the secrets and state they cached.
 * - tunnels are shared and leased, so healthy ones stay up. Removed: stopped tunnels, tunnels
 *   for profiles no longer in the config, and tunnels built from an older profile or image
 *   (the next call recreates those). Runtime images from older builds are deleted.
 * Shared by `vpnhop refresh` and the `refresh` tool. Mirrors hopsql's refresh.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Config } from './config.ts';
import type { Docker } from './docker.ts';
import { runtimeImageTag } from './image.ts';
import { profileHash } from './tunnels.ts';

export interface ServerProcess {
  pid: number;
  ppid: number;
  startedAt: Date;
}

export interface RefreshResult {
  /** Older than the installed build or orphaned: stopped, reconnect to restart. */
  stopped: number[];
  /** Current: told to drop cached secrets and state. */
  recycled: number[];
  failed: number[];
  /** Stopped, orphaned (profile deleted) or outdated tunnel containers. */
  removedTunnels: { container: string; reason: string }[];
  removedImages: string[];
}

const realpathOrNull = (file: string) => {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
};

/**
 * Servers of this install in `ps -axo pid=,ppid=,lstart=,command=` output: the bare entry point
 * (`index.ts` or `index.ts serve`), never a CLI subcommand. Paths are resolved so a launcher
 * symlink or a path with spaces still matches `entry`.
 */
export function findServers(
  psOutput: string,
  entry: string,
  selfPid: number,
  resolvePath: (file: string) => string | null = realpathOrNull
): ServerProcess[] {
  const servers: ServerProcess[] = [];
  for (const line of psOutput.split('\n')) {
    // lstart is fixed-width: "Mon Nov  2 08:54:37 2026".
    const match = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, pid, ppid, started, command] = match as unknown as [string, string, string, string, string];
    const tail = /src[\\/]index\.ts(\s+serve)?\s*$/.exec(command);
    if (!tail || Number(pid) === selfPid) continue;
    const end = tail.index + tail[0].length - (tail[1]?.length ?? 0);
    const script = command.slice(0, end).trimEnd();
    const ours = [...script.matchAll(/ (?=\S)/g)].some((space) => resolvePath(script.slice(space.index + 1)) === entry);
    if (ours) servers.push({ pid: Number(pid), ppid: Number(ppid), startedAt: new Date(started) });
  }
  return servers;
}

/** Started before the build: lstart has one-second resolution, so allow that much. */
export function isStale(server: ServerProcess, builtAt: Date): boolean {
  return server.startedAt.getTime() + 1000 < builtAt.getTime();
}

/** The installed entry point and when it was installed (install.sh writes app/.installed). */
export function installedEntry(entry = process.argv[1]!): { path: string; builtAt: Date } {
  const path = realpathSync(entry);
  const marker = join(dirname(dirname(path)), '.installed');
  let builtAt: Date;
  try {
    builtAt = statSync(marker).mtime;
  } catch {
    builtAt = statSync(path).mtime;
  }
  return { path, builtAt };
}

export function refreshServers(
  selfPid = process.pid,
  entry = process.argv[1]!,
  signal: (pid: number, name: NodeJS.Signals) => void = (pid, name) => process.kill(pid, name)
): Pick<RefreshResult, 'stopped' | 'recycled' | 'failed'> {
  const result = { stopped: [] as number[], recycled: [] as number[], failed: [] as number[] };
  if (process.platform === 'win32') return result;
  const { path, builtAt } = installedEntry(entry);
  const servers = findServers(execFileSync('ps', ['-axo', 'pid=,ppid=,lstart=,command='], { encoding: 'utf8' }), path, selfPid);
  for (const server of servers) {
    const stop = isStale(server, builtAt) || server.ppid === 1;
    try {
      // SIGTERM runs the server's shutdown, which removes the tunnels it owns.
      signal(server.pid, stop ? 'SIGTERM' : 'SIGHUP');
      (stop ? result.stopped : result.recycled).push(server.pid);
    } catch {
      result.failed.push(server.pid);
    }
  }
  return result;
}

/** Why a tunnel container should go, or null to keep it. */
export function danglingReason(c: { state: string; profile: string; hash: string }, config: Config | null, image: string): string | null {
  if (c.state !== 'running') return `not running (${c.state})`;
  if (!config) return null; // can't judge profiles without a config; leave running tunnels alone
  const profile = Object.hasOwn(config.profiles, c.profile) ? config.profiles[c.profile] : undefined;
  if (!profile) return 'profile no longer in config';
  if (c.hash !== profileHash(profile, image)) return 'profile or runtime changed';
  return null;
}

export async function removeDangling(docker: Docker, config: Config | null): Promise<Pick<RefreshResult, 'removedTunnels' | 'removedImages'>> {
  const removedTunnels: RefreshResult['removedTunnels'] = [];
  const removedImages: string[] = [];
  const image = runtimeImageTag();
  const ps = await docker(['ps', '-a', '--filter', 'label=vpnhop.profile', '--format', '{{.Names}}\t{{.State}}\t{{.Label "vpnhop.profile"}}\t{{.Label "vpnhop.hash"}}']);
  for (const line of ps.stdout.toString('utf8').split('\n').filter(Boolean)) {
    const [container = '', state = '', profile = '', hash = ''] = line.split('\t');
    const reason = danglingReason({ state, profile, hash }, config, image);
    if (reason && (await docker(['rm', '-f', container])).code === 0) removedTunnels.push({ container, reason });
  }
  const images = await docker(['images', '--filter', 'label=vpnhop.runtime=1', '--format', '{{.Repository}}:{{.Tag}}']);
  for (const tag of new Set(images.stdout.toString('utf8').split('\n').filter(Boolean))) {
    if (tag === image || tag.endsWith(':<none>')) continue;
    if ((await docker(['rmi', tag])).code === 0) removedImages.push(tag);
  }
  return { removedTunnels, removedImages };
}

export const RECONNECT_HINT =
  'Reconnect vpnhop in each MCP client (Claude Code: /mcp → vpnhop → Reconnect) to start the installed version.';

export async function refresh(docker: Docker, config: Config | null, { selfPid = process.pid } = {}): Promise<RefreshResult> {
  const servers = refreshServers(selfPid);
  return { ...servers, ...(await removeDangling(docker, config)) };
}

export async function runRefresh(docker: Docker, config: Config | null, args: string[]): Promise<void> {
  if (args.length) throw new Error(`Unknown option: ${args[0]}. Usage: vpnhop refresh`);
  if (process.platform === 'win32') throw new Error('vpnhop refresh is not available on Windows; restart your MCP client instead.');
  const r = await refresh(docker, config);
  const say = (line: string) => process.stdout.write(line + '\n');
  say(`Recycled ${r.recycled.length} current server(s): cached secrets dropped.`);
  say(`Stopped ${r.stopped.length} outdated or orphaned server(s).`);
  say(`Removed ${r.removedTunnels.length} dangling tunnel(s) and ${r.removedImages.length} old image(s).`);
  for (const t of r.removedTunnels) say(`  ${t.container}: ${t.reason}`);
  if (r.stopped.length) say(RECONNECT_HINT);
  if (r.failed.length) say(`Could not signal: ${r.failed.join(', ')}`);
}
