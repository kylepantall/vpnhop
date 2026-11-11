#!/bin/sh
# Starts the SOCKS5 proxy (dante) on demand and extends the lease. Idempotent.
set -eu
touch /run/vpnhop/lease
[ -f /run/vpnhop/ready ] || { echo "vpnhop: tunnel not ready" >&2; exit 3; }
if ! pgrep -x sockd >/dev/null 2>&1; then
  # Route each connection by the kernel's table: tunnel interface for VPN
  # destinations, eth0 for the rest (IPsec has no interface; its policy routes eth0).
  {
    echo "logoutput: stderr"
    echo "internal: 0.0.0.0 port = 1080"
    echo "external: eth0"
    for i in tun0 wg0; do ip link show "$i" >/dev/null 2>&1 && echo "external: $i"; done
    echo "external.rotation: route"
    echo "clientmethod: none"
    echo "socksmethod: none"
    echo "user.privileged: root"
    echo "user.unprivileged: nobody"
    echo "client pass { from: 0.0.0.0/0 to: 0.0.0.0/0 }"
    echo "socks pass { from: 0.0.0.0/0 to: 0.0.0.0/0 command: connect }"
  } > /run/vpnhop/sockd.conf
  sockd -D -f /run/vpnhop/sockd.conf -p /run/vpnhop/sockd.pid
  for _ in $(seq 1 25); do nc -z 127.0.0.1 1080 2>/dev/null && break; sleep 0.2; done
fi
echo ok
