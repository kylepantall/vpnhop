# Changelog

## Unreleased

- `install.sh` / `uninstall.sh` (hopsql-style: `~/.local/share/vpnhop` + `~/.local/bin/vpnhop` launcher, `--claude [--force]`).
- `vpnhop update` installs the latest GitHub release; `vpnhop refresh` and the `refresh` tool recycle servers and remove dangling tunnels.

## 0.1.0

- First release: OpenVPN, WireGuard, OpenConnect, IPsec IKEv2 profiles; `http_request`, `connect`, `disconnect`, `status`, `list_profiles`.
