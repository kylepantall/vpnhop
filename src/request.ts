import { z } from 'zod';

export const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const;

export const RequestInput = {
  profile: z.string().min(1).describe('Profile name from list_profiles. Connects automatically if needed.'),
  url: z.url({ protocol: /^https?$/ }).describe('http(s) URL, resolved and fetched inside the tunnel.'),
  method: z.enum(HTTP_METHODS).default('GET'),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional().describe('Request body as text.'),
  bodyBase64: z.string().optional().describe('Request body as base64, for binary payloads.'),
  timeoutSeconds: z.number().int().min(1).max(300).default(30),
  followRedirects: z.boolean().default(false),
  insecure: z.boolean().default(false).describe('Skip TLS verification (self-signed internal hosts).'),
  maxBodyBytes: z.number().int().min(1).max(10 << 20).default(1 << 20),
};
const RequestSchema = z.object(RequestInput);
export type HttpRequest = z.infer<typeof RequestSchema>;

export type HttpResponse = {
  status: number;
  /** Set when the response is a redirect that was not followed. */
  redirectUrl?: string;
  url: string;
  headers: Record<string, string[]>;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  truncated: boolean;
  timeMs: number;
};

const META = '\n__VPNHOP_META__';

/**
 * The one parsed form of a URL that is both checked against allowHosts and handed to curl.
 * Passing the raw string lets parser differences (e.g. `http://allowed\\@evil/`) pick another host.
 */
export function targetUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http(s) URLs are allowed: ${url.protocol}`);
  if (url.username || url.password) throw new Error('URLs with credentials (user:pass@) are not allowed; use an Authorization header');
  return url;
}
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** curl argv run inside the container. No shell: every value is its own argument. */
export function curlArgs(req: HttpRequest): { args: string[]; input?: Buffer } {
  const args = [
    'curl', '-sS', '--globoff',
    '--proto', '=http,https', '--proto-redir', '=http,https',
    '--max-time', String(req.timeoutSeconds),
    '-w', `%{stderr}${META}%{json}${META}%{header_json}`,
  ];
  // curl wants --head rather than -X HEAD, or it waits for a body that never comes.
  args.push(...(req.method === 'HEAD' ? ['--head', '-o', '/dev/null'] : ['-X', req.method]));
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HEADER_NAME.test(name)) throw new Error(`Invalid header name: ${name}`);
    if (/[\r\n\0]/.test(value)) throw new Error(`Header ${name} contains a newline`);
    // "Name;" is curl's syntax for sending a header with an empty value.
    args.push('-H', value === '' ? `${name};` : `${name}: ${value}`);
  }
  // Redirects are followed by the caller, one hop at a time, so each hop is re-checked against allowHosts.
  if (req.insecure) args.push('-k');
  let input: Buffer | undefined;
  if (req.body !== undefined && req.bodyBase64 !== undefined) throw new Error('Give body or bodyBase64, not both');
  if (req.body !== undefined) input = Buffer.from(req.body, 'utf8');
  if (req.bodyBase64 !== undefined) input = Buffer.from(req.bodyBase64, 'base64');
  if (input) args.push('--data-binary', '@-');
  args.push('--url', targetUrl(req.url).href);
  return { args, input };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

export function parseCurl(code: number, stdout: Buffer, stderr: string, truncated: boolean): HttpResponse {
  const [errors = '', metaJson, headerJson] = stderr.split(META);
  if (code !== 0 || !metaJson) {
    const message = errors.replace(/^curl: /gm, '').trim() || `curl exited with ${code}`;
    throw new Error(`Request failed inside the tunnel: ${message}`);
  }
  const meta = JSON.parse(metaJson) as { http_code: number; url_effective: string; time_total: number; redirect_url?: string };
  const headers = headerJson ? (JSON.parse(headerJson) as Record<string, string[]>) : {};
  let body: string;
  let bodyEncoding: 'utf8' | 'base64' = 'utf8';
  try {
    body = utf8.decode(stdout);
  } catch {
    // A cut-off multi-byte character is still text; anything else is binary.
    body = truncated ? stdout.toString('utf8') : stdout.toString('base64');
    if (!truncated) bodyEncoding = 'base64';
  }
  return {
    status: meta.http_code,
    ...(meta.redirect_url ? { redirectUrl: meta.redirect_url } : {}),
    url: meta.url_effective,
    headers,
    body,
    bodyEncoding,
    truncated,
    timeMs: Math.round(meta.time_total * 1000),
  };
}
