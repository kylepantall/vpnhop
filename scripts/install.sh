#!/usr/bin/env bash
set -euo pipefail

# Installs vpnhop from GitHub (it is not published to npm) and runs it on Node.js 24+.
# VPNHOP_SOURCE_DIR installs from a local checkout instead of downloading.
VPNHOP_REPO="${VPNHOP_REPO:-kylepantall/vpnhop}"

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

# Runs a noisy command quietly, showing its output only if it fails.
quiet() {
  local log="$VPNHOP_INSTALL_TEMP/step.log"
  if ! "$@" >"$log" 2>&1; then
    sed 's/^/    | /' "$log" >&2
    return 1
  fi
}

main() {
  local ref='main' register_claude=false force=false
  while (($#)); do
    case "$1" in
      --help | -h)
        printf 'Usage: bash install.sh [--claude [--force]] [REF]\n'
        printf 'Installs %s (branch, tag or commit; default main) under ~/.local/share/vpnhop\n' "$VPNHOP_REPO"
        printf 'with a launcher in ~/.local/bin. --claude also registers it with Claude Code (user scope).\n'
        printf 'An existing "vpnhop" entry is kept and the installer stops; --force replaces it.\n'
        printf 'Override with VPNHOP_INSTALL_DIR, VPNHOP_BIN_DIR, VPNHOP_REPO and VPNHOP_SOURCE_DIR.\n'
        return
        ;;
      --claude) register_claude=true ;;
      --force) force=true ;;
      -*) printf 'Unknown option: %s\n' "$1" >&2; return 1 ;;
      *) ref="$1" ;;
    esac
    shift
  done
  if [[ ! "$ref" =~ ^[A-Za-z0-9._/-]+$ || "$ref" == *..* || "$ref" == /* || "$ref" == */ ]]; then
    printf 'Invalid ref: %s\n' "$ref" >&2
    return 1
  fi
  [[ -n "${HOME:-}" ]] || { printf 'HOME must be set.\n' >&2; return 1; }
  local source_label="$VPNHOP_REPO@$ref"
  [[ -z "${VPNHOP_SOURCE_DIR:-}" ]] || source_label="$VPNHOP_SOURCE_DIR"
  printf 'vpnhop installer — %s\n' "$source_label"

  VPNHOP_INSTALL_TEMP="$(mktemp -d)"
  local temp_dir="$VPNHOP_INSTALL_TEMP"
  trap 'rm -rf -- "$VPNHOP_INSTALL_TEMP"' EXIT

  local existing=false
  if [[ "$register_claude" == true ]]; then
    step 'Checking Claude Code registration'
    command -v claude >/dev/null 2>&1 || { printf 'claude CLI not found; install without --claude, or install Claude Code first.\n' >&2; return 1; }
    if claude mcp get vpnhop >"$temp_dir/entry" 2>&1; then
      existing=true
      info 'Found an existing "vpnhop" entry.'
      grep -E '^ *(Scope|Command|Args|Environment|[A-Z][A-Z0-9_]+=)' "$temp_dir/entry" | sed 's/=.*/=…/; s/^ */      /' || true
      if [[ "$force" != true ]]; then
        printf '\nStopped without changing anything. --force replaces it with a fresh "vpnhop" entry;\n' >&2
        printf 'any environment shown above is not carried over. If that is fine, rerun with:\n' >&2
        printf '  curl -fsSL https://raw.githubusercontent.com/%s/main/scripts/install.sh | bash -s -- --claude --force\n' "$VPNHOP_REPO" >&2
        return 1
      fi
      info '--force: will replace it after a successful install.'
    else
      info 'No existing entry.'
    fi
  fi
  local install_dir="${VPNHOP_INSTALL_DIR:-$HOME/.local/share/vpnhop}"
  local bin_dir="${VPNHOP_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$install_dir" "$bin_dir"
  install_dir="$(cd "$install_dir" && pwd)"
  bin_dir="$(cd "$bin_dir" && pwd)"

  step 'Node.js runtime'
  local node_bin
  node_bin="$(command -v node || true)"
  [[ -n "$node_bin" ]] || { printf 'Node.js 24+ is required: https://nodejs.org (or brew install node)\n' >&2; return 1; }
  "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' ||
    { printf 'Node.js 24+ is required; found %s at %s\n' "$("$node_bin" -v)" "$node_bin" >&2; return 1; }
  # Pinned: the launcher must not depend on whichever node is first on PATH later.
  node_bin="$(cd "$(dirname "$node_bin")" && pwd -P)/$(basename "$node_bin")"
  info "Using $node_bin ($("$node_bin" -v))"
  local npm_bin
  npm_bin="$(dirname "$node_bin")/npm"
  [[ -x "$npm_bin" ]] || npm_bin="$(command -v npm)" || { printf 'npm is required.\n' >&2; return 1; }

  step 'Docker'
  command -v docker >/dev/null 2>&1 || { printf 'Docker is required: https://www.docker.com/products/docker-desktop\n' >&2; return 1; }
  docker info >/dev/null 2>&1 || { printf 'Docker is installed but not running; start Docker Desktop and rerun.\n' >&2; return 1; }
  info "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null)"

  # Install into a fresh directory and swap it in, so a failure leaves the working install untouched.
  local staging="$install_dir/app.new"
  rm -rf -- "$staging"
  mkdir -p "$staging"
  step 'Fetching source'
  if [[ -n "${VPNHOP_SOURCE_DIR:-}" ]]; then
    info "Copying $VPNHOP_SOURCE_DIR"
    (cd "$VPNHOP_SOURCE_DIR" && git ls-files -z --cached --others --exclude-standard |
      xargs -0 tar -cf - --) | tar -xf - -C "$staging"
  else
    command -v curl >/dev/null 2>&1 || { printf 'curl is required.\n' >&2; return 1; }
    info "Downloading github.com/$VPNHOP_REPO ($ref)"
    curl -fsSL --connect-timeout 10 --max-time 300 --retry 2 --retry-delay 1 \
      "https://codeload.github.com/$VPNHOP_REPO/tar.gz/$ref" -o "$temp_dir/source.tar.gz"
    tar -xzf "$temp_dir/source.tar.gz" -C "$staging" --strip-components 1
  fi

  step 'Installing dependencies'
  # --no-bin-links: keyhop refuses symlinks in a client's tree (node_modules/.bin).
  (cd "$staging" && PATH="$(dirname "$node_bin"):$PATH" quiet "$npm_bin" ci --omit=dev --ignore-scripts --no-audit --no-fund --no-bin-links)
  info 'Done'

  step 'Building the VPN runtime image'
  (cd "$staging" && quiet "$node_bin" src/index.ts build)
  info 'Done'

  # Marks the install time; `vpnhop refresh` stops servers started before it.
  touch "$staging/.installed"
  rm -rf -- "$install_dir/app.old"
  [[ ! -d "$install_dir/app" ]] || mv "$install_dir/app" "$install_dir/app.old"
  mv "$staging" "$install_dir/app"
  rm -rf -- "$install_dir/app.old"
  info "Installed into $install_dir/app"

  step 'Installing launcher'
  local launcher
  launcher="$(mktemp "$bin_dir/.vpnhop.XXXXXX")"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'export VPNHOP_LAUNCHER=%q\n' "$bin_dir/vpnhop"
    # Variables that inject code into node; keyhop refuses to serve a client that has them.
    printf 'unset NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE LD_PRELOAD\n'
    printf 'for v in $(env | sed -n "s/^\\(DYLD_[A-Z_]*\\)=.*/\\1/p"); do unset "$v"; done\n'
    printf 'exec %q %q "$@"\n' "$node_bin" "$install_dir/app/src/index.ts"
  } > "$launcher"
  chmod +x "$launcher"
  mv -f "$launcher" "$bin_dir/vpnhop"
  info "$bin_dir/vpnhop (version $("$bin_dir/vpnhop" --version 2>&1))"

  # Saved profiles live in keyhop. It pins this install (runtime, entry, file tree), so every
  # install or update re-registers, which asks for Touch ID once.
  step 'keyhop (encrypted profiles)'
  local keyhop_bin="${VPNHOP_KEYHOP_BIN:-$HOME/.local/bin/keyhop}"
  [[ -x "$keyhop_bin" ]] || keyhop_bin="$(command -v keyhop || true)"
  if [[ "${VPNHOP_SKIP_KEYHOP:-}" == 1 ]]; then
    info 'Skipped (VPNHOP_SKIP_KEYHOP=1)'
  elif [[ -n "$keyhop_bin" ]] && "$keyhop_bin" client list >/dev/null 2>&1; then
    info 'Registering vpnhop as a keyhop client (confirm with Touch ID)'
    if ! VPNHOP_KEYHOP_BIN="$keyhop_bin" "$bin_dir/vpnhop" keyhop-register; then
      info 'Not registered; rerun later with: vpnhop keyhop-register'
    fi
  else
    info 'keyhop 0.7+ not found: profiles still work from files and env vars, but saving them'
    info 'encrypted needs keyhop: https://github.com/kylepantall/keyhop'
  fi

  step 'Config'
  local config="${VPNHOP_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/vpnhop/config.json}"
  if [[ -f "$config" ]]; then
    info "Keeping $config"
  else
    mkdir -p "$(dirname "$config")"
    (umask 077 && cp "$install_dir/app/examples/config.json" "$config")
    info "Created $config from the example: edit it to add your VPNs"
  fi

  if [[ "$register_claude" == true ]]; then
    step 'Registering with Claude Code'
    if [[ "$existing" == true ]]; then
      if claude mcp remove vpnhop >/dev/null 2>&1; then
        info 'Removed the old "vpnhop" entry'
      else
        info 'Could not remove "vpnhop"; remove it with: claude mcp remove vpnhop --scope <scope>'
      fi
    fi
    if ! quiet claude mcp add --transport stdio --scope user vpnhop -- "$bin_dir/vpnhop"; then
      printf 'Claude registration failed. Re-add it with:\n  claude mcp add --transport stdio --scope user vpnhop -- %q\n' "$bin_dir/vpnhop" >&2
      return 1
    fi
    info 'Added "vpnhop" (user scope). Start a new Claude session to load it.'
  fi

  # Servers still running an older build are stopped; clients restart the new one on reconnect.
  step 'Refreshing running servers'
  "$bin_dir/vpnhop" refresh 2>&1 | sed 's/^/    /' || true

  printf '\n✓ vpnhop installed: %s/vpnhop\n' "$bin_dir"
  [[ "$register_claude" == true ]] ||
    printf '  Register it with: claude mcp add --transport stdio --scope user vpnhop -- %s/vpnhop\n' "$bin_dir"
  case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) printf '  For terminal use, add this to your shell profile:\n    export PATH="%s:$PATH"\n' "$bin_dir" ;;
  esac
}
main "$@"
