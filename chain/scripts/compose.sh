#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

stack=${1:?Set chain, ha, replica, control, or anvil}
shift
case "$stack" in
  chain|ha)
    options=(--env-file .env --env-file .env.generated -f chain/compose/docker-compose.chain.yml)
    if [[ "$stack" == ha ]]; then
      options+=(--env-file chain/runtime/ha/peers.env -f chain/compose/docker-compose.ha.yml)
    fi
    overlay=${LEDGERA_CHAIN_COMPOSE_OVERLAY:-}
    ;;
  replica|control)
    options=(--env-file .env --project-name "ledgera-$stack" -f chain/compose/docker-compose.replica.yml)
    if [[ "$stack" == control ]]; then options+=(--profile control); fi
    overlay=${LEDGERA_REPLICA_COMPOSE_OVERLAY:-}
    ;;
  anvil)
    options=(-f docker-compose.anvil.yml)
    overlay=${LEDGERA_ANVIL_COMPOSE_OVERLAY:-}
    ;;
  *) echo "Unknown Compose stack: $stack" >&2; exit 1 ;;
esac
if [[ -n "$overlay" ]]; then options+=(-f "$overlay"); fi
exec docker compose "${options[@]}" "$@"
