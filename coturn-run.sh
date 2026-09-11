#!/usr/bin/env bash
# Run coturn in Docker on the Debian box (CasaOS-friendly).
# Host networking is REQUIRED so relay ports work. Run from the folder
# that contains turnserver.conf.
set -e

# Auto-detect public IP (works if the box can reach the internet).
PUBIP="$(curl -s https://api.ipify.org || true)"
echo "Detected public IP: ${PUBIP:-<none>}"

docker rm -f coturn 2>/dev/null || true

docker run -d --name coturn --restart unless-stopped \
  --network host \
  -v "$(pwd)/turnserver.conf:/etc/coturn/turnserver.conf:ro" \
  instrumentisto/coturn \
  -c /etc/coturn/turnserver.conf \
  ${PUBIP:+--external-ip=$PUBIP}

echo "coturn started. Logs: docker logs -f coturn"
