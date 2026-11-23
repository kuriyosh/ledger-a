#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
source chain/versions.env

mode=${BOOTSTRAP_MODE:?Set BOOTSTRAP_MODE}
case "$mode" in
  anvil|devnet) ;;
  *) echo "Expected BOOTSTRAP_MODE=anvil or devnet" >&2; exit 1 ;;
esac
runtime="chain/runtime/$mode"
mkdir -p "$runtime"

lock="$runtime/bootstrap.lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo "L2 bootstrap is locked at $lock. If no bootstrap is running, remove it with rmdir." >&2
  exit 1
fi
temp_dir=
cleanup() {
  if [[ -n "$temp_dir" ]]; then rm -rf "$temp_dir"; fi
  rmdir "$lock"
}
trap cleanup EXIT
temp_dir=$(mktemp -d "$runtime/bootstrap.XXXXXX")

if [[ "$mode" == anvil ]]; then
  repo=$PWD
  if [[ ! -f "$runtime/.env.generated" || ! -f "$runtime/.env.auditor.generated" ]]; then
    (
      cd "$runtime"
      LEDGERA_MNEMONIC='abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' \
        node "$repo/chain/scripts/derive-accounts.ts" >/dev/null
    )
  fi
  accounts="$runtime/.env.generated"
  chain_id=31337
  network=ledgera-chain
  direct_rpc=http://anvil:8545
  read_rpc=http://127.0.0.1:8545
else
  accounts=.env.generated
  chain_id=$(node --env-file-if-exists=.env -p 'process.env.L2_CHAIN_ID || ""')
  network=${BOOTSTRAP_NETWORK:-ledgera-chain}
  direct_rpc=${BOOTSTRAP_SEQUENCER_RPC:-http://op-reth:8545}
  read_rpc=${BOOTSTRAP_READ_RPC:-http://127.0.0.1:8545}
fi

existing_registry=$(node chain/scripts/bootstrap-manifest.ts preflight "$mode" "$read_rpc" "$chain_id")

awk -F= '/^(ADMIN_PRIVATE_KEY|VASP_B_ADMIN_PRIVATE_KEY|VASP_B_TREASURY_PRIVATE_KEY|RELAYER_B_PRIVATE_KEY|ISSUER_PRIVATE_KEY|GATEWAY_ADDRESS|RELAYER_A_ADDRESS|VASP_A_ADMIN_ADDRESS|VASP_A_SIGNER_ADDRESS|VASP_B_SIGNER_ADDRESS|CONSORTIUM_[123]_ADDRESS)=/' \
  "$accounts" > "$temp_dir/accounts.env"

docker run --rm --network "$network" --user "$(id -u):$(id -g)" --env-file "$temp_dir/accounts.env" \
  --env "HOME=/workspace/$runtime" --env "BOOTSTRAP_MODE=$mode" --env "L2_CHAIN_ID=$chain_id" \
  --env "BOOTSTRAP_EXISTING_REGISTRY=$existing_registry" \
  --env "BOOTSTRAP_OUTPUT=/workspace/$temp_dir/addresses.json" \
  --mount "type=bind,source=$PWD,target=/workspace" --workdir /workspace \
  --entrypoint forge "$FOUNDRY_IMAGE" script --root contracts \
  contracts/script/Bootstrap.s.sol:Bootstrap --rpc-url "$direct_rpc" --broadcast --slow

node chain/scripts/bootstrap-manifest.ts write "$mode" "$read_rpc" "$chain_id" "$temp_dir/addresses.json"
