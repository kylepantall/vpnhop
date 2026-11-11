# Changelog

## 0.1.0

- First release: OpenVPN, WireGuard, OpenConnect and IPsec IKEv2 profiles, each in its own Docker container.
- MCP tools: `http_request` (auto-connect), `list_profiles`, `connect`, `disconnect`, `status`, `refresh`.
- `allowHosts` is enforced on the normalised URL and re-checked on every redirect hop.
- `scripts/install.sh` / `scripts/uninstall.sh`: install to `~/.local/share/vpnhop` with a `~/.local/bin/vpnhop` launcher, and register with Claude Code via `--claude [--force]`.
- `vpnhop update` installs the latest GitHub release. `vpnhop refresh` recycles running servers, stops stale or orphaned ones, and removes dangling tunnels.
