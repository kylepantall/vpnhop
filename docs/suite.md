# The hop suite: keyhop + vpnhop + hopsql

Save a VPN profile once, encrypted. Use it from vpnhop (HTTP from Claude) and hopsql (databases behind the VPN), with a Touch ID tap when a tunnel starts.

| Tool | Role in the suite |
|---|---|
| keyhop | The only vault. Holds VPN profile files and credentials, encrypted with a Secure Enclave key. Releases them only to registered suite clients after Touch ID. |
| vpnhop | Owns VPN profiles and tunnels: one Docker container per profile. Exposes HTTP to Claude and a SOCKS5 proxy to other tools. |
| hopsql | Uses a vpnhop profile as a connection's VPN, dialing through vpnhop's SOCKS proxy. |

## Contract A: keyhop suite clients (keyhop ≥ 0.7.0)

A suite client is an app keyhop has pinned: its runtime binary, its entry file, and a hash of its whole install tree. Only a pinned client process can read or write secrets through this interface.

### Registration

```
keyhop client add <name> --runtime <abs path> --entry <abs path> --root <abs dir> [--prefix <PREFIX_>]
keyhop client list [--json]
keyhop client remove <name>
```

- `name`: `^[a-z][a-z0-9-]{0,31}$`. `prefix` defaults to the name upper-cased with `-` mapped to `_`, plus a trailing `_` (vpnhop → `VPNHOP_`).
- `add` shows keyhop's native dialog (client name, runtime, entry, root, prefix), then needs Touch ID (`change`). An existing client is replaced only after the same approval.
- Pinned values:
  - `runtime`: real path and SHA-256.
  - `entry`: real path.
  - `root`: real path, plus a tree hash. The tree hash is SHA-256 over the sorted list of `relative path NUL sha256 NUL` for every regular file under the root, `node_modules` included. Symlinks are refused, and so is a root inside a world-writable directory.
- Pins are stored inside the encrypted vault (`VaultData.clients`), so changing them needs an unlock.
- Reinstalling or updating a client changes its tree hash. Its installer then reruns `keyhop client add`, which prompts again.

### Reading secrets

The client spawns keyhop as a direct child process (the keyhop launcher `exec`s its runtime, so keyhop's parent is the client):

```
keyhop client get        # stdin: {"client":"vpnhop","names":["VPNHOP_AWS_CONFIG"],"purpose":"Connect VPN profile \"aws\""}
                         # stdout (exit 0): {"values":{"VPNHOP_AWS_CONFIG":"..."}}
```

keyhop verifies its parent process before unlocking anything. Every check must pass.

| Check | How |
|---|---|
| Executable is the pinned runtime | `lsof -a -p <ppid> -d txt -Fn`, real path and SHA-256 match |
| argv is exactly `<runtime> <entry> [args…]` | Read from the kernel (`KERN_PROCARGS2` on macOS, `/proc` on Linux), not `ps` text. No runtime flags before the entry. The entry must be absolute, inside the root, with a matching real path. |
| No code-injecting environment | Refuses any `NODE_*` or `BUN_*` except `NODE_ENV`, `NODE_NO_WARNINGS` and `NODE_DISABLE_COLORS`. Refuses every `DYLD_*` and `LD_*`. An unreadable or empty environment is refused. |
| Working folder inside the root | Runtimes read config from the working folder, so client launchers `cd` into their app folder and pass the caller's folder on (vpnhop uses `VPNHOP_CWD`) |
| Tree unchanged | The root's tree hash matches. Symlinks are refused, so npm installs need `--no-bin-links`. A root under a world-writable directory is refused. |
| Bun runtimes | No `.bunfig.toml` in home |
| Platform | macOS and Linux. Windows exits 3 |

- **Order of checks:** before any prompt, the caller is checked against `clients.json`, a non-secret copy of the pins. After the unlock, the pin stored in the vault must match it.

- Access rules:
  - Names starting with the client's prefix: allowed after an unlock.
- "Always allow" grants are bound to the secret's origin.
  - Other names (for example a VPN password your 1Password sync already puts in keyhop) need a per-client grant. keyhop shows its dialog with the client name, the names and the `purpose` (made inert, as `approve.ts` does), then Touch ID. "Always" stores the grant in `clients[name].allow`.
- Each call is a separate process, so it prompts Touch ID (`unlock`) once. Clients cache the values in memory for their own lifetime.
- `purpose` is shown in the dialog and capped at 200 characters.

### Writing secrets

```
keyhop client put        # stdin: {"client":"vpnhop","values":{"VPNHOP_AWS_CONFIG":"..."},"remove":["VPNHOP_OLD_PASSWORD"],"purpose":"Save VPN profile \"aws\""}
                         # stdout (exit 0): {"saved":["VPNHOP_AWS_CONFIG"],"removed":["VPNHOP_OLD_PASSWORD"]}
```

- Same parent verification, then Touch ID (`change`).
- Every name must start with the client's prefix and match `^[A-Z_][A-Z0-9_]*$`.
- Values: UTF-8, at most 1 MiB each.
- Entries are stored with `source: "client:<name>"` and `origin: "client:<name>"`.
- `keyhop sync` must keep entries whose source starts with `client:` (today it replaces every secret).
- `keyhop list` and `list_secrets` show them like any other secret. `run_with_secrets` treats them like any other secret.

### Exit codes (all subcommands)

| Code | Meaning | stderr |
|---|---|---|
| 0 | OK | — |
| 1 | Other error | Message. Never a secret value. |
| 2 | User cancelled Touch ID | `cancelled` |
| 3 | Caller not a registered client, or verification failed | Which check failed |
| 4 | User denied the dialog | `denied` |
| 5 | Unknown secret name | The names |

## Contract B: vpnhop SOCKS proxy for other tools (vpnhop ≥ 0.2.0)

```
vpnhop proxy <profile> --json
# stdout (exit 0): {"profile":"aws","host":"127.0.0.1","port":49321,"expiresAt":"2026-11-11T12:30:00.000Z"}
```

- Brings the profile's tunnel up if needed, then returns its SOCKS5 proxy: no authentication, CONNECT only, published on `127.0.0.1` only. Hostnames are resolved inside the tunnel.
- Tunnels are shared and leased: every `proxy` call or `http_request` extends the lease to `idleMinutes` from now. The container stops itself when the lease runs out. A server exiting does not take shared tunnels down.
- Callers call `proxy` again before `expiresAt`, for example on each new connection, with a short cache.
- Errors: exit 1, message on stderr. Never secret values.
- Other commands for tools:
  - `vpnhop list --json`: `[{"name","type","description","state"}]`
  - `vpnhop disconnect <profile>`
- vpnhop is found via `$VPNHOP_BIN`, else `~/.local/bin/vpnhop`, else `vpnhop` on PATH.

⚠️ Any local process can use the SOCKS port while the tunnel is up. hopsql's own Docker VPN has the same caveat.

## Contract C: hopsql vpnhop provider (hopsql ≥ 1.5.0)

```json
"vpn": { "provider": "vpnhop", "profile": "aws", "connectTimeoutMs": 90000 }
```

- `hopsql vpn use <profile> <connection…> --vpnhop` sets it.
- `hopsql vpn list` also shows vpnhop profiles, through `vpnhop list --json`.
- Dialing works the same as `provider: "docker"`: direct connections and the first SSH hop go through the SOCKS proxy that `vpnhop proxy` returns. Not available with SSM.
- hopsql never stops vpnhop tunnels; the lease expires on its own.
