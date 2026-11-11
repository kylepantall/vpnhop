import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from './config.ts';
import { PROFILE_NAME } from './config.ts';
import type { Keyhop } from './keyhop.ts';
import { removeProfile, saveProfile } from './profiles.ts';
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

export function createServer(tunnels: Tunnels, loadConfig: () => Config, onRefresh?: () => Promise<unknown>, keyhop?: Keyhop): McpServer {
  const server = new McpServer(
    { name: 'vpnhop', version: VERSION },
    {
      instructions:
        'vpnhop reaches APIs that sit behind a VPN without connecting this machine to it. Each profile runs ' +
        'its VPN (OpenVPN, WireGuard, OpenConnect/AnyConnect/GlobalProtect/Pulse/Fortinet/F5, IPsec IKEv2) ' +
        'inside its own Docker container. Call list_profiles, then http_request with a profile: it connects ' +
        'on demand, resolves DNS inside the tunnel, and stops after the profile is idle. Profiles are ' +
        'saved encrypted in keyhop (save_profile takes a file path; the user confirms with Touch ID). VPN ' +
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

  if (keyhop) {
    server.registerTool(
      'save_profile',
      {
        title: 'Save a VPN profile',
        description:
          'Saves a VPN profile from a file on this machine (.ovpn or WireGuard .conf) into the encrypted keyhop ' +
          'vault; the user confirms with Touch ID. Referenced cert/key files and an auth-user-pass file are ' +
          'inlined. You never see the contents. Profiles that need a password not in the file, or ' +
          'OpenConnect/IPsec profiles, must be added by the user in a terminal: vpnhop add.',
        inputSchema: {
          name: z.string().regex(PROFILE_NAME).describe('Profile name: lowercase letters, digits, - and _.'),
          file: z.string().min(1).describe('Absolute path to the .ovpn or WireGuard .conf file.'),
          type: z.enum(['openvpn', 'wireguard']).optional(),
          description: z.string().max(200).optional(),
          allowHosts: z.array(z.string()).optional().describe('Hosts http_request may reach through this profile.'),
        },
        annotations: { destructiveHint: false, openWorldHint: false },
      },
      (input) => respond(() => saveProfile(keyhop, input))
    );
    server.registerTool(
      'remove_profile',
      {
        title: 'Remove a VPN profile',
        description: 'Deletes a saved profile and its keyhop secrets (the user confirms with Touch ID), and stops its tunnel.',
        inputSchema: { profile: profileName },
        annotations: { destructiveHint: true, idempotentHint: true },
      },
      ({ profile }) =>
        respond(async () => {
          await tunnels.disconnect(profile).catch(() => {});
          return removeProfile(keyhop, loadConfig(), profile);
        })
    );
  }

  if (onRefresh)
    server.registerTool(
      'refresh',
      {
        title: 'Refresh vpnhop',
        description:
          'Recycles running vpnhop servers (cached secrets dropped), stops outdated or orphaned ones, and ' +
          'removes stopped, orphaned or outdated tunnel containers and old runtime images. Healthy tunnels ' +
          'stay up. Use after updating vpnhop or editing profiles; disconnect a stuck tunnel instead.',
        inputSchema: {},
        annotations: { destructiveHint: false, idempotentHint: true },
      },
      () => respond(onRefresh)
    );

  return server;
}
