# vpnhop

MCP server that sends API calls through a VPN **without connecting your machine to the VPN**.
Each profile's VPN client runs in its own throwaway Docker container; requests run from inside it.

| VPN | Client in container | Auth |
|---|---|---|
| OpenVPN (incl. AWS Client VPN, OpenVPN Connect `.ovpn`) | `openvpn` 2.7 | certs, username/password |
| WireGuard | `wg-quick` (kernel, falls back to `wireguard-go`) | private key |
| Cisco AnyConnect / ocserv, GlobalProtect, Pulse/Ivanti, Juniper NC, Fortinet, F5, Array | `openconnect` | username/password, TOTP, cert pin |
| IPsec IKEv2 | strongSwan (`swanctl`) | EAP-MSCHAPv2, PSK |

## How it works

- No sudo, no host routes, no system VPN. Host traffic is never affected.
- Secrets are resolved per connect from `env`, `file` or `command` (e.g. `op read`). They are piped into the container as a tar over stdin, so there's no host temp file, env var or bind mount.
- DNS is resolved inside the tunnel (pushed DNS, WireGuard `DNS=`, or `dns`/`searchDomains` overrides).
- Tunnels connect on first `http_request` and close after `idleMinutes`, or when the server exits.
- Client logs come back redacted, and only for tunnels this server started.

## Tools

| Tool | Does |
|---|---|
| `list_profiles` | Profiles, type, allowed hosts, tunnel state |
| `http_request` | HTTP(S) via a profile; auto-connects |
| `connect` / `disconnect` | Manual tunnel control |
| `status` | State, plus the redacted client log |

## Setup

Needs Docker Desktop and Node ≥ 24.

```bash
cd ~/Code/vpnhop && npm install
mkdir -p ~/.config/vpnhop && cp examples/config.json ~/.config/vpnhop/config.json   # then edit
claude mcp add vpnhop -s user -- node ~/Code/vpnhop/src/index.ts serve
```

The first connect builds the `vpnhop-runtime` image (about 30s).

CLI for debugging: `node src/index.ts status | connect <p> | disconnect <p> | get <p> <url> | build`.

## Config

`~/.config/vpnhop/config.json` (or `$VPNHOP_CONFIG`). See [examples/config.json](examples/config.json). Relative paths resolve against the config file's folder.

| Field | Applies to | Notes |
|---|---|---|
| `allowHosts` | all | `*`, exact host, `*.suffix`, IPv4 CIDR. Omit to allow any |
| `dns`, `searchDomains` | all | Override pushed DNS |
| `idleMinutes`, `connectTimeoutSeconds` | all | Also settable under `defaults` |
| secrets | all | `{ "env": "X" }`, `{ "file": "path" }`, `{ "command": ["op","read","op://…"] }`. Literal values are rejected |

⚠️ For OpenVPN, external `ca`/`cert`/`key`/`tls-*` files are copied in, and host hook scripts (`up`, `down`, …) are dropped.

## Limits

- SAML / browser SSO VPNs (AWS Client VPN federated auth, Okta-fronted GlobalProtect) need a human in a browser, so they can't run headless.
- L2TP, PPTP and SSTP are not supported.
- HTTP(S) only. There is no raw TCP or SOCKS proxy yet.

## Tests

```bash
npm test            # unit
npm run test:e2e    # real WireGuard, OpenVPN and IPsec servers in Docker
npm run typecheck
```
