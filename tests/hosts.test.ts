import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hostAllowed } from '../src/hosts.ts';

test('no allowlist allows everything', () => assert.equal(hostAllowed('anything.com', undefined), true));

test('exact, wildcard, CIDR and star patterns', () => {
  const p = ['api.internal', '*.corp.example', '10.0.0.0/8'];
  assert.equal(hostAllowed('API.internal', p), true);
  assert.equal(hostAllowed('svc.corp.example', p), true);
  assert.equal(hostAllowed('corp.example', p), false);
  assert.equal(hostAllowed('evilcorp.example', p), false);
  assert.equal(hostAllowed('10.20.30.40', p), true);
  assert.equal(hostAllowed('11.0.0.1', p), false);
  assert.equal(hostAllowed('example.com', p), false);
  assert.equal(hostAllowed('example.com', ['*']), true);
  assert.equal(hostAllowed('1.2.3.4', ['0.0.0.0/0']), true);
});
