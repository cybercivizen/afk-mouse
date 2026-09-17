#!/usr/bin/env bash
# The panel is Windows-first; elsewhere run the terminal front end.
cd "$(dirname "$0")"
exec node cache-warmer.js --cli "$@"
