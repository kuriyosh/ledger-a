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

printf '%-17s %-9s %-10s %-9s %s\n' 'Node' 'Status' 'Count' 'Block' 'Block hash'
for node in op-reth op-reth-replica op-reth-control; do
  case "$node" in
    op-reth) network=ledgera-chain ;;
    op-reth-replica) network=ledgera-replica_engine ;;
    op-reth-control) network=ledgera-control_engine ;;
  esac
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
  parent=$(cast_in_network "$network" rpc --rpc-url "$rpc" eth_getBlockByNumber "$block" false |
    jq -er --arg hash "$block_hash" 'select(.hash == $hash).parentHash')
  printf '%-17s %-9s %-10s %-9s %s\n' "$node" "$status" "$count" "$block" "$block_hash"
  case "$node" in
    op-reth)
      sequencer_hash=$block_hash
      sequencer_block=$block
      sequencer_parent=$parent
      ;;
    op-reth-replica)
      if [[ "$block_hash" != "$sequencer_hash" ]]; then
        echo "The modified nodes disagree on the deposit block" >&2
        exit 1
      fi
      ;;
    op-reth-control)
      if [[ "$block" != "$sequencer_block" || "$parent" != "$sequencer_parent" || "$block_hash" == "$sequencer_hash" ]]; then
        echo "The control node did not diverge at the expected deposit block" >&2
        exit 1
      fi
      ;;
  esac
  case "$node:$status:$count" in
    op-reth:0x0:0|op-reth-replica:0x0:0|op-reth-control:0x1:1) ;;
    *)
      echo "Unexpected deposit status or counter on $node" >&2
      exit 1
      ;;
  esac
done
printf 'Shared parent %s\n' "$sequencer_parent"
