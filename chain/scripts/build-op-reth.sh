#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

if [[ ! "${OPTIMISM_FORK_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Set a full Optimism fork commit in mise.toml" >&2
  exit 1
fi

checkout=$(mktemp -d)
trap 'rm -rf "$checkout"' EXIT
git -C "$checkout" init --quiet
git -C "$checkout" remote add origin "$OPTIMISM_FORK_REPO"
git -C "$checkout" config remote.origin.promisor true
git -C "$checkout" config remote.origin.partialclonefilter blob:none
git -C "$checkout" sparse-checkout set rust superchain-registry
git -C "$checkout" fetch --quiet --depth 1 --filter=blob:none origin "$OPTIMISM_FORK_COMMIT"
git -C "$checkout" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$checkout" rev-parse HEAD)" = "$OPTIMISM_FORK_COMMIT"
git -C "$checkout" submodule update --init --depth 1 superchain-registry

docker buildx build --load \
  --file "$checkout/rust/op-reth/DockerfileOp" \
  --build-context "superchain-registry=$checkout/superchain-registry" \
  --build-arg "BUILD_PROFILE=release" \
  --build-arg "GIT_COMMIT=$OPTIMISM_FORK_COMMIT" \
  --label "org.opencontainers.image.revision=$OPTIMISM_FORK_COMMIT" \
  --tag "$OP_RETH_IMAGE" \
  "$checkout/rust"
