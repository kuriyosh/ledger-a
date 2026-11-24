#!/usr/bin/env bash
set -euo pipefail

service=$1
shift
expected=${OPTIMISM_FORK_COMMIT:?Run via mise}
image=$("$@" config --format json | jq -er --arg service "$service" '.services[$service].image')
actual=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image" 2>/dev/null || true)
if [[ "$actual" != "$expected" ]]; then
  echo "The local image $image must contain Optimism commit $expected. Use mise run chain-image." >&2
  exit 1
fi
