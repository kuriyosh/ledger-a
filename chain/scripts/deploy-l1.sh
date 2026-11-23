#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/../.."
source chain/versions.env

mkdir -p chain/.deployer
lock=chain/.deployer/l1-operation.lock
if ! mkdir "$lock" 2>/dev/null; then
  echo "Deployment is locked at $lock" >&2
  exit 1
fi
download_dir=
cleanup() {
  if [[ -n "$download_dir" ]]; then rm -rf "$download_dir"; fi
  rmdir "$lock"
}
trap cleanup EXIT

case "$(uname -s)" in
  Linux) platform=linux ;;
  Darwin) platform=darwin ;;
  *) echo "Unsupported OS for op-deployer" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  aarch64|arm64) arch=arm64 ;;
  x86_64) arch=amd64 ;;
  *) echo "Unsupported architecture for op-deployer" >&2; exit 1 ;;
esac
version=${OP_DEPLOYER_VERSION#v}
release="op-deployer-$version-$platform-$arch"
deployer="chain/.deployer/bin/$release"
if [[ ! -x "$deployer" ]]; then
  download_dir=$(mktemp -d chain/.deployer/download.XXXXXX)
  release_url="https://github.com/ethereum-optimism/optimism/releases/download/op-deployer/$OP_DEPLOYER_VERSION"
  curl -fsSL --retry 3 "$release_url/$release.tar.gz" -o "$download_dir/$release.tar.gz"
  checksum_var="OP_DEPLOYER_SHA256_$(printf '%s_%s' "$platform" "$arch" | tr '[:lower:]' '[:upper:]')"
  expected=${!checksum_var}
  actual=$(openssl dgst -sha256 "$download_dir/$release.tar.gz" | awk '{print $NF}')
  if [[ "$actual" != "$expected" ]]; then
    echo "Checksum mismatch for $release.tar.gz" >&2
    exit 1
  fi
  tar -xzf "$download_dir/$release.tar.gz" -C "$download_dir" "$release/op-deployer"
  mkdir -p "$(dirname "$deployer")"
  mv "$download_dir/$release/op-deployer" "$deployer"
fi

node --env-file-if-exists=.env --env-file=.env.generated chain/scripts/deploy-l1.ts "$deployer"
