#!/usr/bin/env bash
# Start the server. Extra args pass through, e.g. ./run.sh --model small --port 9443
set -euo pipefail
cd "$(dirname "$0")"
[[ -f certs/cert.pem ]] || ./make-cert.sh
exec ./.venv/bin/python server.py "$@"
