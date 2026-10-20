# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
the versions follow [semantic versioning](https://semver.org/).

## [Unreleased]

### Changed

* **The identity signature is `v2`.** The payload binds the whole request
  target: the method, the path, the query string and the host. A `v1`
  signature only bound the method and the path, so it could be replayed onto
  another query string of the same path. The payload is a json array now, so
  a value that contains a newline, a comma or a quote cannot be moved from
  one field into another. An upstream that verifies the signature has to
  verify a `v2` signature.
* **The cross site guard covers every request that carries the session
  cookie**, also the ones of a route that has no policy of its own. The
  cookie is scoped to the root of the gateway, so a browser sends it to
  every path of it.
* **The origin of a request is computed from the effective protocol**: the
  one the trusted proxy reports in `X-Forwarded-Proto`, the configured
  `SHUTTLE_EXTERNAL_PROTO` otherwise. The origins are normalized before
  they are compared.
* **A logout from another site is refused.** A `GET /auth/logout` with
  `Sec-Fetch-Site: cross-site` or with an `Origin` of another site is
  refused with `403`.
* **The metrics of a request are written when the response body is
  completely streamed.** The duration is the time the caller waited and the
  bytes are the bytes that were really transferred, not the ones the client
  announced in its `content-length`.
* **The rate limits and the cached access decisions can be shared between
  the replicas.** `SHUTTLE_SHARED_STATE_URL` names a Redis compatible
  server; it defaults to the session url when that one is a Redis server.
  The shared state fails open: the limiter lets the request through and the
  cache is skipped when the server cannot be reached.

### Added

* A production deployment has to name its identity provider and its access
  service: `SHUTTLE_OIDC_ISSUER`, `SHUTTLE_OIDC_CLIENT_ID`,
  `SHUTTLE_OIDC_REDIRECT_URI`, `SHUTTLE_OIDC_CLIENT_SECRET` (or
  `SHUTTLE_OIDC_ALLOW_PUBLIC_CLIENT=true`), `SHUTTLE_ACCESS_URL` and
  `SHUTTLE_ACCESS_TOKEN` (or `SHUTTLE_ACCESS_ALLOW_ANONYMOUS=true`) are
  required. The gateway refuses to start without them.
* The websockets are bounded on both legs: the size of a message
  (`SHUTTLE_WS_MAX_PAYLOAD_BYTES`), the queue of a client that does not read
  (`SHUTTLE_WS_BACKPRESSURE_LIMIT_BYTES`) and the number of consecutive slow
  sends before the connection is closed.
* The websockets have a keepalive: the gateway pings the client and the
  upstream (`SHUTTLE_WS_PING_INTERVAL_MS`) and closes the connections that do
  not answer (`SHUTTLE_WS_PONG_TIMEOUT_MS`).
* The reason of a close frame is cut to the 123 bytes the protocol allows.
* The metric `shuttle_shared_state_errors_total` counts the times the state
  the replicas share was not reachable.

### Fixed

* A path with a broken percent encoding does not match a route any more. It
  matched a route with an unusable placeholder before, so the request was
  forwarded with an identifier that was missing.
* A role that contains a comma is not written into the `x-shuttle-roles`
  header any more: the list would have been ambiguous. The access service
  still receives the roles unfiltered.
* A trusted proxy that reports a protocol that is not `http` or `https` is
  ignored, so the origin of a request never depends on an unvalidated
  header.
