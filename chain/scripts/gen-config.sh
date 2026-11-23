#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."

deployer=$1
chain_id=$2
workdir=chain/.deployer
runtime=chain/runtime
manifest=deployments/devnet.json
mkdir -p "$runtime" deployments
temp_dir=$(mktemp -d "$runtime/config.XXXXXX")
manifest_tmp=$(mktemp deployments/.devnet.XXXXXX.json)
trap 'rm -rf "$temp_dir"; rm -f "$manifest_tmp"' EXIT

"$deployer" inspect genesis --workdir "$workdir" "$chain_id" > "$temp_dir/genesis.json"
"$deployer" inspect rollup --workdir "$workdir" "$chain_id" > "$temp_dir/rollup.json"
jq -e --argjson id "$chain_id" '.config.chainId == $id and (.alloc | type == "object")' "$temp_dir/genesis.json" >/dev/null
jq -e --argjson id "$chain_id" '.l1_chain_id == 11155111 and .l2_chain_id == $id and .block_time == 2' "$temp_dir/rollup.json" >/dev/null

jq -e --argjson id "$chain_id" '
  def address: type == "string" and test("^0x[0-9a-fA-F]{40}$") and . != ("0x" + ("0" * 40));
  .opChainDeployments[0] |
  select((.OptimismPortalProxy | address) and (.SystemConfigProxy | address)) |
  {
    environment: "devnet",
    chainId: $id,
    l1: {chainId: 11155111, optimismPortal: .OptimismPortalProxy, systemConfig: .SystemConfigProxy}
  }
' "$workdir/state.json" > "$manifest_tmp"

if [[ -f "$manifest" ]]; then
  jq -e --slurpfile next "$manifest_tmp" '
    select(.chainId == $next[0].chainId and .l1 == $next[0].l1)
  ' "$manifest" > "$temp_dir/devnet.json" || {
    echo "Existing $manifest belongs to a different deployment" >&2
    exit 1
  }
  cat "$temp_dir/devnet.json" > "$manifest_tmp"
fi
if [[ ! -s "$runtime/jwt.txt" ]]; then
  openssl rand -hex 32 > "$temp_dir/jwt.txt"
  mv "$temp_dir/jwt.txt" "$runtime/jwt.txt"
fi
mv "$temp_dir/genesis.json" "$temp_dir/rollup.json" "$runtime/"
mv "$manifest_tmp" "$manifest"
