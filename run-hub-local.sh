#!/bin/bash
cd "$(dirname "$0")" && RELAY_PORT="${PORT:-4477}" RELAY_HOST=127.0.0.1 exec node hub.mjs
