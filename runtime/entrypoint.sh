#!/bin/sh
# vpnhop runtime: brings one tunnel up inside this container, then touches
# /run/vpnhop/ready. The container exits when the VPN client exits.
# Staged by the host (docker cp, never bind-mounted): /vpn/*
set -eu

TYPE="${1:?usage: entrypoint.sh openvpn|wireguard|openconnect|ipsec}"
READY=/run/vpnhop/ready
mkdir -p /run/vpnhop
rm -f "$READY"

log() { echo "vpnhop: $*"; }

# Written in place: Docker bind-mounts /etc/resolv.conf, so it can't be replaced.
write_resolv() {
  if [ -f /vpn/resolv.conf ]; then cat /vpn/resolv.conf > /etc/resolv.conf; fi
}

mark_ready() {
  write_resolv
  touch "$READY"
  log "VPNHOP_READY"
}

PID=""
stop() {
  log "stopping"
  case "$TYPE" in
    wireguard) wg-quick down wg0 >/dev/null 2>&1 || true ;;
    ipsec) swanctl --terminate --ike vpnhop >/dev/null 2>&1 || true ;;
  esac
  [ -n "$PID" ] && kill "$PID" 2>/dev/null || true
  exit 0
}
trap stop TERM INT

case "$TYPE" in
  openvpn)
    set -- --config /vpn/config.ovpn --cd /vpn/files --auth-nocache \
      --script-security 2 --route-up /vpnhop/openvpn-route-up.sh
    if [ -f /vpn/auth.txt ]; then set -- "$@" --auth-user-pass /vpn/auth.txt; fi
    mkdir -p /vpn/files
    openvpn "$@" &
    PID=$!
    ;;

  wireguard)
    mkdir -p /etc/wireguard
    # DNS is handled here, not by wg-quick's resolvconf (which can't replace a bind mount).
    DNS=$(sed -n 's/^[[:space:]]*[Dd][Nn][Ss][[:space:]]*=[[:space:]]*//p' /vpn/wg0.conf | tr ',' ' ')
    sed '/^[[:space:]]*[Dd][Nn][Ss][[:space:]]*=/d' /vpn/wg0.conf > /etc/wireguard/wg0.conf
    chmod 600 /etc/wireguard/wg0.conf
    if ip link add vpnhopprobe type wireguard 2>/dev/null; then
      ip link del vpnhopprobe
    else
      log "no kernel WireGuard, using wireguard-go"
      export WG_QUICK_USERSPACE_IMPLEMENTATION=wireguard-go
    fi
    wg-quick up wg0
    if [ -n "$DNS" ] && [ ! -f /vpn/resolv.conf ]; then
      {
        for d in $DNS; do
          case "$d" in
            *[!0-9a-fA-F.:]*) echo "search $d" ;;
            *) echo "nameserver $d" ;;
          esac
        done
      } > /etc/resolv.conf
    fi
    mark_ready
    tail -f /dev/null &
    PID=$!
    ;;

  openconnect)
    set -- --non-inter --script /vpnhop/openconnect-script.sh
    if [ -f /vpn/args ]; then
      while IFS= read -r arg || [ -n "$arg" ]; do
        [ -n "$arg" ] && set -- "$@" "$arg"
      done < /vpn/args
    fi
    SERVER=$(cat /vpn/server)
    if [ -f /vpn/password ]; then
      openconnect "$@" --passwd-on-stdin "$SERVER" < /vpn/password &
    else
      openconnect "$@" "$SERVER" < /dev/null &
    fi
    PID=$!
    ;;

  ipsec)
    cp /vpn/swanctl.conf /etc/swanctl/swanctl.conf
    if [ -f /vpn/ca.pem ]; then
      cp /vpn/ca.pem /etc/swanctl/x509ca/vpnhop-ca.pem
    else
      # swanctl reads one certificate per file: split the system bundle.
      awk -v dir=/etc/swanctl/x509ca '/BEGIN CERTIFICATE/{n++} {print > (dir "/sys-" n ".pem")}' \
        /etc/ssl/certs/ca-certificates.crt
    fi
    /usr/lib/strongswan/charon &
    PID=$!
    for _ in $(seq 1 50); do [ -S /var/run/charon.vici ] && break; sleep 0.2; done
    swanctl --load-all
    swanctl --initiate --child vpnhop --timeout 30
    mark_ready
    ;;

  *)
    log "unknown type: $TYPE"
    exit 2
    ;;
esac

# Exit (and so stop the container) when the client dies.
set +e
wait "$PID"
RC=$?
log "client exited ($RC)"
exit "$RC"
