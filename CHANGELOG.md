# The changelog of Shuttle

The behavior of the gateway is described in [docs/spec.md](docs/spec.md). The
decisions behind it are in [docs/decisions.md](docs/decisions.md).

## 0.4.0

The release that makes the backend of the shared state a choice of the
deployment: the sessions, the rate limits and the cached decisions live in
a Redis server or in a Postgres server, and the gateway measures the two
side by side.

### The shared state may live in a Postgres server

The scheme of the url picks the backend:

| The url | The backend |
| --- | --- |
| `redis://...`, `rediss://...` | A Redis server, exactly as before. |
| `postgres://...`, `postgresql://...` | A Postgres server. |

The two hold the same three things and they hold them with **the same
contract**: the same suite of tests runs against both
(`test/integration/shared-state-conformance.ts`), so the two are proven to
be interchangeable and not only to be similar.

The atomicity of the shared state is the same on both sides. The two
scripts of Redis become two **functions** of Postgres, because a function
call is a transaction of the server:

| Operation | Redis | Postgres |
| --- | --- | --- |
| Read a session and refresh its expiry | the `TOUCH_SCRIPT` | `shuttle.session_touch` |
| Count a request in the window of a caller | the `WINDOW_SCRIPT` | `shuttle.rate_limit_check` |

The counters of the replicas are exact: the checks of one key are
serialized with an advisory lock, and the test of the replicas proves it
with several processes that count at the same time.

### The comparison of the backends

The script `bun run benchmark` runs the same traffic against the same
gateway with the two backends and prints the table of the comparison. The
measurements are in [docs/capacity.md](docs/capacity.md).

On the reference environment, with 20 000 requests at 50 in flight:

| Scenario | In the process | Redis | Postgres |
| --- | --- | --- | --- |
| The limits | 6380 req/s | 5685 req/s | 3492 req/s |
| The limits and the session | 6260 req/s | 4555 req/s | 2591 req/s |
| The whole path of a request | 5130 req/s | 3397 req/s | 2438 req/s |

Redis costs about a tenth of the throughput on the path of the limiter;
Postgres costs about half of it. The difference is the round trip: every
round trip is a round trip, and a transaction of a database is a round
trip that waits for the server.

### The server does not wait for the disk

`SHUTTLE_POSTGRES_SYNCHRONOUS_COMMIT=off` is the default. The state of the
shared state is a protection and not a ledger: a counter that is lost when
the server crashes costs a caller a few requests of its budget. It is the
same guarantee a Redis server gives without its append only file, and it
is the difference between a millisecond and a tenth of a millisecond on
every transaction of the limiter. With `on`, the scope of the deployment
serializes the requests of the whole deployment and every one of them
waits for the disk.

### The schema of the shared state

The gateway builds the schema of a Postgres server when it connects
(`SHUTTLE_POSTGRES_AUTO_MIGRATE`, the default outside a production
deployment). The statements are idempotent and an advisory lock makes one
replica build the schema while the others wait for it. A production
deployment that applies its own migrations says no and runs
`bun run postgres:migrate -- <url>` instead.

**This is not a change of the contract of the gateway.** The behaviour of
the sessions, of the limits and of the decisions is the same on both
backends, and a deployment that keeps its Redis server does not change
anything.

## 0.3.0

The release that replaces the hand-rolled parts of the trust boundary with
the libraries that implement the standards, and that slides the window of
the limits.

### The signature of the identity is a JWS

The signature of the identity was a hex digest of a canonical JSON array,
with the version in front of the value. Every upstream that wanted to
verify it had to implement the canonical form of Shuttle **and** compare a
value, and a comparison can be written wrong.

The signature is now a **JWS** (RFC 7515) signed with `HS256` and the
derived key, with a **detached** payload: the payload is not transmitted.
The upstream rebuilds it from the request and from the identity headers,
rebuilds the compact serialization around it and verifies it with a
standard library:

```ts
await jose.compactVerify(token, derivedKey)
```

The payload is a canonical JSON **object** with named fields, so a field
cannot be confused with another one and no value can move from one field
into another.

**This is a change of the contract.** The value of the header is now
`v4=<the detached JWS>` instead of `v3=<hex>`, and the payload is an
object instead of an array. An upstream that verifies the signature has to
be changed with the gateway. The migration is described in
[spec.md](docs/spec.md) §7.4.

### The cookies are parsed by the standard

The gateway had two parsers of its own, with two slightly different rules:
a quoted value, a value that carries an `=` and an `Expires` that carries
a comma were not handled the way RFC 6265 describes them. The parsing and
the rendering are now the ones of the library that implements the
standard. The rules of the gateway do not change: the first value of a
name that appears twice is kept, and the name of a cookie is case
sensitive.

### The window of the limits slides

The limits were counted in **fixed** windows, and a fixed window has a
property that a limit does not want: a caller that spent its whole budget
at the end of a window and its whole budget again at the beginning of the
next one crossed the gateway twice as fast as the limit allows.

The window **slides**: the count of a caller is the number of its requests
in the last `windowMs` milliseconds. It is counted in buckets of at most
60, so the state of a caller does not grow with its traffic, and the
boundary of a bucket is a moment every replica can compute, so the
replicas count in the same buckets. The `retry-after` of a refusal is the
time until the oldest requests of the window leave it.

### The client of the shared state is the one of the `redis` package

The client was the one of the runtime, so the shared state was tied to it
and could not speak to a cluster nor to a sentinel. The client is now the
one of the `redis` package:

- a url that names several hosts is a **cluster**;
- `SHUTTLE_REDIS_SENTINEL_MASTER` names the master, and the hosts of the
  url are then the **sentinels**;
- the offline queue stays disabled, so a command that is sent before the
  connection is established fails right away and the gateway denies the
  caller instead of piling up the requests;
- the connection is established in the background, so a gateway that starts
  while the shared state is down stays up and becomes ready when the
  server answers.

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

### The policies of a route

Three policies are properties of a route rather than of the deployment, and
they replace the value of the defaults:

- `crossSite` refuses the navigations from another site on that route. It
  is the policy of a route whose upstream changes the state of something on
  a `GET`: such a route may only be reached from the site itself.
- `forwardAuthorization` decides whether the `Authorization` header of the
  caller is forwarded to the upstream of the route. The header is a
  credential of the caller: forwarding it places the upstream in the trust
  domain of that credential. The identity of the caller reaches the
  upstream either way, in the headers of the gateway and in the signature.
- `accessCacheTtlMs` is the lifetime of the cached decisions of the access
  service on that route. It is the latency of a revocation there: a route
  that sets `0` asks the service for every request.

### The handshake of a websocket follows the header policy

The handshake with the upstream is a request: it follows the same header
policy as the requests of the http path.

Before this release the handshake copied the headers of the caller, and the
cookie of the session of the gateway reached the upstream. The session of a
caller is a credential, and an upstream that holds it can act as the
caller. The cookies of the gateway are stripped now, the identity of the
caller is written by the gateway, and the token of the caller is forwarded
only when the route says so.

### The TLS of the connections to the upstreams

An upstream that is served over `https` is reached over TLS. The gateway
verifies its certificate with the authority of the deployment and presents
the certificate of the deployment when the upstream asks for one:

- `SHUTTLE_UPSTREAM_TLS_CA` — the authority that signs the certificate of
  the upstream.
- `SHUTTLE_UPSTREAM_TLS_CERT` and `SHUTTLE_UPSTREAM_TLS_KEY` — the
  certificate of the gateway and its private key. They belong together: a
  deployment that sets one without the other is refused at the start.

The upstream of a websocket is served over plain http: the websocket client
of the runtime cannot speak TLS, and the gateway refuses such a handshake
with the reason `tls` instead of failing with an error that hides the
cause.

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
