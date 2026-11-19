# Changelog

## 0.3.0

- Use `session_profile` to prepare a VPNHop profile for a Keyhop plan. Approved HTTP requests use the same authenticated session as the other plan steps.
- Planned requests check the exact profile and approved credential names, enforce the host allowlist, verify TLS, and return redirects for review.
- Install Keyhop 0.10.0 or later and register the updated VPNHop install to use mixed plans.

## 0.2.0

- **Saved profiles, encrypted in keyhop.**
  - `vpnhop add`, `import` (OpenVPN Connect), `list` and `remove`, plus the MCP tools `save_profile` and `remove_profile`.
  - Profile files and credentials are stored in keyhop as `VPNHOP_<PROFILE>_*`. `config.json` keeps only `{ "keyhop": … }` references.
  - Fetching uses keyhop's suite client interface: one Touch ID per new tunnel. The installer registers vpnhop with keyhop.
- **`vpnhop proxy <p> --json`:** a SOCKS5 proxy (dante) on `127.0.0.1` for other tools. hopsql uses it as its `vpnhop` provider.
- ⚠️ **Tunnels are shared and leased.** They outlive the server that started them and stop themselves after `idleMinutes` idle. `refresh` keeps healthy tunnels.

## 0.1.0

- First release: OpenVPN, WireGuard, OpenConnect and IPsec IKEv2 profiles, each in its own Docker container.
- MCP tools: `http_request` (auto-connect), `list_profiles`, `connect`, `disconnect`, `status`, `refresh`.
- `allowHosts` is enforced on the normalised URL and re-checked on every redirect hop.
- `scripts/install.sh` / `scripts/uninstall.sh`: install to `~/.local/share/vpnhop` with a `~/.local/bin/vpnhop` launcher, and register with Claude Code via `--claude [--force]`.
- `vpnhop update` installs the latest GitHub release. `vpnhop refresh` recycles running servers, stops stale or orphaned ones, and removes dangling tunnels.
