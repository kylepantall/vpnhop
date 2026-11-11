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
| `refresh` | Same as `vpnhop refresh` |

## Install

Needs Docker Desktop (running) and Node.js 24+. One command installs and registers it with Claude Code:

```bash
curl -fsSL https://raw.githubusercontent.com/kylepantall/vpnhop/main/scripts/install.sh | bash -s -- --claude
```

What the installer does:
- Installs into `~/.local/share/vpnhop`, with a `vpnhop` launcher in `~/.local/bin`. The launcher uses the Node it found at install time.
- Builds the VPN runtime image.
- Creates `~/.config/vpnhop/config.json` from the example if you don't have one. Edit it to add your VPNs.
- Starts the new version: servers on the old build are stopped, and Claude starts the new one when it reconnects.

Options:
- Pin a branch, tag or commit: `bash -s -- --claude <ref>`.
- An existing `vpnhop` entry stops the installer. `--force` replaces it.
- From a local checkout: `VPNHOP_SOURCE_DIR=~/Code/vpnhop bash scripts/install.sh --claude`.
- `VPNHOP_INSTALL_DIR` and `VPNHOP_BIN_DIR` choose other directories.

Start a new Claude session after installing.

## Uninstall

```bash
curl -fsSL https://raw.githubusercontent.com/kylepantall/vpnhop/main/scripts/uninstall.sh | bash
```

This removes:
- the Claude entry;
- running servers;
- tunnel containers and runtime images;
- the launcher and the install directory.

Your config is kept. Add `-s -- --purge` to delete `~/.config/vpnhop` as well.

## Command line

| Command | Does |
|---|---|
| `vpnhop` / `vpnhop serve` | MCP server on stdio |
| `vpnhop update` | Checks GitHub for a newer release and reruns the installer for it. `--check` only reports, `--yes` skips the prompt, `--json` for scripts |
| `vpnhop refresh` | Closes and restarts dangling instances (details below). macOS and Linux |
| `vpnhop status` | Every profile and its tunnel state |
| `vpnhop connect <p>` / `disconnect <p>` | Bring a tunnel up or down |
| `vpnhop get <p> <url>` | GET a URL through a tunnel |
| `vpnhop build` | Rebuild the runtime image |

What `vpnhop refresh` does:
- Running servers close their tunnels, which reconnect on the next call.
- Servers older than the installed build, or orphaned by a closed client, are stopped. Claude restarts them on reconnect.
- Leftover tunnel containers and old runtime images are removed.

**Releasing:** bump `version` in `package.json` and `src/version.ts`, then publish a `v<version>` GitHub release. `vpnhop update` picks it up.

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

## Develop

```bash
npm install
npm test            # unit
npm run test:e2e    # real WireGuard, OpenVPN and IPsec servers in Docker
npm run typecheck
```
