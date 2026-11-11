/** `vpnhop update [--check] [--yes] [--json]`: compare with the latest GitHub release and rerun the installer for it. */

import { createInterface } from 'node:readline/promises';
import { getUpdateStatus, installLocation, runUpdate } from './update-check.ts';

async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${message} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export async function runUpdateCommand(args: string[], version: string): Promise<void> {
  const unknown = args.find((arg) => !['--check', '--yes', '-y', '--json'].includes(arg));
  if (unknown) throw new Error(`Unknown option: ${unknown}. Usage: vpnhop update [--check] [--yes] [--json]`);
  const json = args.includes('--json');
  const say = (line: string) => process.stdout.write(line + '\n');
  const status = await getUpdateStatus(version);
  if (json) say(JSON.stringify(status));
  else if (!status.latest) say(`vpnhop ${version}: no release is published yet.`);
  else if (!status.updateAvailable) say(`vpnhop ${version} is up to date (latest release: ${status.latest.version}).`);
  else say(`vpnhop ${status.latest.version} is available (installed: ${version}).\n${status.latest.url}`);
  if (!status.updateAvailable || args.includes('--check')) return;

  const location = installLocation();
  if (!location)
    throw new Error('This copy was not installed by scripts/install.sh; update the checkout with git pull && npm install.');
  if (!args.includes('--yes') && !args.includes('-y')) {
    if (!process.stdin.isTTY) throw new Error('Rerun with --yes to install without a prompt.');
    if (!(await confirm(`Install vpnhop ${status.latest!.version}?`))) return;
  }
  await runUpdate(status.latest!.tag, location);
  // The installer ends with `vpnhop refresh`, so servers on the old build are already stopped.
  say(`Updated to ${status.latest!.version}. Reconnect vpnhop in your MCP clients to load it.`);
}

