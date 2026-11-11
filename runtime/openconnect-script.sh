#!/bin/sh
# OpenConnect --script wrapper: run the stock vpnc-script, then mark ready on connect.
/etc/vpnc/vpnc-script "$@"
RC=$?
if [ "${reason:-}" = "connect" ] && [ "$RC" -eq 0 ]; then
  if [ -f /vpn/resolv.conf ]; then cat /vpn/resolv.conf > /etc/resolv.conf; fi
  touch /run/vpnhop/ready
  echo "vpnhop: VPNHOP_READY"
fi
exit "$RC"
