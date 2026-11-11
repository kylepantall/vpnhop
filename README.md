# vpnhop

MCP server that sends API calls through a VPN **without connecting your machine to the VPN**.
Each profile's VPN client runs in its own throwaway Docker container; requests run from inside it.

| VPN | Client in container | Auth |
|---|---|---|
| OpenVPN (incl. AWS Client VPN, OpenVPN Connect `.ovpn`) | `openvpn` 2.7 | certs, username/password |
| WireGuard | `wg-quick` (kernel, falls back to `wireguard-go`) | private key |
| Cisco AnyConnect / ocserv, GlobalProtect, Pulse/Ivanti, Juniper NC, Fortinet, F5, Array | `openconnect` | username/password, TOTP, cert pin |
| IPsec IKEv2 | strongSwan (`swanctl`) | EAP-MSCHAPv2, PSK |

Part of a suite with [keyhop](https://github.com/kylepantall/keyhop) (the encrypted vault) and [hopsql](https://github.com/kylepantall/hopsql) (databases). See [docs/suite.md](docs/suite.md).

## Save a profile once

```bash
vpnhop import                                  # lists OpenVPN Connect profiles, with the command to save each
vpnhop add aws ~/Downloads/aws.ovpn            # any .ovpn or WireGuard .conf
vpnhop add corp --type openconnect --server vpn.example.com --protocol gp --user me --totp
vpnhop list
```

- The profile file and its credentials are encrypted in keyhop (Touch ID). Referenced cert/key files and an `auth-user-pass` file are inlined first.
- `config.json` only gets names, settings and `{ "keyhop": "VPNHOP_AWS_CONFIG" }` references.
- Missing credentials are asked for in the terminal, with the input hidden. You can then delete the original file.
- Claude can save a profile from a file path with `save_profile`; you confirm with Touch ID. Claude never sees the contents.

## How it works

- No sudo, no host routes, no system VPN. Host traffic is never affected.
- When a tunnel starts, vpnhop fetches all of the profile's secrets from keyhop in one request, which takes one Touch ID tap. keyhop only answers the vpnhop install it pinned.
- Secrets can also come from `env`, `file` or `command` (e.g. `op read`).
- Either way, secrets reach the container as a tar on stdin: no host temp file, env var or bind mount.
- DNS is resolved inside the tunnel (pushed DNS, WireGuard `DNS=`, or `dns`/`searchDomains` overrides).
- Tunnels are shared and leased:
  - Every request or `vpnhop proxy` call extends the lease.
  - The container stops itself after `idleMinutes` without use.
  - Reusing a running tunnel needs no secrets, so no Touch ID.
- Other tools reach the VPN through `vpnhop proxy <p>`, a SOCKS5 proxy on `127.0.0.1`. hopsql uses it with `"vpn": {"provider": "vpnhop", "profile": "aws"}`.
- Client logs come back redacted, and only for tunnels this server started.

## Tools

| Tool | Does |
|---|---|
| `list_profiles` | Profiles, type, allowed hosts, tunnel state |
| `http_request` | HTTP(S) via a profile; auto-connects |
| `connect` / `disconnect` | Manual tunnel control |
| `save_profile` / `remove_profile` | Save a profile file into keyhop, or delete one (Touch ID) |
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
| `vpnhop add` / `import` / `remove` / `list [--json]` | Manage saved profiles (see above) |
| `vpnhop proxy <p> [--json]` | SOCKS5 proxy into the tunnel for other tools; extends the lease |
| `vpnhop keyhop-register` | Register this install with keyhop again (the installer does this) |
| `vpnhop status` | Every profile and its tunnel state |
| `vpnhop connect <p>` / `disconnect <p>` | Bring a tunnel up or down |
| `vpnhop get <p> <url>` | GET a URL through a tunnel |
| `vpnhop build` | Rebuild the runtime image |

What `vpnhop refresh` does:
- Running servers drop the secrets they cached.
- Servers older than the installed build, or orphaned by a closed client, are stopped. Claude restarts them on reconnect.
- Tunnels that are stopped, belong to a deleted profile, or were built from an older profile or image are removed. Healthy tunnels stay up.
- Old runtime images are removed.

**Releasing:** bump `version` in `package.json` and `src/version.ts`, then publish a `v<version>` GitHub release. `vpnhop update` picks it up.

## Config

`~/.config/vpnhop/config.json` (or `$VPNHOP_CONFIG`). See [examples/config.json](examples/config.json). Relative paths resolve against the config file's folder.

| Field | Applies to | Notes |
|---|---|---|
| `allowHosts` | all | `*`, exact host, `*.suffix`, IPv4 CIDR. Omit to allow any |
| `dns`, `searchDomains` | all | Override pushed DNS |
| `idleMinutes`, `connectTimeoutSeconds` | all | Also settable under `defaults` |
| secrets | all | `{ "keyhop": "NAME" }` (what `vpnhop add` writes), `{ "env": "X" }`, `{ "file": "path" }`, `{ "command": ["op","read","op://…"] }`. Literal values are rejected |
| `config` | openvpn, wireguard | A file path, or `{ "keyhop": "NAME" }` holding the whole file |

⚠️ For OpenVPN, external `ca`/`cert`/`key`/`tls-*` files are copied in, and host hook scripts (`up`, `down`, …) are dropped.

## Limits

- SAML / browser SSO VPNs (AWS Client VPN federated auth, Okta-fronted GlobalProtect) need a human in a browser, so they can't run headless.
- L2TP, PPTP and SSTP are not supported.
- Claude gets HTTP(S) only. Raw TCP goes through `vpnhop proxy`.
- ⚠️ Any local process can use a tunnel's SOCKS port while it is up.
- ⚠️ Anything that can run `docker exec` can read a running tunnel's staged secrets. That includes Claude's shell.

## Develop

```bash
npm install
npm test            # unit
npm run test:e2e    # real WireGuard, OpenVPN and IPsec servers in Docker, a fake keyhop, SOCKS and leases
npm run typecheck
```
