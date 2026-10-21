# The changelog of Shuttle

The behavior of the gateway is described in [docs/spec.md](docs/spec.md). The
decisions behind it are in [docs/decisions.md](docs/decisions.md).

## Unreleased

### The traffic survives an outage of the access service

An outage of the access service took the whole deployment down: the gateway
answers `503 access_unavailable` to every request of a route that needs a
decision, and the decisions it has are only good for a few seconds.

A route may now ask for a **grace**: `accessStaleGraceMs`
(`SHUTTLE_ACCESS_STALE_GRACE_MS`, `0` by default) is the time the last
decision of the service may be served after the service became unreachable.

```jsonc
{
  "id": "workspace-api",
  "accessStaleGraceMs": 30000
}
```

The rules of the grace:

- it is **off by default**: an unreachable service is an outage, and the
  outage has to be visible;
- a stale decision is served only when it **allows** the caller. A denial
  that is served instead of the outage would hide the outage from the
  operator;
- the revalidation of an open connection asks for a **fresh** decision, so
  a connection whose access was revoked is closed even while the service is
  down.

The decisions that were served this way are counted in
`shuttle_access_stale_total{route}`, and the age of the decision is
measured in `shuttle_access_stale_age_seconds{route}`.

### A route that names no workspace is checked by the access service

The access service was only asked about a **workspace**, so a deployment
that has no workspaces had no way to ask it anything: it had to invent a
workspace to get an answer.

A route may now ask for a check with `accessCheck`, and the request of the
service then carries the subject, the route and the roles, and no
workspace:

```jsonc
{
  "id": "admin-api",
  "auth": { "mode": "session" },
  "accessCheck": true
}
```

The `workspaceId` of the protocol is now optional, the reference
implementation of the service decides on the `routes` of its policy file
when the request names no workspace, and the conformance suite checks the
request that names none.

### The body of a request that is never sent again is not held in memory

A route that names several upstreams held the body of every request in
memory, up to `SHUTTLE_REPLAY_MAX_BYTES`, so that it could be sent to the
next upstream. The body of a request that may not be sent twice — a
`POST`, or any method that is not idempotent — was held for nothing: it
cost the memory of the gateway and the upstream was only reached once the
whole body had arrived, which loses the early answer of the upstream.

The body of a request that may not be sent again is now streamed, like the
body of a route that names one upstream.

### The failover of a route reaches an upstream that does not answer

A route may name several upstreams, and the gateway tries them in the order
of the list. The next one was tried when the **connection** to the first one
failed: an upstream that accepts the connection and never answers ate the
whole budget of the route — the budget of the answer is the budget of the
whole exchange — and the upstreams behind it were never reached.

An attempt that has another upstream behind it is now abandoned after
`upstreamAttemptMs` (`SHUTTLE_UPSTREAM_ATTEMPT_TIMEOUT_MS`, 2 s by default),
and the next upstream is tried. The budget of an attempt applies only to a
request that may be sent twice, and never to the last upstream of the list.

```jsonc
{
  "id": "workspace-api",
  "upstream": ["http://upstream-a:3000", "http://upstream-b:3000"],
  "timeouts": { "upstreamAttemptMs": 2000 }
}
```

### A request with a body may be sent again to the next upstream

A request with a body was never sent to a second upstream, whatever the
method: the bytes of a stream are already on their way to the first one.
The failover of a route was therefore useless for the traffic that carries a
body, which is most of an API.

A body is now held in memory when it announced a length that fits in
`replayMaxBytes` (`SHUTTLE_REPLAY_MAX_BYTES`, 64 KiB by default), so that
the request may be sent again. The memory of the gateway is bounded by the
limit and by the number of exchanges that run at the same time, and a body
that does not fit is streamed and the request is sent once, as before.

The body is only held in memory when the route names several upstreams: a
route with one upstream has nothing to fail over to, and streaming its body
preserves the early answer of the upstream.

A request that changes the state of an upstream is never sent twice,
whatever the body: the method decides, and only the idempotent ones may be
sent again.

### A route may name the methods it accepts

The matcher is a host and a path, and the method decided between two routes
that matched the same request: one of them had to be renamed or moved to a
different path.

A route may now name the methods it accepts:

```jsonc
{
  "id": "read",
  "match": { "host": "api.example.com", "path": "/thing", "methods": ["GET"] },
  "upstream": "http://upstream-a:3000"
}
```

A route that names the methods it accepts handles the other ones nowhere.
Among the routes that match, the one that names the method of the request
wins over the one that names none, and the one that names none is the
fallback of the others. Two routes that name different methods are not
ambiguous; two routes that name the same ones are refused, as before.

### The protocol of the access service is published

The access service is a dependency of the deployment and not a part of
Shuttle: the gateway asks it and fails closed when it cannot be reached. The
protocol was written down only in the code of the client, so a deployment
that wrote its own service had to read the source to know what the gateway
expects.

The protocol is now in the specification (§6.1): the request, the answer,
the statuses and what each of them means. A contract that nobody can check
is a contract that drifts, so the protocol is checked by a **conformance
suite** that any implementation may run —
`test/integration/access-conformance.ts`. A deployment that writes its own
access service runs the suite against it:

```bash
SHUTTLE_TEST_ACCESS_URL=http://127.0.0.1:8090 \
SHUTTLE_TEST_ACCESS_TOKEN=… \
SHUTTLE_TEST_ACCESS_ALLOWED_SUBJECT=alice@example.com \
bun test test/integration/access-conformance.test.ts
```

A **reference implementation** ships with the project:
`services/access-service.ts` applies a policy file and answers the
protocol. It is not a fixture — the fixtures carry accounts with known
passwords and refuse to run in a production environment, and this one
carries the policy of the operator. The suite runs against it in the test
suite, so the protocol and its reference do not drift apart either.

### The policy that is running is written in the log

A route table is a JSON file and an environment with dozens of variables:
the policy a route really runs with is spread over the two, and the
permissive settings are the ones nobody reads.

The gateway now writes the policy it is running, once per generation: one
line for the configuration, one line for every route (the host, the path,
the upstreams, the credential it accepts, the workspace it asks about, the
policy of the cross site requests, whether the credential of the caller
reaches the upstream, the budgets) and one warning for every setting that
is permissive:

- a route that forwards a caller that was not authenticated;
- a route that authenticates the caller but never asks the access service;
- a route that hands the credential of the caller to the upstream;
- a route that accepts a navigation from another site while it accepts a
  session;
- a route that accepts a body of any size;
- a route that names several upstreams, where the failover is limited to the
  requests that may be sent twice.

The warnings are not errors and a deployment may want them. They are
settings that look active but that nobody may have read, and a warning that
says so is worth more than a silent default.

The credentials of an upstream never reach the log: a url that carries a
password in it is written without the password, in this log and in the
others.

### The latency of the access service is published

The access service is on the path of every request of a workspace, and it
had no latency of its own: the gateway published the latency of the
upstreams and the latency of the whole exchange, and an operator that saw
the requests slow could not tell a slow service from a slow upstream.

`shuttle_access_duration_seconds` publishes the latency of the calls to the
service. Only the calls that reached it are counted: a decision that came
from the cache cost nothing.

### The gateway refuses to start on a runtime that is too old

The contract states **Bun ≥ 1.4.3** and the measurements of
[docs/runtime.md](docs/runtime.md) show that the boundaries the gateway
relies on — the early answer of an upstream while the upload runs, the
cancellation of the producer of the body, the refusal of the handshake of an
upstream websocket and the upgrade of the caller with the headers of the
gateway — are not observable on the 1.2 line.

Nothing checked the version of the runtime: a gateway started on an older
line booted happily and then behaved in ways the specification does not
describe, and the difference is only visible in production. The version is
now checked before the process reads its environment, and the gateway stops
with a message that names the version it needs.

### An outage of the access service is not a denial

The gateway asks the access service whether a caller may use a workspace and
it fails closed: without a decision, the request is refused. The two
refusals were the same, and that hid the outage — an operator could not
tell a failing access service from a policy that denies the callers, and
the metric of the denials counted the outage as a denial.

Only an explicit `{"allow": false}` is a denial, and it is still
`403 workspace_forbidden`. A service that could not be asked, or an answer
that could not be read, is the unavailability of the service: the gateway
answers `503 access_unavailable` with a `retry-after`, so the caller knows
it may come back, and the outage is counted on
`shuttle_access_unavailable_total` and not among the denials.

### An id token is not an access token

The gateway accepted the id token of the provider as a bearer credential:
it validated the signature, the issuer, the audience, the expiry and the
subject, and many providers publish an id token and an access token for the
same client and the same audience. An id token travels through the browser —
it lands in the history, in the logs and in the referrers — and accepting
one hands a credential that was meant for the browser to every route that
accepts a bearer token.

A bearer token has to be an access token now. The browser flow of the
gateway always asks for a nonce, so the id token of this client always
carries a `nonce` claim and an access token never does: a bearer token that
carries a nonce is refused. A provider that publishes a claim that names the
type of the token names it in `SHUTTLE_OIDC_REQUIRED_TOKEN_CLAIMS`, and a
token that does not carry it is refused as well.

The check of the nonce is on by default and
`SHUTTLE_OIDC_REJECT_NONCE_TOKEN=false` turns it off for a provider whose
access tokens carry a nonce anyway.

### The three budgets of a request cost one round trip


The path of a request through the state the replicas share was six round
trips: the budget of the deployment, the budget of the caller over all the
routes, the budget of the caller on the route, the session of the caller,
the budget of the authenticated caller and the cached decision of the access
service.

The three budgets of the first group are independent, so they are counted
**at the same time** now: the client of the `redis` package writes the
commands that were queued in the same tick in one go, so the three of them
reach the server in one round trip. The path is four round trips now, and
the measurements of the next release will show it.

Every budget is counted, even when one of them refuses: the request was
made, and the budget of the caller is spent by the requests that were made.
The refusal that is reported is the first of the order of the
specification.

The order of the pipeline did not change: the budgets are counted before
the authentication, so a flood is stopped before it reaches the session
store.

### The signature of the identity is asymmetric

The gateway signed the identity of every request it forwarded with a key
that was **derived from the secret of the sessions**, and it gave that key
to every upstream. An upstream that could verify an identity could then
mint one: the trust boundary was the network and not the key, and an
upstream that could reach the gateway could forge an identity for any
subject.

The signature is asymmetric now. The gateway holds the **private key** of
the deployment and the upstreams are given the **public** key: they
verify the identity of a request and they cannot mint one. The key is an
elliptic curve key on the curve P-256 and the signature is an `ES256` one
— a JWS, so an upstream verifies it with a standard library and not with an
implementation of Shuttle.

The version of the format is `v5`: a signature of the symmetric format
never verifies with the public key, and the other way round.

**The migration.** A production deployment has to set the key, and the
upstreams have to verify `v5` before the gateway signs it:

```bash
bun run identity:key              # a new pair
bun run identity:key --public     # the public key of the key in the environment
```

The private key goes to the secret store of the deployment and to
`SHUTTLE_IDENTITY_SIGNING_KEY`; the public key goes to the upstreams. The
gateway refuses to start in production without the key: a setting that
looks active but is not is a security hole.

A deployment that does not set the key keeps the symmetric format, and the
upstreams keep the derived key. It is not the format a production
deployment should use.

### A burst of requests asks the access service once

The cache of the decisions is empty every time its lifetime is over, and
the lifetime is five seconds by default. A burst of requests for the same
decision that arrived on the boundary of the lifetime asked the service as
many times as there were requests.

The calls that are in flight are shared now: the burst asks the service
once, and every waiter of the call receives the decision it answers. The
service that decides the access of the callers is not a cache that is
warmed once, and a stampede on it is an outage of the deployment.

### A route may declare the path its upstream receives

The prefix of the route was part of the path of the request, so an
application that is mounted somewhere else had to know the prefix of the
gateway: every upstream had to be built around the shape of the urls of the
gateway.

A route may declare the path its upstream receives now:

```jsonc
{
  "id": "workspace-api",
  "match": { "host": "api.example.com", "path": "/ws/{workspaceId}/" },
  "upstream": "http://upstream:3000",
  "rewrite": "/v1/workspaces/{workspaceId}/{rest}"
}
```

The placeholders of the rewrite are the placeholders of the path of the
route, and `{rest}` is the part of the path that follows the prefix the
route matched. A rewrite of `/{rest}` removes the prefix of the route, and
a rewrite without `{rest}` does not forward the rest of the path.

A route that does not declare a rewrite forwards the path of the request:
the behaviour of a deployment that declares none does not change.

### The trace of a request and the latency of the upstream

The gateway forwards the `traceparent` of the caller as it is, so a
malformed one reaches the collector of the upstream, and the trace of the
request is not visible in the log of the gateway.

The gateway writes a trace context of its own now: the id of the trace is
the one of the caller when it is well formed and a new one otherwise, the
span is always the one of the gateway — so the span of the upstream is a
child of it — and the flags of the caller are kept. The id of the trace is
written in the log of the request next to the request id, so the two
halves of a request are found with the same search.

The latency of the upstream is measured on its own and published as
`shuttle_upstream_duration_seconds`: it is the time from the moment the
request left the gateway to the final headers of the answer, and it is not
the latency of the gateway, which also holds the authentication, the
limits and the access service.

### The environment and its documentation cannot drift apart

The names of the environment live in `src/runtime/env.ts` and nowhere else,
but the example and the manual of the deployment describe them for the
operator, and the drift between the two was found in a review every time.

The check is in the build now: `bun run environment` verifies that every
variable of the gateway is in the example and that every variable the
gateway refuses to start without in production is described in the manual.
A variable that is described and does not exist is reported as well: a
setting that looks active but is not is a security hole.

The check found two variables that were missing from the example the day it
was written.

### A guide and a reference implementation for the upstreams

The signature of the identity is a contract: every upstream has to rebuild
the payload of the signature and verify it, and a format that an upstream
cannot reproduce is a format that only the gateway understands.

[docs/upstream-identity.md](docs/upstream-identity.md) is the guide for an
upstream — the headers, the key, the payload, the verification and the
code in TypeScript and in Go — and
[examples/upstream-identity/verify.ts](examples/upstream-identity/verify.ts)
is a **standalone** reference implementation: it imports nothing of the
gateway, so an upstream copies it or reads it and writes its own.

The test of the example signs with the key of the gateway and verifies with
the implementation of the upstream: a change of the format that breaks the
contract of the upstreams fails the build.

### A route may name several upstreams

A route named one upstream, so the restart of that upstream was an outage
of the route.

A route may name several now, and the gateway tries them in the order of
the list:

```jsonc
{ "id": "workspace-api", "upstream": ["http://upstream-a:3000", "http://upstream-b:3000"] }
```

The next one is tried when the **connection** to the first one fails, and
only when the request may be sent again: a request that changes the state
of an upstream may not be sent twice, and a request that has a body cannot
be replayed because the bytes are already on their way to the first
upstream.

The budget of the answer is the budget of the whole exchange, so a list of
upstreams does not make the timeout of a route longer. The handshake of a
websocket goes to the first upstream: a handshake is not a request that may
be sent twice.

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
measurements of the last run are in
[docs/capacity.md](docs/capacity.md); the table below is the run of the
release.

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

### The binaries of the release

The release workflow compiles the gateway for the seven platforms of the
release and publishes them on the release of the tag:

| Platform | The file |
| --- | --- |
| Linux x64 (glibc) | `shuttle-<version>-linux-x64` |
| Linux x64 (musl, Alpine) | `shuttle-<version>-linux-x64-musl` |
| Linux arm64 | `shuttle-<version>-linux-arm64` |
| macOS x64 | `shuttle-<version>-darwin-x64` |
| macOS arm64 | `shuttle-<version>-darwin-arm64` |
| Windows x64 | `shuttle-<version>-windows-x64.exe` |
| Windows arm64 | `shuttle-<version>-windows-arm64.exe` |

The binaries carry the runtime of the release inside them: nothing else has
to be installed. The workflow refuses a tag that does not name the version
of the package, it checks that every binary is of the format of its
platform, and it starts the binary of the runner and waits for its health
probe before it publishes anything. The checksums are published with them.

The image of the same release is published by the workflow of the release:
the two are published together, and the attestations of the image — the
provenance and the bill of materials — are added when it is pushed to the
registry.

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
