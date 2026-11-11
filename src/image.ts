import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Docker } from './docker.ts';
import { tar } from './tar.ts';

const RUNTIME_DIR = fileURLToPath(new URL('../runtime/', import.meta.url));
const FILES = ['Dockerfile', 'entrypoint.sh', 'openvpn-route-up.sh', 'openconnect-script.sh', 'lease-exec.sh', 'socks.sh'] as const;

function context(): { files: { name: string; data: Buffer; mode: number }[]; tag: string } {
  const hash = createHash('sha256');
  const files = FILES.map((name) => {
    const data = readFileSync(RUNTIME_DIR + name);
    hash.update(name).update(data);
    return { name, data, mode: name.endsWith('.sh') ? 0o755 : 0o644 };
  });
  // Content-addressed tag: editing a runtime file rebuilds the image on next connect.
  return { files, tag: `vpnhop-runtime:${hash.digest('hex').slice(0, 12)}` };
}

export const runtimeImageTag = (): string => context().tag;

export async function ensureImage(docker: Docker, { rebuild = false } = {}): Promise<string> {
  const { files, tag } = context();
  if (!rebuild && (await docker(['image', 'inspect', tag], { timeoutMs: 20_000 })).code === 0) return tag;
  const result = await docker(['build', '--label', 'vpnhop.runtime=1', '-t', tag, '-'], {
    input: tar(files),
    timeoutMs: 600_000,
  });
  if (result.code !== 0) throw new Error(`Building the vpnhop runtime image failed:\n${result.stderr.slice(-2000)}`);
  return tag;
}
