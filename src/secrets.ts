import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { SecretRef } from './config.ts';
import { resolvePath } from './config.ts';

const run = promisify(execFile);

export type SecretResolver = (ref: SecretRef, label: string) => Promise<string>;

/**
 * Trailing newlines are dropped: env/file/command values almost always carry one by accident.
 * keyhop refs are fetched up front in one call (one Touch ID) and passed in as `keyhop`.
 */
export function createResolver(baseDir: string, env: NodeJS.ProcessEnv = process.env, keyhop: Record<string, string> = {}): SecretResolver {
  return async (ref, label) => {
    let value: string;
    if ('keyhop' in ref) {
      const v = keyhop[ref.keyhop];
      if (v === undefined) throw new Error(`${label}: keyhop secret ${ref.keyhop} was not fetched`);
      // Profile files keep their own trailing newline.
      return v;
    } else if ('env' in ref) {
      const v = env[ref.env];
      if (v === undefined) throw new Error(`${label}: environment variable ${ref.env} is not set`);
      value = v;
    } else if ('file' in ref) {
      try {
        value = await readFile(resolvePath(ref.file, baseDir), 'utf8');
      } catch {
        throw new Error(`${label}: cannot read secret file ${ref.file}`);
      }
    } else {
      const [cmd, ...args] = ref.command as [string, ...string[]];
      try {
        value = (await run(cmd, args, { timeout: 120_000, maxBuffer: 1 << 20 })).stdout;
      } catch (error) {
        // stderr only: stdout could hold a partial secret.
        const stderr = String((error as { stderr?: string }).stderr ?? '').trim().slice(0, 300);
        throw new Error(`${label}: secret command ${cmd} failed${stderr ? `: ${stderr}` : ''}`);
      }
    }
    value = value.replace(/[\r\n]+$/, '');
    if (!value) throw new Error(`${label}: secret is empty`);
    return value;
  };
}
