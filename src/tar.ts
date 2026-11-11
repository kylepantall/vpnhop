/** Minimal in-memory ustar writer, so staged secrets go to `docker cp -` without touching the host disk. */

export type TarEntry = { name: string; data?: Buffer | string; mode?: number; dir?: boolean };

function header(name: string, size: number, mode: number, type: '0' | '5'): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar: name too long: ${name}`);
  const h = Buffer.alloc(512);
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, '0') + '\0';
  h.write(name, 0, 100);
  h.write(oct(mode, 8), 100);
  h.write(oct(0, 8), 108); // uid root
  h.write(oct(0, 8), 116); // gid root
  h.write(oct(size, 12), 124);
  h.write(oct(Math.floor(Date.now() / 1000), 12), 136);
  h.write('        ', 148); // checksum placeholder
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write('root', 265);
  h.write('root', 297);
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

export function tar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (entry.dir) {
      parts.push(header(entry.name.replace(/\/?$/, '/'), 0, entry.mode ?? 0o755, '5'));
      continue;
    }
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    parts.push(header(entry.name, data.length, entry.mode ?? 0o600, '0'), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
