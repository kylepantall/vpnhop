import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createResolver } from '../src/secrets.ts';

const dir = mkdtempSync(join(tmpdir(), 'vpnhop-secrets-'));
writeFileSync(join(dir, 'pw.txt'), 's3cret-file\n');
const resolve = createResolver(dir, { PW: 's3cret-env\r\n' });

test('resolves env, relative file and command refs, trimming trailing newlines', async () => {
  assert.equal(await resolve({ env: 'PW' }, 'password'), 's3cret-env');
  assert.equal(await resolve({ file: 'pw.txt' }, 'password'), 's3cret-file');
  assert.equal(await resolve({ command: ['printf', 'from-cmd\n'] }, 'password'), 'from-cmd');
});

test('missing or empty sources reject', async () => {
  await assert.rejects(resolve({ env: 'MISSING' }, 'password'));
  await assert.rejects(resolve({ file: 'nope.txt' }, 'password'));
  await assert.rejects(resolve({ command: ['false'] }, 'password'));
  await assert.rejects(resolve({ command: ['printf', ''] }, 'password'));
});
