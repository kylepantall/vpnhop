import { createInterface } from 'node:readline/promises';

/** Asks on the terminal; `secret` hides what is typed. Never used by the MCP server. */
export async function ask(question: string, { secret = false } = {}): Promise<string> {
  if (!process.stdin.isTTY) throw new Error(`${question.replace(/:\s*$/, '')} is needed; run this in a terminal`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (secret) {
    // Echo nothing for typed characters, but still show the question.
    const write = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
      if (s.startsWith(question) || s === '\r\n' || s === '\n') write.call(rl, s);
    };
  }
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
    if (secret) process.stdout.write('\n');
  }
}
