#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source chain/scripts/replica-rpc.sh

sequencer=$(cast_in_network ledgera-chain rpc --rpc-url http://op-node:8547 optimism_syncStatus)
replica=$(cast_in_network ledgera rpc --rpc-url http://op-node-replica:8547 optimism_syncStatus)
if ! height=$(jq -er '.safe_l2.number | select(type == "number" and . > 0)' <<< "$sequencer"); then
  echo "The sequencer has no safe block after genesis" >&2
  exit 1
fi
expected=$(jq -er '.safe_l2.hash' <<< "$sequencer")
replica_height=$(jq -er '.safe_l2.number | select(type == "number")' <<< "$replica")

if (( replica_height < height )); then
  echo "Replica safe head $replica_height is behind sequencer safe head $height" >&2
  exit 1
fi

printf -v block '0x%x' "$height"
actual=$(cast_in_network ledgera rpc --rpc-url http://op-reth-replica:8545 eth_getBlockByNumber "$block" false | jq -er '.hash')
printf 'Safe block %s\nSequencer  %s\nReplica    %s\n' "$height" "$expected" "$actual"
test "$expected" = "$actual"
