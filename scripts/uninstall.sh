#!/usr/bin/env bash
set -euo pipefail

# Removes what install.sh added: the Claude Code entry, running servers, tunnel containers,
# runtime images, the launcher and the install directory. Your config is kept unless --purge.

step() { printf '\n==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

main() {
  local purge=false
  while (($#)); do
    case "$1" in
      --help | -h)
        printf 'Usage: bash uninstall.sh [--purge]\n'
        printf 'Removes vpnhop from ~/.local/share/vpnhop and ~/.local/bin (VPNHOP_INSTALL_DIR, VPNHOP_BIN_DIR).\n'
        printf -- '--purge also deletes ~/.config/vpnhop (your profiles).\n'
        return
        ;;
      --purge) purge=true ;;
      *) printf 'Unknown option: %s\n' "$1" >&2; return 1 ;;
    esac
    shift
  done
  [[ -n "${HOME:-}" ]] || { printf 'HOME must be set.\n' >&2; return 1; }
  local install_dir="${VPNHOP_INSTALL_DIR:-$HOME/.local/share/vpnhop}"
  local bin_dir="${VPNHOP_BIN_DIR:-$HOME/.local/bin}"
  local config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/vpnhop"
  printf 'vpnhop uninstaller\n'

  step 'Claude Code registration'
  if command -v claude >/dev/null 2>&1 && claude mcp get vpnhop >/dev/null 2>&1; then
    if claude mcp remove vpnhop >/dev/null 2>&1; then info 'Removed "vpnhop"'; else info 'Could not remove it: claude mcp remove vpnhop --scope <scope>'; fi
  else
    info 'Not registered'
  fi

  step 'Running servers'
  # SIGTERM runs each server's shutdown, which removes the tunnels it owns.
  local entry="$install_dir/app/src/index.ts" pids
  pids="$(ps -axo pid=,command= | awk -v e="$entry" 'index($0, e) && $0 ~ /index\.ts( serve)?[[:space:]]*$/ {print $1}')"
  if [[ -n "$pids" ]]; then
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    info "Stopped: $(echo $pids)"
    sleep 1.5
  else
    info 'None'
  fi

  step 'Docker tunnels and images'
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    local ids images
    ids="$(docker ps -aq --filter label=vpnhop.profile)"
    # shellcheck disable=SC2086
    [[ -z "$ids" ]] || docker rm -f $ids >/dev/null
    info "Removed $(printf '%s' "$ids" | grep -c . || true) tunnel container(s)"
    images="$(docker images -q --filter label=vpnhop.runtime=1 | sort -u)"
    # shellcheck disable=SC2086
    [[ -z "$images" ]] || docker rmi -f $images >/dev/null
    info "Removed $(printf '%s' "$images" | grep -c . || true) runtime image(s)"
  else
    info 'Docker not running: skipped (rerun later to clean up containers and images)'
  fi

  step 'Files'
  if [[ -f "$bin_dir/vpnhop" ]] && grep -q 'VPNHOP_LAUNCHER' "$bin_dir/vpnhop"; then
    rm -f -- "$bin_dir/vpnhop"
    info "Removed $bin_dir/vpnhop"
  fi
  if [[ -d "$install_dir" ]]; then
    rm -rf -- "$install_dir"
    info "Removed $install_dir"
  fi
  if [[ "$purge" == true ]]; then
    rm -rf -- "$config_dir"
    info "Removed $config_dir"
  else
    info "Kept $config_dir (--purge deletes it)"
  fi

  printf '\n✓ vpnhop uninstalled\n'
}
main "$@"
