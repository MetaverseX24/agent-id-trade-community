#!/bin/sh
set -eu
cd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo 'Please install Node.js 22 or newer LTS from https://nodejs.org/ then try again.'
  exit 1
fi
exec node scripts/setup.mjs "$@"
