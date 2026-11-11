#!/bin/sh
# Runs one command inside the tunnel and extends the lease. Used for http_request (curl).
touch /run/vpnhop/lease
exec "$@"
