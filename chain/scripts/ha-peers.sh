#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
umask 077

runtime=chain/runtime/ha
mkdir -p "$runtime"
peers=()
for n in 1 2 3; do
  key_file="$runtime/p2p-$n"
  if [[ ! -s "$key_file" ]]; then
    temporary=$(mktemp "$runtime/.p2p-XXXXXX")
    if ! docker run --rm "$OP_NODE_IMAGE" op-node p2p genkey > "$temporary"; then
      rm -f "$temporary"
      exit 1
    fi
    ln "$temporary" "$key_file" 2>/dev/null || test -s "$key_file"
    rm -f "$temporary"
  fi
  peer=$(docker run --rm -i "$OP_NODE_IMAGE" op-node p2p priv2id < "$key_file")
  [[ "$peer" =~ ^[[:alnum:]]+$ ]]
  peers[$n]="/dns4/op-node-$n/tcp/9222/p2p/$peer"
done
temporary=$(mktemp "$runtime/.peers-XXXXXX")
printf 'HA_PEERS_1=%s,%s\nHA_PEERS_2=%s,%s\nHA_PEERS_3=%s,%s\n' \
  "${peers[2]}" "${peers[3]}" "${peers[1]}" "${peers[3]}" "${peers[1]}" "${peers[2]}" \
  > "$temporary"
mv "$temporary" "$runtime/peers.env"
