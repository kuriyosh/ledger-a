#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

requested_mode=${1:?Set anvil, devnet, or devnet-ha}
export LEDGERA_APP_MODE=${requested_mode%-ha}
shift
case "$requested_mode" in
  anvil)
    account_file=chain/runtime/anvil/.env.generated
    fallback_rpc=http://anvil:8545
    export LEDGERA_ROLLUP_RPC_URL=
    export SEQUENCER_RPC_URLS="$fallback_rpc" AUDIT_RPC_URL=http://rpc-proxy:8545
    ;;
  devnet|devnet-ha)
    account_file=.env.generated
    fallback_rpc=http://op-reth:8545
    export LEDGERA_ROLLUP_RPC_URL=http://rpc-proxy:8545/rollup
    ;;
  *) echo "Expected anvil, devnet, or devnet-ha" >&2; exit 1 ;;
esac

read_env() {
  if [[ -f .env ]]; then
    node --env-file=.env -p "$1"
  else
    node -p "$1"
  fi
}

if [[ "$LEDGERA_APP_MODE" == devnet ]]; then
  export SEQUENCER_RPC_URLS
  SEQUENCER_RPC_URLS=$(read_env 'process.env.SEQUENCER_RPC_URLS || ""')
  SEQUENCER_RPC_URLS=${SEQUENCER_RPC_URLS:-$fallback_rpc}
fi
if [[ "$requested_mode" == devnet-ha ]]; then
  export SEQUENCER_READ_RPC_URL=http://rpc-proxy:8545
  export SEQUENCER_RPC_URLS=http://op-reth-1:8545,http://op-reth-2:8545,http://op-reth-3:8545
  export CONDUCTOR_RPC_URLS=http://op-conductor-1:8547,http://op-conductor-2:8547,http://op-conductor-3:8547
fi

export POSTGRES_PASSWORD
POSTGRES_PASSWORD=$(read_env 'process.env.POSTGRES_PASSWORD || ""')
if [[ -z "$POSTGRES_PASSWORD" && "$LEDGERA_APP_MODE" == anvil ]]; then
  POSTGRES_PASSWORD=local-ledgera-anvil
fi
if [[ -z "$POSTGRES_PASSWORD" ]]; then
  echo "Set POSTGRES_PASSWORD in .env" >&2
  exit 1
fi
export LEDGERA_DATABASE_URL
LEDGERA_DATABASE_URL=$(node -p '"postgresql://ledgera:" + encodeURIComponent(process.env.POSTGRES_PASSWORD) + "@postgres:5432/ledgera"')
export LEDGERA_UID LEDGERA_GID
LEDGERA_UID=$(id -u)
LEDGERA_GID=$(id -g)

profiles=()
if [[ "$(read_env 'process.env.DEMO_MODE || ""')" == true ]]; then
  profiles+=(--profile demo)
fi
files=()
audit_file="$(dirname "$account_file")/.env.auditor.generated"
if [[ -f .env ]]; then files+=(--env-file .env); fi
if [[ -f "$audit_file" ]]; then files+=(--env-file "$audit_file"); fi
exec docker compose "${profiles[@]}" "${files[@]}" --env-file "$account_file" -f docker-compose.yml "$@"
