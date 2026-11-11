FROM alpine:3.24

RUN apk add --no-cache \
      openvpn wireguard-tools wireguard-go openconnect vpnc strongswan \
      curl iproute2 iptables ca-certificates \
 && mkdir -p /run/vpnhop /vpn

COPY entrypoint.sh openvpn-route-up.sh openconnect-script.sh /vpnhop/
RUN chmod 755 /vpnhop/*.sh

ENTRYPOINT ["/vpnhop/entrypoint.sh"]
