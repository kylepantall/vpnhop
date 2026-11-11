import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from './config.ts';
import { RequestInput } from './request.ts';
import type { Tunnels } from './tunnels.ts';
import { VERSION } from './version.ts';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function respond(work: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await work(), null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
  }
}

const profileName = z.string().min(1).describe('Profile name from list_profiles.');

export function createServer(tunnels: Tunnels, loadConfig: () => Config): McpServer {
  const server = new McpServer(
    { name: 'vpnhop', version: VERSION },
    {
      instructions:
        'vpnhop reaches APIs that sit behind a VPN without connecting this machine to it. Each profile runs ' +
        'its VPN (OpenVPN, WireGuard, OpenConnect/AnyConnect/GlobalProtect/Pulse/Fortinet/F5, IPsec IKEv2) ' +
        'inside its own Docker container. Call list_profiles, then http_request with a profile: it connects ' +
        'on demand, resolves DNS inside the tunnel, and disconnects after the profile is idle. VPN ' +
        'credentials are never shown. Some profiles only allow certain hosts (allowHosts).',
    }
  );

  server.registerTool(
    'list_profiles',
    {
      title: 'List VPN profiles',
      description: 'Configured VPN profiles with their type, description, allowed hosts and whether each tunnel is up.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      respond(async () => {
        const config = loadConfig();
        return { config: config.path, profiles: await tunnels.status() };
      })
  );

  server.registerTool(
    'connect',
    {
      title: 'Connect a VPN profile',
      description:
        'Starts the tunnel for a profile and waits until it is up (http_request also does this on demand). ' +
        'Reuses a running tunnel. On failure the error includes the redacted VPN client log.',
      inputSchema: { profile: profileName },
      annotations: { openWorldHint: true, idempotentHint: true },
    },
    ({ profile }) => respond(() => tunnels.connect(profile))
  );

  server.registerTool(
    'disconnect',
    {
      title: 'Disconnect a VPN profile',
      description: 'Stops and removes the tunnel container for a profile.',
      inputSchema: { profile: profileName },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    ({ profile }) => respond(() => tunnels.disconnect(profile))
  );

  server.registerTool(
    'status',
    {
      title: 'Tunnel status',
      description: 'State of one or all tunnels, optionally with the last lines of the (redacted) VPN client log.',
      inputSchema: {
        profile: profileName.optional(),
        logs: z.boolean().default(false).describe('Include the recent client log for tunnels this server started.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ profile, logs }) => respond(() => tunnels.status(profile, { logs }))
  );

  server.registerTool(
    'http_request',
    {
      title: 'HTTP request through a VPN',
      description:
        'Sends an HTTP(S) request from inside the profile\'s tunnel (connecting first if needed) and returns ' +
        'status, headers and body. Text bodies come back as utf8, binary as base64; bodies over maxBodyBytes ' +
        'are truncated. Redirects are not followed unless followRedirects is set.',
      inputSchema: RequestInput,
      annotations: { openWorldHint: true, destructiveHint: true },
    },
    (input) => respond(() => tunnels.request(input))
  );

  return server;
}
