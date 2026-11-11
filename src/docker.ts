import { spawn, spawnSync } from 'node:child_process';

export type DockerResult = { code: number; stdout: Buffer; stderr: string; truncated: boolean };
export type DockerOptions = { input?: Buffer | string; timeoutMs?: number; maxStdout?: number };
export type Docker = (args: string[], options?: DockerOptions) => Promise<DockerResult>;

const DEFAULT_TIMEOUT_MS = 120_000;

/** Runs the docker CLI without a shell. Never rejects on a non-zero exit; callers check `code`. */
export function createDocker(bin = process.env.VPNHOP_DOCKER ?? 'docker'): Docker {
  return (args, { input, timeoutMs = DEFAULT_TIMEOUT_MS, maxStdout = 64 << 20 } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const out: Buffer[] = [];
      let outLen = 0;
      let truncated = false;
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        if (outLen >= maxStdout) {
          truncated = true;
          return;
        }
        const room = maxStdout - outLen;
        if (chunk.length > room) truncated = true;
        out.push(chunk.subarray(0, room));
        outLen += Math.min(room, chunk.length);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 1 << 20) stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        reject(missing ? new Error(`docker CLI not found (${bin}). Install Docker Desktop or set VPNHOP_DOCKER.`) : error);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        const timedOut = signal === 'SIGKILL';
        resolve({
          code: timedOut ? 124 : (code ?? 1),
          stdout: Buffer.concat(out),
          stderr: timedOut ? `${stderr}\n[vpnhop] docker ${args[0]} timed out` : stderr,
          truncated,
        });
      });
      child.stdin.on('error', () => {}); // EPIPE when docker exits before reading input
      child.stdin.end(input ?? '');
    });
}

/** Synchronous best-effort removal, for process exit handlers. */
export function removeContainersSync(names: string[], bin = process.env.VPNHOP_DOCKER ?? 'docker'): void {
  if (names.length) spawnSync(bin, ['rm', '-f', ...names], { stdio: 'ignore', timeout: 20_000 });
}
