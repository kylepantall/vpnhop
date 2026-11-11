/**
 * Replaces secret values, and common encodings of them, with [REDACTED:NAME].
 * Best effort: a program can still transform a value in ways this misses.
 */

const MIN_LENGTH = 4;

export function redactor(secrets: Record<string, string>): (text: string) => string {
  const needles: [string, string][] = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length < MIN_LENGTH) continue;
    const bytes = Buffer.from(value, 'utf8');
    const variants = new Set([
      value,
      bytes.toString('base64'),
      bytes.toString('base64').replace(/=+$/, ''),
      bytes.toString('base64url'),
      encodeURIComponent(value),
      bytes.toString('hex'),
      JSON.stringify(value).slice(1, -1),
    ]);
    for (const variant of variants) if (variant.length >= MIN_LENGTH) needles.push([variant, name]);
  }
  // Longest first, so a value containing another value is replaced whole.
  needles.sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = text;
    for (const [needle, name] of needles) out = out.split(needle).join(`[REDACTED:${name}]`);
    return out;
  };
}
