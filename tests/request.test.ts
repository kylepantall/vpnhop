import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { HttpRequest } from '../src/request.ts';
import { curlArgs, parseCurl, targetUrl } from '../src/request.ts';

const base: HttpRequest = {
  profile: 'p', url: 'https://api.internal/x?a=1', method: 'GET', headers: {}, timeoutSeconds: 30,
  followRedirects: false, insecure: false, maxBodyBytes: 1024,
};
const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test('builds an argv with the URL passed via --url and protocols locked to http(s)', () => {
  const { args, input } = curlArgs({ ...base, method: 'POST', headers: { 'X-Api-Key': 'k', Empty: '' }, body: '{"a":1}' });
  assert.equal(args[0], 'curl');
  assert.equal(valueAfter(args, '--url'), base.url);
  assert.equal(valueAfter(args, '--proto'), '=http,https');
  assert.equal(valueAfter(args, '-X'), 'POST');
  assert.ok(args.includes('X-Api-Key: k'));
  assert.ok(args.includes('Empty;'));
  assert.equal(valueAfter(args, '--data-binary'), '@-');
  assert.deepEqual(input, Buffer.from('{"a":1}'));
  assert.ok(!args.includes('-k') && !args.includes('-L'));
});

test('HEAD uses --head, base64 bodies decode, flags opt in', () => {
  const { args, input } = curlArgs({ ...base, method: 'HEAD', bodyBase64: 'AAE=', insecure: true, followRedirects: true });
  assert.ok(args.includes('--head') && !args.includes('-X'));
  assert.deepEqual(input, Buffer.from([0, 1]));
  assert.ok(args.includes('-k') && !args.includes('-L'));
});

test('curl gets the normalised URL, so parser tricks cannot change the host', () => {
  const { args } = curlArgs({ ...base, url: 'http://allowed.example\\@127.0.0.1:9/x' });
  assert.equal(new URL(valueAfter(args, '--url')!).hostname, 'allowed.example');
  assert.throws(() => curlArgs({ ...base, url: 'http://user:pw@api.internal/' }));
  assert.throws(() => targetUrl('file:///vpn/auth.txt'));
});

test('rejects header injection and file-reading header names', () => {
  assert.throws(() => curlArgs({ ...base, headers: { 'A': 'x\r\nB: y' } }));
  assert.throws(() => curlArgs({ ...base, headers: { '@/etc/passwd': 'x' } }));
  assert.throws(() => curlArgs({ ...base, body: 'a', bodyBase64: 'YQ==' }));
});

const META = '\n__VPNHOP_META__';
const meta = JSON.stringify({ http_code: 201, url_effective: 'https://api.internal/x', time_total: 0.25 });
const headers = JSON.stringify({ 'content-type': ['application/json'] });

test('parses status, headers and text body', () => {
  const r = parseCurl(0, Buffer.from('{"ok":true}'), `${META}${meta}${META}${headers}`, false);
  assert.equal(r.status, 201);
  assert.equal(r.bodyEncoding, 'utf8');
  assert.equal(r.body, '{"ok":true}');
  assert.deepEqual(r.headers['content-type'], ['application/json']);
  assert.equal(r.timeMs, 250);
});

test('binary bodies are base64; curl failures throw', () => {
  const r = parseCurl(0, Buffer.from([0xff, 0xfe, 0x00]), `${META}${meta}${META}{}`, false);
  assert.equal(r.bodyEncoding, 'base64');
  assert.equal(Buffer.from(r.body, 'base64').length, 3);
  assert.throws(() => parseCurl(6, Buffer.alloc(0), `curl: (6) Could not resolve host${META}${meta}${META}{}`, false));
});
