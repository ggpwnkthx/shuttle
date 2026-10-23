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

# The version of the server of the development. It is the version the CI
# workflow runs the tests against and the version the in-process engine of
# the tests (PGlite) is built on, so a developer and the CI measure the
# same server. A deployment is not bound to it: the gateway does not
# refuse a server that is older.
PG_VERSION="18"
PG_RELEASE="18.6-3.pgdg12+1"

# The packages of the server come from the repository of PostgreSQL: the
# distribution of the developer (Debian 12) ships PostgreSQL 15, and the
# repository of PostgreSQL builds the same server for it.
PGDG="http://apt.postgresql.org/pub/repos/apt/pool/main"
# The libraries the server is linked against come from the distribution.
DEBIAN="http://deb.debian.org/debian/pool/main"
# The server, the client and the library of the client, and the two
# libraries the server of PostgreSQL 18 is linked against and that a
# minimal distribution does not ship: `libnuma` and `liburing` (the
# latter is the library of the asynchronous I/O).
PACKAGES=(
  "${PGDG}/p/postgresql-${PG_VERSION}/postgresql-${PG_VERSION}_${PG_RELEASE}_amd64.deb"
  "${PGDG}/p/postgresql-${PG_VERSION}/postgresql-client-${PG_VERSION}_${PG_RELEASE}_amd64.deb"
  "${PGDG}/p/postgresql-${PG_VERSION}/libpq5_${PG_RELEASE}_amd64.deb"
  "${DEBIAN}/n/numactl/libnuma1_2.0.16-1_amd64.deb"
  "${DEBIAN}/libu/liburing/liburing2_2.3-3_amd64.deb"
)

# The binaries of the server, once the packages are extracted.
BIN="${ROOT}/extracted/usr/lib/postgresql/${PG_VERSION}/bin"

export LD_LIBRARY_PATH="${ROOT}/extracted/usr/lib/x86_64-linux-gnu:${ROOT}/extracted/usr/lib/postgresql/${PG_VERSION}/lib:${LD_LIBRARY_PATH:-}"
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
      curl -fsSLo "${file}" "${package}"
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
    # The data of a server of another version is not readable by this
    # one: the directory is built again when the version of the data is
    # not the version of the server.
    if [ -f "${data}/PG_VERSION" ] && [ "$(cat "${data}/PG_VERSION")" != "${PG_VERSION}" ]; then
      echo "the data of the server is of the version $(cat "${data}/PG_VERSION"), the server is of the version ${PG_VERSION}: the data is built again"
      rm -rf "${data}"
    fi
    if [ ! -d "${data}/base" ]; then
      rm -rf "${data}"
      mkdir -p "${data}"
      chmod 700 "${data}"
      if [ -n "${RUN_AS}" ]; then
        chown -R "${RUN_AS}" "${ROOT}" 2>/dev/null || true
        su "${RUN_AS}" -c "${BIN}/initdb -D ${data} -U postgres --auth-local=trust --auth-host=trust" > "${ROOT}/initdb.log" 2>&1
      else
        "${BIN}/initdb" -D "${data}" -U postgres --auth-local=trust --auth-host=trust > "${ROOT}/initdb.log" 2>&1
      fi
    fi
    mkdir -p "${ROOT}/run"
    if [ -n "${RUN_AS}" ]; then
      chown -R "${RUN_AS}" "${ROOT}/run" 2>/dev/null || true
      su "${RUN_AS}" -c "${BIN}/pg_ctl -D ${data} -o '-p ${PORT} -k ${ROOT}/run -h 127.0.0.1' -l ${ROOT}/postgres-${PORT}.log start" > /dev/null
    else
      "${BIN}/pg_ctl" -D "${data}" -o "-p ${PORT} -k ${ROOT}/run -h 127.0.0.1" -l "${ROOT}/postgres-${PORT}.log" start > /dev/null
    fi
    for _ in $(seq 1 100); do
      if "${BIN}/pg_isready" -h 127.0.0.1 -p "${PORT}" > /dev/null 2>&1; then
        "${BIN}/createdb" -h 127.0.0.1 -p "${PORT}" -U postgres shuttle > /dev/null 2>&1 || true
        version="$("${BIN}/psql" -h 127.0.0.1 -p "${PORT}" -U postgres -tAc "show server_version" 2>/dev/null || echo unknown)"
        echo "the server of the shared state (PostgreSQL ${version}) listens on 127.0.0.1:${PORT}"
        exit 0
      fi
      sleep 0.2
    done
    echo "the server did not start, the log is in ${ROOT}/postgres-${PORT}.log" >&2
    exit 1
    ;;
  stop)
    if [ -n "${RUN_AS}" ]; then
      su "${RUN_AS}" -c "${BIN}/pg_ctl -D ${ROOT}/data stop -m fast" > /dev/null 2>&1 || true
    else
      "${BIN}/pg_ctl" -D "${ROOT}/data" stop -m fast > /dev/null 2>&1 || true
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
