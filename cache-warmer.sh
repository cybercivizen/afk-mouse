#!/usr/bin/env bash
# The widget is Windows-only; elsewhere run the terminal front end.
cd "$(dirname "$0")"
exec node cache-warmer.js --cli "$@"
