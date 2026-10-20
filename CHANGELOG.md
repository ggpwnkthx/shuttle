# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
the versions follow [semantic versioning](https://semver.org/).

## [Unreleased]

### Security

* **The session cookie of the gateway is never forwarded to an upstream.**
  The cookie is a credential of the caller: an upstream that received it
  could act as the caller against the gateway itself, and against every
  other route of it. The cookies of the application are still forwarded, and
  a request without a cookie is not changed.
* **An upstream cannot write a cookie of the gateway.** A `Set-Cookie` of
  the upstream that names `shuttle_session` or `shuttle_oidc_state` is
  removed from the answer. Without that, an upstream could fix the session
  of a browser to an id of its choice, or log the browser out.
* **The headers of the answer of an upstream are filtered.** The hop-by-hop
  headers, the identity headers (`x-shuttle-*`), the signature header and
  the forwarding headers are removed. An upstream could put an identity into
  the answer of the gateway, where a browser or a client library would read
  it and believe it.
* **The address of the caller is the right-most entry of the forwarded chain
  that is not a trusted proxy.** The chain used to be read from the left, so
  a client behind a trusted proxy could choose the address the gateway
  attributed to it, and with it the key of the rate limiter. The entries a
  client injected are dropped from the chain that is forwarded upstream.
* **A sibling subdomain cannot change the state of an upstream.**
  `Sec-Fetch-Site: same-site` means the same registrable domain, not the
  same origin. A request from a sibling subdomain with an `Origin` that is
  not the origin of the gateway is now refused like a cross site request.
* **A control character in the target of a login is refused.** Browsers
  strip the tabs and the newlines of a url before they resolve it, so a
  target that carried one could leave the site.
* **The message of a `502` names no internal host and no internal port.** The
  details are in the log, the caller learns that the upstream could not be
  reached.

### Changed

* **The identity signature is `v3`.** The payload binds the whole request
  target: the method, the path, the query string and the host. A `v1`
  signature only bound the method and the path, so it could be replayed onto
  another query string of the same path. The payload is a json array now, so
  a value that contains a newline, a comma or a quote cannot be moved from
  one field into another. An upstream that verifies the signature has to
  verify a `v3` signature.
* **The signed request is the request as the upstream receives it.** The
  path and the query string of a `v2` signature were the ones of the
  *client*, and an upstream cannot reconstruct them: it sees the path of
  the *upstream* and the host of the upstream. The verification of a `v2`
  signature therefore never worked. A `v3` signature covers the path and the
  query string of the url the gateway fetches and the host the client used,
  which the gateway writes into `x-forwarded-host`. An upstream verifies the
  signature with the values it has.
* **The roles of the signature are the roles of the header.** A role that
  contains a comma is not written into `x-shuttle-roles`, so it was not
  signed either: an upstream that reconstructed the roles from the header
  could not verify the signature. The complete list is still handed to the
  access service unfiltered.
* **The upload and the body budget are idle budgets.** They measure the
  time between two events, not the total duration of the phase. A client
  that uploads slowly, or an upstream that streams server sent events for
  hours, is not cut off as long as it keeps making progress. A client or an
  upstream that stops making progress is cut off after the budget. The
  connect and the headers budget are unchanged: they bound a phase that has
  one end.
* **The request limiter has two tiers.** The budget of a caller is counted
  per route, so a caller that is busy on one route does not spend the budget
  of the other ones. A second, global budget (`SHUTTLE_RATE_LIMIT_GLOBAL_MAX`,
  off by default) counts the requests of a caller over all the routes: it is
  the protection against a flood, and it is the reason the per route budget
  can be generous.
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

* The global request limiter: `SHUTTLE_RATE_LIMIT_GLOBAL_MAX` and
  `SHUTTLE_RATE_LIMIT_GLOBAL_WINDOW_MS` count the requests of a caller over
  all the routes. It is the protection against a flood.
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
