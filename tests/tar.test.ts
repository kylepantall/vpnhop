import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { tar } from '../src/tar.ts';

test('system tar can list and read the archive', () => {
  const archive = tar([{ name: 'vpn', dir: true }, { name: 'vpn/a.txt', data: 'hello' }, { name: 'vpn/big', data: Buffer.alloc(1500, 1) }]);
  const list = execFileSync('tar', ['-tvf', '-'], { input: archive }).toString();
  assert.match(list, /vpn\/a\.txt/);
  assert.match(list, /-rw------- .*vpn\/a\.txt/);
  assert.equal(execFileSync('tar', ['-xOf', '-', 'vpn/a.txt'], { input: archive }).toString(), 'hello');
  assert.equal(execFileSync('tar', ['-xOf', '-', 'vpn/big'], { input: archive }).length, 1500);
});
