source chain/versions.env

cast_in_network() {
  local network=$1
  shift
  docker run --rm --network "$network" --entrypoint cast "$FOUNDRY_IMAGE" "$@"
}
