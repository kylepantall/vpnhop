/**
 * Client for keyhop's suite interface (docs/suite.md, contract A). keyhop runs as a direct
 * child, verifies this process is the pinned vpnhop install, prompts Touch ID, and answers
 * on stdout. Values never leave this process except into a tunnel container.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CLIENT = 'vpnhop';
const TIMEOUT_MS = 180_000; // the user may be reading a dialog
const MAX_OUTPUT = 32 << 20;

export class KeyhopError extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

const HINTS: Record<number, string> = {
  2: 'Touch ID was cancelled.',
  3: 'keyhop does not recognise this vpnhop install. Register it by rerunning the vpnhop installer (or: vpnhop keyhop-register).',
  4: 'The request was denied in keyhop’s dialog.',
  5: 'keyhop has no secret with that name; re-add the profile with vpnhop add.',
};

/** $VPNHOP_KEYHOP_BIN, else ~/.local/bin/keyhop, else keyhop on PATH. */
export function keyhopBin(env = process.env): string {
  if (env.VPNHOP_KEYHOP_BIN) return env.VPNHOP_KEYHOP_BIN;
  const local = join(homedir(), '.local', 'bin', 'keyhop');
  return existsSync(local) ? local : 'keyhop';
}

export type KeyhopRunner = (args: string[], input: string) => Promise<{ code: number; stdout: string; stderr: string }>;

export const runKeyhop: KeyhopRunner = (args, input) =>
  new Promise((resolve, reject) => {
    const bin = keyhopBin();
    // No shell; stdin carries the request. keyhop must be our direct child (it checks its parent).
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.stdout.on('data', (c: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 1 << 16) stderr += c.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new KeyhopError(`keyhop is not installed (${bin}). Install it: https://github.com/kylepantall/keyhop`, 127)
          : error
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });

async function call<T>(run: KeyhopRunner, sub: 'get' | 'put', request: object): Promise<T> {
  const r = await run(['client', sub], JSON.stringify({ client: CLIENT, ...request }));
  if (r.code !== 0) {
    // keyhop's stderr never carries values (contract A); keep it short anyway.
    const detail = r.stderr.trim().split('\n')[0]?.slice(0, 300);
    throw new KeyhopError(`keyhop ${sub} failed: ${HINTS[r.code] ?? detail ?? `exit ${r.code}`}${HINTS[r.code] && detail ? ` (${detail})` : ''}`, r.code);
  }
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new KeyhopError(`keyhop ${sub} returned unexpected output`, 1);
  }
}

export type Keyhop = {
  get(names: string[], purpose: string): Promise<Record<string, string>>;
  put(values: Record<string, string>, remove: string[], purpose: string): Promise<void>;
};

export function createKeyhop(run: KeyhopRunner = runKeyhop): Keyhop {
  return {
    async get(names, purpose) {
      if (!names.length) return {};
      const { values } = await call<{ values: Record<string, string> }>(run, 'get', { names, purpose });
      const missing = names.filter((n) => typeof values?.[n] !== 'string');
      if (missing.length) throw new KeyhopError(`keyhop did not return: ${missing.join(', ')}`, 5);
      return values;
    },
    async put(values, remove, purpose) {
      if (!Object.keys(values).length && !remove.length) return;
      await call(run, 'put', { values, remove, purpose });
    },
  };
}
