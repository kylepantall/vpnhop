#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { createDocker } from './docker.ts';
import { ensureImage } from './image.ts';
import { refresh, runRefresh } from './refresh.ts';
import { runUpdateCommand } from './update.ts';
import { createResolver } from './secrets.ts';
import { createServer } from './server.ts';
import { Tunnels } from './tunnels.ts';
import { VERSION } from './version.ts';

const USAGE = `vpnhop ${VERSION}
  vpnhop [serve]                 MCP server on stdio
  vpnhop build                   (re)build the runtime image
  vpnhop status                  show tunnels
  vpnhop connect <profile>       bring a tunnel up
  vpnhop disconnect <profile>    take it down
  vpnhop get <profile> <url>     GET a URL through the tunnel
  vpnhop refresh                 recycle running servers, stop stale/orphaned ones, remove dangling tunnels
  vpnhop update [--check] [--yes] [--json]   install the latest GitHub release
Config: $VPNHOP_CONFIG or ~/.config/vpnhop/config.json`;

const docker = createDocker();
const tunnels = new Tunnels({
  docker,
  loadConfig: () => loadConfig(),
  resolver: (config) => createResolver(config.dir),
  ensureImage: () => ensureImage(docker),
});

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));

async function main(argv: string[]): Promise<void> {
  const [command = 'serve', a, b] = argv;
  const rest = argv.slice(1);
  switch (command) {
    case 'serve': {
      const exit = () => {
        tunnels.shutdownSync();
        process.exit(0);
      };
      process.on('SIGINT', exit).on('SIGTERM', exit);
      // `vpnhop refresh` recycles current servers: drop tunnels, reconnect on the next call.
      process.on('SIGHUP', () => tunnels.shutdownSync());
      process.stdin.on('close', exit);
      const onRefresh = async () => {
        tunnels.shutdownSync();
        return refresh(docker);
      };
      await createServer(tunnels, () => loadConfig(), onRefresh).connect(new StdioServerTransport());
      return;
    }
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
      const r = await tunnels.request({
        profile: a, url: b, method: 'GET', headers: {}, timeoutSeconds: 30,
        followRedirects: true, insecure: false, maxBodyBytes: 1 << 20,
      });
      return print(r);
    }
    case 'refresh':
      return runRefresh(docker, rest);
    case 'update':
      return runUpdateCommand(rest, VERSION);
    case '-v':
    case '--version':
      return console.log(VERSION);
  }
  console.error(USAGE);
  process.exitCode = 2;
}

main(process.argv.slice(2)).catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
