#!/usr/bin/env bash
#
# A Redis server for the tests of the shared state.
#
# The CI workflow runs the tests against a Redis service. A developer
# without docker can use this script: it downloads the packages of the
# distribution (nothing is installed, the files are extracted into a
# directory of its own) and starts a server on a port of its choice.
#
#   scripts/redis-dev.sh start [port]   → starts the server in the background
#   scripts/redis-dev.sh stop [port]    → stops it
#   scripts/redis-dev.sh url [port]     → prints the url for the tests
#
# The tests are then run with:
#
#   SHUTTLE_TEST_REDIS_URL=redis://127.0.0.1:6379/0 bun test test/integration
set -euo pipefail

PORT="${2:-6379}"
ROOT="${SHUTTLE_REDIS_DEV_ROOT:-/tmp/shuttle-redis}"
BASE="http://deb.debian.org/debian/pool/main"
# The packages of the distribution: the server, the tools, the allocator and
# the compression library it is linked against.
PACKAGES=(
  "r/redis/redis-server_7.0.15-1~deb12u7_amd64.deb"
  "r/redis/redis-tools_7.0.15-1~deb12u7_amd64.deb"
  "j/jemalloc/libjemalloc2_5.3.0-1_amd64.deb"
  "libl/liblzf/liblzf1_3.6-3_amd64.deb"
)

export LD_LIBRARY_PATH="${ROOT}/extracted/usr/lib/x86_64-linux-gnu"

download() {
  mkdir -p "${ROOT}/packages" "${ROOT}/extracted"
  for package in "${PACKAGES[@]}"; do
    local file="${ROOT}/packages/$(basename "${package}")"
    if [ ! -f "${file}" ]; then
      echo "fetching ${package}"
      curl -sSLo "${file}" "${BASE}/${package}"
    fi
    dpkg-deb -x "${file}" "${ROOT}/extracted"
  done
}

case "${1:-start}" in
  start)
    download
    mkdir -p "${ROOT}/data"
    nohup "${ROOT}/extracted/usr/bin/redis-server" \
      --port "${PORT}" \
      --bind 127.0.0.1 \
      --dir "${ROOT}/data" \
      --save '' \
      --appendonly no \
      > "${ROOT}/redis-${PORT}.log" 2>&1 &
    for _ in $(seq 1 50); do
      if "${ROOT}/extracted/usr/bin/redis-cli" -p "${PORT}" ping > /dev/null 2>&1; then
        echo "the server of the shared state listens on 127.0.0.1:${PORT}"
        exit 0
      fi
      sleep 0.2
    done
    echo "the server did not start, the log is in ${ROOT}/redis-${PORT}.log" >&2
    exit 1
    ;;
  stop)
    "${ROOT}/extracted/usr/bin/redis-cli" -p "${PORT}" shutdown nosave || true
    echo "the server on the port ${PORT} is stopped"
    ;;
  url)
    echo "redis://127.0.0.1:${PORT}/0"
    ;;
  *)
    echo "usage: $0 {start|stop|url} [port]" >&2
    exit 2
    ;;
esac
