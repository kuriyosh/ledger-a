#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source chain/scripts/replica-rpc.sh

hash=${1:?Set a Deposit transaction hash}
if [[ ! "$hash" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
  echo "Expected a 32-byte Deposit transaction hash" >&2
  exit 1
fi
probe=$(jq -er '.contracts.depositProbe | ascii_downcase' deployments/devnet.json)

printf '%-12s %-9s %-10s %-9s %s\n' 'Node' 'Status' 'Count' 'Block' 'Block hash'
for node in op-reth op-reth-replica op-reth-control; do
  network=ledgera
  if [[ "$node" == op-reth ]]; then network=ledgera-chain; fi
  rpc="http://$node:8545"
  receipt=$(cast_in_network "$network" rpc --rpc-url "$rpc" eth_getTransactionReceipt "$hash")
  if ! fields=$(jq -er --arg probe "$probe" '
    select(.type == "0x7e" and (.to | ascii_downcase) == $probe)
    | [.from, .status, .blockNumber, .blockHash] | @tsv
  ' <<< "$receipt"); then
    echo "$node has no matching DepositProbe receipt for $hash" >&2
    exit 1
  fi
  read -r sender status block block_hash <<< "$fields"
  count=$(cast_in_network "$network" call --rpc-url "$rpc" --block "$((block))" "$probe" "count(address)(uint256)" "$sender")
  printf '%-12s %-9s %-10s %-9s %s\n' "$node" "$status" "$count" "$block" "$block_hash"
  case "$node" in
    op-reth)
      test "$status" = 0x0
      test "$count" = 0
      sequencer_hash=$block_hash
      sequencer_block=$block
      ;;
    op-reth-replica)
      test "$status" = 0x0
      test "$count" = 0
      test "$block_hash" = "$sequencer_hash"
      ;;
    op-reth-control)
      test "$status" = 0x1
      test "$count" = 1
      test "$block" = "$sequencer_block"
      test "$block_hash" != "$sequencer_hash"
      ;;
  esac
done
