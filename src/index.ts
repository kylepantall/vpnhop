#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configPath, loadConfig, OPENCONNECT_PROTOCOLS, type Config } from './config.ts';
import { createDocker } from './docker.ts';
import { ensureImage } from './image.ts';
import { createKeyhop, keyhopBin } from './keyhop.ts';
import { openVpnConnectProfiles, planAdd, removeProfile, saveProfile, slug, type AddRequest } from './profiles.ts';
import { ask } from './prompt.ts';
import { refresh, runRefresh } from './refresh.ts';
import { createResolver } from './secrets.ts';
import { createServer } from './server.ts';
import { Tunnels } from './tunnels.ts';
import { runUpdateCommand } from './update.ts';
import { VERSION } from './version.ts';

const USAGE = `vpnhop ${VERSION} — API calls through a VPN, without connecting your machine

Profiles (secrets are encrypted in keyhop; only names go in ${configPath()}):
  vpnhop add <name> <file.ovpn|wg.conf> [--description T] [--allow-hosts a,b]
  vpnhop add <name> --type openconnect --server S [--protocol ${OPENCONNECT_PROTOCOLS.join('|')}] [--user U] [--server-cert PIN] [--totp]
  vpnhop add <name> --type ipsec --server S [--auth eap|psk] [--user U] [--remote-id ID] [--subnets 10.0.0.0/8,...]
  vpnhop import                  list OpenVPN Connect profiles; import <id> [--name N] saves one
  vpnhop list [--json]           profiles and tunnel state
  vpnhop remove <name>           delete a profile and its keyhop secrets

Tunnels:
  vpnhop connect <p> | disconnect <p> | status | get <p> <url>
  vpnhop proxy <p> [--json]      SOCKS5 proxy for other tools (hopsql); extends the lease

Maintenance:
  vpnhop [serve]                 MCP server on stdio
  vpnhop refresh                 recycle servers, stop stale/orphaned ones, remove dangling tunnels
  vpnhop update [--check] [--yes] [--json]
  vpnhop keyhop-register         (re)register this install as a keyhop client (Touch ID)
  vpnhop build                   rebuild the runtime image`;

const docker = createDocker();
const keyhop = createKeyhop();
const tunnels = new Tunnels({
  docker,
  keyhop,
  loadConfig: () => loadConfig(),
  resolver: (config, values) => createResolver(config.dir, process.env, values),
  ensureImage: () => ensureImage(docker),
});

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

/** Pulls `--flag value` / `--flag` out of args. */
function flags(args: string[]) {
  const take = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`);
    args.splice(i, 2);
    return value;
  };
  const has = (name: string): boolean => {
    const i = args.indexOf(name);
    if (i >= 0) args.splice(i, 1);
    return i >= 0;
  };
  const list = (name: string) => take(name)?.split(',').map((s) => s.trim()).filter(Boolean);
  return { take, has, list, rest: () => args.filter((a) => !a.startsWith('--')), unknown: () => args.find((a) => a.startsWith('--')) };
}

const configOrNull = (): Config | null => {
  try {
    return loadConfig();
  } catch {
    return null;
  }
};

async function add(args: string[]): Promise<void> {
  const f = flags(args);
  const req: AddRequest = {
    name: '',
    type: f.take('--type') as AddRequest['type'],
    server: f.take('--server'),
    protocol: f.take('--protocol') as AddRequest['protocol'],
    ipsecAuth: f.take('--auth') as AddRequest['ipsecAuth'],
    remoteId: f.take('--remote-id'),
    subnets: f.list('--subnets'),
    serverCert: f.take('--server-cert'),
    description: f.take('--description'),
    allowHosts: f.list('--allow-hosts'),
    username: f.take('--user'),
  };
  const wantTotp = f.has('--totp');
  const bad = f.unknown();
  if (bad) throw new Error(`Unknown option ${bad}`);
  const [name, file] = f.rest();
  if (!name) throw new Error('Usage: vpnhop add <name> <file> | vpnhop add <name> --type openconnect|ipsec --server S');
  req.name = name;
  req.file = file;
  const { needs } = planAdd(req);
  if (needs.includes('username')) req.username = await ask('VPN username: ');
  if (needs.includes('password')) req.password = await ask('VPN password: ', { secret: true });
  if (req.type === 'ipsec' && req.ipsecAuth === 'psk') req.psk = await ask('IPsec pre-shared key: ', { secret: true });
  if (wantTotp) req.totpSecret = await ask('TOTP secret (base32 seed, not a one-time code): ', { secret: true });
  const saved = await saveProfile(keyhop, req);
  print(saved);
  console.error(`Saved "${saved.profile}" (${saved.type}). Its secrets are in keyhop; you can delete the original file.`);
}

async function importConnect(args: string[]): Promise<void> {
  const f = flags(args);
  const name = f.take('--name');
  const [id] = f.rest();
  const profiles = openVpnConnectProfiles();
  if (!id) {
    if (!profiles.length) return console.log('No OpenVPN Connect profiles found.');
    for (const p of profiles) console.log(`${p.id}  ${p.name}   →  vpnhop import ${p.id} --name ${slug(p.name)}`);
    return;
  }
  const match = profiles.find((p) => p.id === id || p.name === id);
  if (!match) throw new Error(`No OpenVPN Connect profile "${id}". Run vpnhop import to list them.`);
  await add([name ?? slug(match.name), match.file, '--description', match.name]);
}

/** Pins this install with keyhop (contract A). Prompts Touch ID in keyhop. */
function keyhopRegister(): void {
  const entry = realpathSync(fileURLToPath(import.meta.url));
  const root = dirname(dirname(entry));
  const r = spawnSync(keyhopBin(), ['client', 'add', 'vpnhop', '--runtime', realpathSync(process.execPath), '--entry', entry, '--root', root], { stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`keyhop client add exited with ${r.status}`);
}

async function main(argv: string[]): Promise<void> {
  const [command = 'serve', ...rest] = argv;
  const [a, b] = rest;
  switch (command) {
    case 'serve': {
      const exit = () => process.exit(0);
      // Tunnels are shared and leased; nothing to tear down on exit.
      process.on('SIGINT', exit).on('SIGTERM', exit);
      // `vpnhop refresh` recycles current servers: drop cached secrets and state.
      process.on('SIGHUP', () => tunnels.forget());
      process.stdin.on('close', exit);
      const onRefresh = async () => {
        tunnels.forget();
        return refresh(docker, configOrNull());
      };
      await createServer(tunnels, () => loadConfig(), onRefresh, keyhop).connect(new StdioServerTransport());
      return;
    }
    case 'add':
      return add(rest);
    case 'import':
      return importConnect(rest);
    case 'remove':
      if (!a) break;
      await tunnels.disconnect(a).catch(() => {});
      return print(await removeProfile(keyhop, loadConfig(), a));
    case 'list': {
      const status = await tunnels.status();
      if (rest.includes('--json'))
        return console.log(JSON.stringify(status.map((s) => ({ name: s.profile, type: s.type, description: s.description, state: s.state }))));
      for (const s of status) console.log(`${s.profile.padEnd(20)} ${s.type.padEnd(12)} ${s.state.padEnd(10)} ${s.description ?? ''}`);
      return;
    }
    case 'proxy': {
      if (!a) break;
      const info = await tunnels.proxy(a);
      return rest.includes('--json') ? console.log(JSON.stringify(info)) : console.log(`socks5h://${info.host}:${info.port}  (until ${info.expiresAt})`);
    }
    case 'keyhop-register':
      return keyhopRegister();
    case 'build':
      return print({ image: await ensureImage(docker, { rebuild: true }) });
    case 'status':
      return print(await tunnels.status());
    case 'connect':
      if (!a) break;
      return print(await tunnels.connect(a));
    case 'disconnect':
      if (!a) break;
      return print(await tunnels.disconnect(a));
    case 'get': {
      if (!a || !b) break;
      return print(
        await tunnels.request({ profile: a, url: b, method: 'GET', headers: {}, timeoutSeconds: 30, followRedirects: true, insecure: false, maxBodyBytes: 1 << 20 })
      );
    }
    case 'refresh':
      return runRefresh(docker, configOrNull(), rest);
    case 'update':
      return runUpdateCommand(rest, VERSION);
    case '-v':
    case '--version':
      return console.log(VERSION);
    case 'help':
    case '-h':
    case '--help':
      return console.log(USAGE);
  }
  console.error(USAGE);
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
