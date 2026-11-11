// MCP smoke test: starts the stdio server, lists tools, calls list_profiles and a blocked http_request.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: ['src/index.ts', 'serve'], env: { ...process.env } as Record<string, string> }));
const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));
const list = await client.callTool({ name: 'list_profiles', arguments: {} });
console.log('list_profiles:', JSON.stringify(list.content).slice(0, 300));
const blocked = await client.callTool({ name: 'http_request', arguments: { profile: 'demo', url: 'https://example.com/' } });
console.log('blocked isError:', blocked.isError, JSON.stringify(blocked.content).slice(0, 200));
await client.close();
