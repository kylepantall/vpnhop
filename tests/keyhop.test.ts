import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKeyhop, KeyhopError, type KeyhopRunner } from '../src/keyhop.ts';

const runner = (code: number, stdout = '', stderr = ''): KeyhopRunner & { calls: [string[], unknown][] } => {
  const calls: [string[], unknown][] = [];
  const run = (async (args: string[], input: string) => {
    calls.push([args, JSON.parse(input)]);
    return { code, stdout, stderr };
  }) as KeyhopRunner & { calls: typeof calls };
  run.calls = calls;
  return run;
};

test('get sends one request naming the client, names and purpose', async () => {
  const run = runner(0, JSON.stringify({ values: { VPNHOP_A_CONFIG: 'x', VPNHOP_A_PASSWORD: 'y' } }));
  const values = await createKeyhop(run).get(['VPNHOP_A_CONFIG', 'VPNHOP_A_PASSWORD'], 'Connect VPN profile "a"');
  assert.deepEqual(values, { VPNHOP_A_CONFIG: 'x', VPNHOP_A_PASSWORD: 'y' });
  assert.deepEqual(run.calls[0]![0], ['client', 'get']);
  assert.deepEqual(run.calls[0]![1], { client: 'vpnhop', names: ['VPNHOP_A_CONFIG', 'VPNHOP_A_PASSWORD'], purpose: 'Connect VPN profile "a"' });
});

test('no names, no call; empty put, no call', async () => {
  const run = runner(0, '{}');
  const k = createKeyhop(run);
  assert.deepEqual(await k.get([], 'p'), {});
  await k.put({}, [], 'p');
  assert.equal(run.calls.length, 0);
});

test('contract exit codes become KeyhopError with the code; values never echoed', async () => {
  for (const code of [2, 3, 4, 5, 1]) {
    const err = await createKeyhop(runner(code, 'SECRET-ON-STDOUT', 'why')).get(['N'], 'p').catch((e) => e);
    assert.ok(err instanceof KeyhopError);
    assert.equal(err.code, code);
    assert.ok(!String(err.message).includes('SECRET-ON-STDOUT'));
  }
});

test('a missing value in an OK answer is an error', async () => {
  const err = await createKeyhop(runner(0, JSON.stringify({ values: {} }))).get(['N'], 'p').catch((e) => e);
  assert.equal(err.code, 5);
});
