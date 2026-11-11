import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
// Stable release tags only; they go into download URLs and the installer's ref.
const TAG_PATTERN = /^v?\d+\.\d+\.\d+$/;

export function isNewerVersion(current: string, latest: string): boolean {
  if (!VERSION_PATTERN.test(latest)) return false;
  const installed = current.split('-')[0]!.split('.').map(Number);
  const available = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (available[i] !== installed[i]) return available[i]! > installed[i]!;
  }
  return false;
}

/** The GitHub repository releases come from; VPNHOP_REPO matches the installer. */
export function updateRepository(env = process.env): string {
  const repo = env.VPNHOP_REPO || 'kylepantall/vpnhop';
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.split('/').some((part) => /^\.+$/.test(part)))
    throw new Error('Invalid VPNHOP_REPO');
  return repo;
}

export interface LatestRelease {
  version: string;
  tag: string;
  url: string;
}

export interface UpdateStatus {
  current: string;
  /** null when the repository has no stable release yet. */
  latest: LatestRelease | null;
  updateAvailable: boolean;
}

/** Latest stable release via the web redirect (the unauthenticated API is rate limited per IP). */
export async function fetchLatestRelease(env = process.env, fetcher: typeof fetch = fetch): Promise<LatestRelease | null> {
  const source = `https://github.com/${updateRepository(env)}`;
  const response = await fetcher(`${source}/releases/latest`, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'User-Agent': 'vpnhop-update-check' },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) throw new Error(`No GitHub repository at ${source} (or it is private)`);
  if (response.status < 300 || response.status >= 400) throw new Error(`GitHub release check failed (HTTP ${response.status})`);
  // With no release published, GitHub redirects to the release list instead.
  const match = /\/releases\/tag\/([^/?#]+)$/.exec(response.headers.get('location') ?? '');
  if (!match) return null;
  const tag = decodeURIComponent(match[1]!);
  const version = tag.replace(/^v/, '');
  if (!TAG_PATTERN.test(tag) || !VERSION_PATTERN.test(version)) throw new Error('GitHub returned an unexpected release tag');
  return { version, tag, url: `${source}/releases/tag/${tag}` };
}

export async function getUpdateStatus(current: string, env = process.env, fetcher: typeof fetch = fetch): Promise<UpdateStatus> {
  const latest = await fetchLatestRelease(env, fetcher);
  return { current, latest, updateAvailable: latest !== null && isNewerVersion(current, latest.version) };
}

export interface InstallLocation {
  installDir: string;
  binDir?: string;
}

/**
 * Where install.sh put this copy: `<installDir>/app/src/index.ts`.
 * Null for a source checkout, which the installer does not own.
 */
export function installLocation(entry = process.argv[1], env = process.env): InstallLocation | null {
  if (!entry) return null;
  let resolved: string;
  try {
    resolved = realpathSync(entry);
  } catch {
    return null;
  }
  const src = dirname(resolved);
  const app = dirname(src);
  if (basename(src) !== 'src' || basename(app) !== 'app') return null;
  const launcher = env.VPNHOP_LAUNCHER;
  return { installDir: dirname(app), ...(launcher && isAbsolute(launcher) ? { binDir: dirname(launcher) } : {}) };
}

/**
 * Reruns the installer pinned to `tag` against the existing install directory. The installer
 * builds into a staging directory and swaps it in, so a failed update leaves the install
 * untouched. Client registrations are kept.
 */
export async function runUpdate(tag: string, location: InstallLocation, env = process.env, fetcher: typeof fetch = fetch): Promise<void> {
  if (!TAG_PATTERN.test(tag)) throw new Error('Invalid release tag');
  const repo = updateRepository(env);
  const response = await fetcher(`https://raw.githubusercontent.com/${repo}/${tag}/scripts/install.sh`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Could not download the ${tag} installer (HTTP ${response.status})`);
  const directory = await mkdtemp(join(tmpdir(), 'vpnhop-update-'));
  try {
    const file = join(directory, 'install.sh');
    await writeFile(file, await response.text(), { mode: 0o700 });
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      VPNHOP_REPO: repo,
      VPNHOP_INSTALL_DIR: location.installDir,
      ...(location.binDir ? { VPNHOP_BIN_DIR: location.binDir } : {}),
    };
    // A local checkout would replace the release with whatever is on disk.
    delete childEnv.VPNHOP_SOURCE_DIR;
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('bash', [file, tag], { env: childEnv, stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (code !== 0) throw new Error(`Installer exited with code ${code}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
