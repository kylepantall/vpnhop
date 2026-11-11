#!/bin/sh
# OpenVPN --route-up hook: apply pushed DNS (both the legacy dhcp-option and the
# 2.6+ `dns` forms) unless the profile set its own, then mark the tunnel ready.

if [ ! -f /vpn/resolv.conf ]; then
  NS=""
  SEARCH=""
  i=1
  while :; do
    eval "opt=\${foreign_option_$i:-}"
    [ -z "$opt" ] && break
    case "$opt" in
      "dhcp-option DNS "*) NS="$NS ${opt#dhcp-option DNS }" ;;
      "dhcp-option DOMAIN "*) SEARCH="$SEARCH ${opt#dhcp-option DOMAIN }" ;;
    esac
    i=$((i + 1))
  done
  for v in $(env | sed -n 's/^dns_server_[0-9]*_address_[0-9]*=//p'); do NS="$NS ${v%% *}"; done
  for v in $(env | sed -n 's/^dns_search_domain_[0-9]*=//p'); do SEARCH="$SEARCH $v"; done

  if [ -n "$NS" ]; then
    {
      [ -n "$SEARCH" ] && echo "search$SEARCH"
      for n in $NS; do echo "nameserver $n"; done
    } > /etc/resolv.conf
  fi
else
  cat /vpn/resolv.conf > /etc/resolv.conf
fi

touch /run/vpnhop/ready
echo "vpnhop: VPNHOP_READY"
exit 0
