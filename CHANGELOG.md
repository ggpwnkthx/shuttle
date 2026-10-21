# The changelog of Shuttle

The behavior of the gateway is described in [docs/spec.md](docs/spec.md). The
decisions behind it are in [docs/decisions.md](docs/decisions.md).

## 0.2.0

The release that closes the gap between the specification and the
implementation, and that bounds the resources of the deployment.

### The state of a production deployment

The sessions and the state that the replicas share have to live in a Redis
server in a production deployment: a session that lives in the memory of one
replica is unknown to the others, so the callers are logged out at random,
and a limit that lives in the memory of one replica is the limit of that
replica and not the limit of the deployment, so a flood is bounded by the
number of the replicas.

The gateway refuses to start when `SHUTTLE_SESSION_URL` or
`SHUTTLE_SHARED_STATE_URL` do not name a Redis server. A deployment that
is a single node and that accepts the in-process state says so explicitly
with `SHUTTLE_ALLOW_MEMORY_STATE=true`.

### The version of the release

The version is written in the package, in the image, in the manifests of the
deployment and in the changelog. They named different releases. They all
name `0.2.0` now, and `bun run versions` fails the build when they drift
apart again.

### The release of the image

The release workflow publishes the image to the registry of the repository,
with the tag of the release (`v0.2.0`) and with the version itself
(`0.2.0`), which is the tag the manifests of the deployment name. It
refuses to release a tag that does not name the version of the package, and
it starts the image against a real Redis and waits for the readiness of the
gateway, the way a deployment runs.

### The host of a request

The `x-forwarded-host` of a **trusted proxy** is now honoured. It is the
host the caller used, and it decides three things that were previously
decided by the raw `Host` header: the route that handles the request, the
origin the browser is compared with, and the value the signature of the
identity covers.

Before this release, a deployment behind an ingress that rewrites the
`Host` header had two problems: the route did not match, and a legitimate
browser request from another origin was refused with `403
cross_site_request`.

The header of a client that is not a trusted proxy is still ignored, and a
value that is not a plausible host is ignored.

### The metrics of the requests

`shuttle_requests_total` now counts **every** answer of the gateway, the
refusals included. Before this release it counted only the requests that
reached an upstream, so the volume of the traffic and the error rate could
not be read off it.

The labels are bounded:

- `route` is the id of the route, `unmatched` for the requests that matched
  no route, or `overflow` beyond 500 routes.
- `method` is the upper-cased method, or `other` for a method that is not
  tracked. A client chooses the method, so it could create a series per
  method.
- `status` is the status, or `other` for a status that is not tracked. An
  upstream chooses the status, so it could create a series per status.

### The limits of the deployment

Two new scopes, and a fix to the limiter of the memory:

- `SHUTTLE_RATE_LIMIT_PRINCIPAL_MAX` bounds the requests of an
  **authenticated caller** on one route. The other scopes are keyed by the
  address of the caller, so they cannot tell two tenants behind the same
  address apart.
- `SHUTTLE_RATE_LIMIT_TOTAL_MAX` bounds the requests of the **whole
  deployment**. The scopes that are keyed by an address cannot bound a flood
  that spreads over many addresses.
- The table of the limiter of the memory no longer evicts a live window to
  make room for a new key. A caller that sprayed addresses reset its own
  counter at will. The requests that do not fit the table are now counted
  in one shared window, so the flood is bounded by the same limit.
- A production deployment has to set at least one rate limit, unless
  `SHUTTLE_ALLOW_NO_RATE_LIMITS=true`.

### The resources of the process

`SHUTTLE_MAX_CONCURRENT_REQUESTS` (1 000 by default) bounds the number of
exchanges that run at the same time. A client that opened a request and
never sent its body held a connection for the whole idle budget of the
upload, which is five minutes by default. An exchange that does not fit is
refused with `503 gateway_overloaded` rather than queued.

### The revalidation of the open websockets

An open WebSocket is revalidated every `SHUTTLE_WS_REVALIDATE_INTERVAL_MS`
(60 s by default). The route, the session and the access are checked again,
the access service is asked anew instead of reading the cache, and the
connection is closed with the code `1008` when one of them fails. A
revalidation that cannot be made closes the connection.

Before this release, a connection was authorized when it was opened and
never again: a revoked access or an expired session did not end it.

### The documentation

The specification, the architecture, the implementation guide and the
operations guide have been rewritten to be concrete and concise. The
decisions that changed the contract are recorded in
[docs/decisions.md](docs/decisions.md), with the tests that prove them.

## 0.1.0

The first release of the application gateway.

### What it does

- **Routing**: one upstream per route, matched on host and path, with a fixed
  precedence and an ambiguity check at load time.
- **Authentication**: OpenID Connect with PKCE for the browser, bearer tokens
  for the API clients, in four modes that decide predictably which credential
  a route accepts. A credential that the mode selected and that is invalid is
  refused: the request does not fall back to another credential.
- **Authorization**: the access service decides who may use a workspace; the
  gateway asks and fails closed. The reason of the service is never given to
  the caller.
- **Proxying**: streamed bodies, server sent events, uploads, a budget per
  phase of the upstream exchange (`responseMs`, `firstByteMs` and the idle
  `bodyMs`), a limit on the body and the websockets.
- **Header policy**: the hop-by-hop headers, the headers they nominate and
  the spoofable identity headers are removed, the cookies of the gateway
  never reach an upstream and an upstream can never write a cookie of the
  gateway.
- **Cross site requests**: the guard is driven by the presence of the cookie
  of the session and it refuses the requests that change the state of an
  upstream. A websocket handshake that carries the cookie has to name an
  allowed origin.
- **Sessions**: server side, in the process or in a Redis compatible store,
  with an idle lifetime and a maximum age. The cookie of the browser follows
  the session.
- **Operations**: health and readiness probes, Prometheus metrics, structured
  logs with redaction, a hot reload of the configuration and a graceful
  shutdown.

### The organization of the code

The domains own their policy, their ports, their adapters and their tests.
The import boundaries between them are checked by `scripts/architecture.ts`,
which runs in the test suite and in the CI workflow, so a violation fails
the build.

### The evidence

388 tests over 38 files, plus the tests against a real Redis, in a real
browser and against a real socket. The coverage of the lines of the source
is 90.9 %. The measurements of the capacity are in
[docs/capacity.md](docs/capacity.md).
