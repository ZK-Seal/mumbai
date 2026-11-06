#!/bin/sh
# Fetches the two dependencies into lib/ at pinned commits. lib/ is not tracked.
set -eu
cd "$(dirname "$0")"

fetch() {
  dir="lib/$1"
  [ -d "$dir" ] || git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 clone --quiet --depth 1 --branch "$3" "$2" "$dir"
  got="$(git -C "$dir" rev-parse HEAD)"
  [ "$got" = "$4" ] || { echo "$1: wanted $4, found $got" >&2; exit 1; }
  echo "$1 $3 $got"
}

fetch forge-std https://github.com/foundry-rs/forge-std.git v1.9.7 77041d2ce690e692d6e03cc812b57d1ddaa4d505
fetch openzeppelin-contracts https://github.com/OpenZeppelin/openzeppelin-contracts.git v5.3.0 e4f70216d759d8e6a64144a9e1f7bbeed78e7079
