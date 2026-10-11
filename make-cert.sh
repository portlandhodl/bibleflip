#!/usr/bin/env bash
# Creates a self-signed TLS certificate so browsers (especially Safari on iPad)
# allow microphone access when the page is opened from another device.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p certs

san="DNS:localhost,DNS:$(hostname),DNS:$(hostname -s),IP:127.0.0.1"
for ip in $(hostname -I 2>/dev/null); do
  [[ "$ip" == *:* ]] && continue  # skip IPv6
  san="$san,IP:$ip"
done

# 825 days is the longest validity iOS accepts for a trusted certificate.
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
  -keyout certs/key.pem -out certs/cert.pem \
  -subj "/CN=moonshine-stt ($(hostname -s))" \
  -addext "subjectAltName=$san" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "extendedKeyUsage=serverAuth"

chmod 600 certs/key.pem
echo "Wrote certs/cert.pem and certs/key.pem"
echo "SubjectAltName: $san"
