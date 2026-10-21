#!/usr/bin/env bash
#
# A Postgres server for the tests of the shared state.
#
# The CI workflow runs the tests against a Postgres service. A developer
# without docker can use this script: it downloads the packages of the
# distribution (nothing is installed, the files are extracted into a
# directory of its own) and starts a server on a port of its choice.
#
#   scripts/postgres-dev.sh start [port]  → starts the server in the background
#   scripts/postgres-dev.sh stop [port]   → stops it
#   scripts/postgres-dev.sh url [port]    → prints the url for the tests
#
# The tests are then run with:
#
#   SHUTTLE_TEST_POSTGRES_URL=postgres://postgres@127.0.0.1:5432/shuttle bun test test/integration
set -euo pipefail

PORT="${2:-5432}"
ROOT="${SHUTTLE_POSTGRES_DEV_ROOT:-/tmp/shuttle-postgres}"
BASE="http://deb.debian.org/debian/pool/main"
# The packages of the distribution: the server, the client and the
# libraries it is linked against.
PACKAGES=(
  "p/postgresql-15/postgresql-15_15.18-0+deb12u1_amd64.deb"
  "p/postgresql-15/postgresql-client-15_15.18-0+deb12u1_amd64.deb"
  "p/postgresql-15/libpq5_15.18-0+deb12u1_amd64.deb"
)

export LD_LIBRARY_PATH="${ROOT}/extracted/usr/lib/x86_64-linux-gnu:${ROOT}/extracted/usr/lib/postgresql/15/lib:${LD_LIBRARY_PATH:-}"
# The server refuses a locale it does not know: the sandbox of a developer
# often has one that the distribution does not ship.
export LC_ALL=C
export LANG=C

download() {
  mkdir -p "${ROOT}/packages" "${ROOT}/extracted"
  for package in "${PACKAGES[@]}"; do
    file="${ROOT}/packages/$(basename "${package}")"
    if [ ! -f "${file}" ]; then
      echo "fetching ${package}"
      curl -fsSLo "${file}" "${BASE}/${package}"
    fi
    dpkg-deb -x "${file}" "${ROOT}/extracted" || true
  done
}

# The server refuses to run as root, and the sandbox of a developer is
# rarely root. The account of the operator is used when it is not root.
RUN_AS=""
if [ "$(id -u)" = "0" ]; then
  RUN_AS="postgres"
fi

case "${1:-start}" in
  start)
    download
    data="${ROOT}/data"
    if [ ! -d "${data}/base" ]; then
      rm -rf "${data}"
      mkdir -p "${data}"
      chmod 700 "${data}"
      if [ -n "${RUN_AS}" ]; then
        chown -R "${RUN_AS}" "${ROOT}" 2>/dev/null || true
        su "${RUN_AS}" -c "${ROOT}/extracted/usr/lib/postgresql/15/bin/initdb -D ${data} -U postgres --auth-local=trust --auth-host=trust" > "${ROOT}/initdb.log" 2>&1
      else
        "${ROOT}/extracted/usr/lib/postgresql/15/bin/initdb" -D "${data}" -U postgres --auth-local=trust --auth-host=trust > "${ROOT}/initdb.log" 2>&1
      fi
    fi
    mkdir -p "${ROOT}/run"
    if [ -n "${RUN_AS}" ]; then
      chown -R "${RUN_AS}" "${ROOT}/run" 2>/dev/null || true
      su "${RUN_AS}" -c "${ROOT}/extracted/usr/lib/postgresql/15/bin/pg_ctl -D ${data} -o '-p ${PORT} -k ${ROOT}/run -h 127.0.0.1' -l ${ROOT}/postgres-${PORT}.log start" > /dev/null
    else
      "${ROOT}/extracted/usr/lib/postgresql/15/bin/pg_ctl" -D "${data}" -o "-p ${PORT} -k ${ROOT}/run -h 127.0.0.1" -l "${ROOT}/postgres-${PORT}.log" start > /dev/null
    fi
    for _ in $(seq 1 100); do
      if "${ROOT}/extracted/usr/lib/postgresql/15/bin/pg_isready" -h 127.0.0.1 -p "${PORT}" > /dev/null 2>&1; then
        "${ROOT}/extracted/usr/lib/postgresql/15/bin/createdb" -h 127.0.0.1 -p "${PORT}" -U postgres shuttle > /dev/null 2>&1 || true
        echo "the server of the shared state listens on 127.0.0.1:${PORT}"
        exit 0
      fi
      sleep 0.2
    done
    echo "the server did not start, the log is in ${ROOT}/postgres-${PORT}.log" >&2
    exit 1
    ;;
  stop)
    if [ -n "${RUN_AS}" ]; then
      su "${RUN_AS}" -c "${ROOT}/extracted/usr/lib/postgresql/15/bin/pg_ctl -D ${ROOT}/data stop -m fast" > /dev/null 2>&1 || true
    else
      "${ROOT}/extracted/usr/lib/postgresql/15/bin/pg_ctl" -D "${ROOT}/data" stop -m fast > /dev/null 2>&1 || true
    fi
    echo "the server on the port ${PORT} is stopped"
    ;;
  url)
    echo "postgres://postgres@127.0.0.1:${PORT}/shuttle"
    ;;
  *)
    echo "usage: $0 {start|stop|url} [port]" >&2
    exit 2
    ;;
esac
