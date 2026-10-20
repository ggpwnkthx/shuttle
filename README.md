# Shuttle

Shuttle is a small application gateway. It routes requests to a single
configured upstream per route, authenticates callers against an OpenID Connect
provider, asks a separate access service whether a caller may use a workspace
and forwards everything else — including streamed responses and websockets.

```
                      ┌──────────────────────────────┐
   browser / client ─▶│  gateway listener (:8080)    │
                      │  auth · access · proxy · ws   │
                      └───────┬──────────────┬───────┘
                              │              │
                    OIDC provider     access service
                              │              │
                      ┌───────▼──────────────▼───────┐
                      │  upstream applications        │
                      └──────────────────────────────┘
```

## Scope

The scope of Shuttle is short on purpose. Everything below is part of it, and
everything that is not listed here is not.

### In scope

| Area | What Shuttle does |
| --- | --- |
| Routing | One upstream per route, matched on host and path, with a fixed precedence and an ambiguity check |
| Authentication | OpenID Connect: browser login with PKCE, bearer tokens for API clients, four modes that decide predictably which credential a route accepts |
| Authorization | The access service decides who may use a workspace. Shuttle asks and fails closed, it never decides on its own |
| Proxying | Streamed request and response bodies, server sent events, uploads, timeouts, body limits, websockets |
| Header policy | Hop-by-hop and spoofable headers are removed, identity headers are written by the gateway, forwarding headers are only trusted from known proxies |
| Sessions | Server side sessions in an in-process store or in a Redis compatible store, selected by the scheme of a url |
| Limits | A bound on the requests of a caller, on the login attempts and on the number of open websocket connections |
| Cross site requests | Requests of a browser that come from another site are refused when they change the state of an upstream |
| Identity | The identity the gateway writes into the headers is signed, so an upstream can verify that the request went through the gateway |
| Operations | Health and readiness probes, Prometheus metrics, structured logs with redaction, hot reload of the configuration, graceful shutdown |

### Out of scope

These are deliberately **not** part of Shuttle:

* **Role based access control in the gateway.** The roles of a caller are read
  from the token and handed to the access service, but the gateway never
  compares them to a list of its own. A route that declares roles is a
  configuration error, not a feature.
* **Hand-rolled infrastructure.** The metrics come from `prom-client`, the
  tokens are validated with `jose`, the routes are validated with `zod`, the
  OpenID Connect protocol is implemented by `openid-client`, the path
  templates by `path-to-regexp`, the signed cookies by `hono/cookie`, the
  structured log by `pino`, the caches by `lru-cache`, the file watcher by
  `chokidar` and the address ranges by `ipaddr.js`. The gateway does not
  implement a protocol or a format that a library already does.
* **User accounts, workspace ownership, service discovery, load balancing,
  certificate management, plugins, an operations dashboard and session
  administration.** Those live in other services or in the platform. Shuttle
  consumes the decisions they expose, it does not make them.

### Runtime

The gateway runs on **Bun** and is written against **Hono**: the listener is
`Bun.serve`, the websocket connections are the native ones of Bun, and the
requests are handled by Hono.

That is a decision with consequences, not a detail:

* **The websocket bridge is written by hand** (`src/gateway/websocket.ts`).
  The packages that tunnel a websocket upgrade (`http-proxy`,
  `http-proxy-3`) need a `node:http` server and its `upgrade` event, which
  `Bun.serve` does not have. The transport of the upstream connection is the
  `ws` package, because the identity headers have to be part of the
  handshake and the standard `WebSocket` API cannot set request headers. What
  the bridge adds is the policy of Shuttle: the buffer cap of a handshake in
  flight, the close codes, the error paths, the limit of the open
  connections and the negotiation of the subprotocol.
* **The upstream exchange is forwarded with `hono/proxy`**, and the budgets of
  its phases (`upload`, `connect`, `headers`, `body`) are Shuttle's own
  model, implemented on top of it. `got` and `undici` do not expose these
  four phases, so a package could only take them over by changing which
  budget fires when.
* **The peer address comes from the server.** `Bun.serve` reports it
  directly, and it is the basis of the trusted proxy evaluation.

Moving to a `node:http` server would make a package like `http-proxy`
possible, at the price of the native websocket handling and of the peer
address. The gateway stays on Bun.

## Quick start

```bash
bun install
bun run dev
```

`bun dev` starts everything that is needed to work on Shuttle locally in a
single process: the gateway, the identity provider, the access fixture and the
two sample upstreams. A change in the code restarts the process, a change in
the configuration is picked up by the gateway itself.

| What | Where |
| --- | --- |
| Gateway | <http://localhost:8080> |
| Identity provider | <http://localhost:5556> |
| Public sample route | <http://localhost:8080/> |
| Workspace sample route | <http://localhost:8080/ws/11111111-1111-4111-8111-111111111111/> |

Sign in with `alice@shuttle.test` / `alice-password`. `/auth/login` sends the
browser to the identity provider, the provider collects the credentials and the
gateway creates a server side session.

The development identity provider is the [`oidc-provider`](https://github.com/panva/node-oidc-provider)
package, configured with the fixture accounts of Shuttle. The OpenID Connect
protocol is therefore not implemented here, the provider is only configured.
It prints a few warnings of the library (an in memory adapter, an unsupported
runtime), they are expected in a development fixture.

The development identity provider is a **test fixture**: it holds accounts with
known passwords, so it is never part of a deployment. It is not copied into
the production image and it refuses to start when `NODE_ENV=production`. A
deployment uses a real identity provider (dex in the compose stack).

The development stack uses `config/routes.dev.json`, whose routes only match the
host `localhost` (requests to other hosts are rejected). It needs the ports
8080, 5556, 8090, 3000 and 3001; a port that is already taken makes the
runner stop with an error.

For the full stack in containers instead:

```bash
echo "127.0.0.1 dex.local" | sudo tee -a /etc/hosts
docker compose -f deploy/compose.yaml up --build
```

* gateway: <http://localhost:8080>
* identity provider: <http://dex.local:5556/dex> (dex, a real OpenID Connect
  provider)

## Commands

| Command | Description |
| --- | --- |
| `bun dev` | Starts the gateway and the local services (identity provider, access fixture, sample upstreams) in one process |
| `bun test` | Runs the test suite (unit, integration and end to end) |
| `bun run typecheck` | `tsc --noEmit` over `src`, `services`, `scripts` and `test` |
| `bun run lint` | `biome lint` over the same files |
| `bun start` | Runs the gateway exactly like the container does |
| `bun run load` | Measures the gateway: starts a gateway and an upstream in one process and reports the throughput and the latencies |

## Configuration

The route table lives in a single JSON file (`SHUTTLE_CONFIG`, default
`config/routes.json`; the development runner uses `config/routes.dev.json`). It
is validated as a whole: if anything is wrong the previous configuration stays
active and the failure is reported in the logs and in the metrics.

```json
{
  "version": 1,
  "defaults": {
    "auth": { "mode": "none" },
    "timeouts": { "connectMs": 5000, "headersMs": 30000, "bodyMs": 300000 },
    "maxBodyBytes": 10485760
  },
  "trustedProxies": ["10.0.0.0/8", "127.0.0.1/32"],
  "reservedPaths": [],
  "routes": [
    {
      "id": "workspace-api",
      "match": { "host": "api.shuttle.test", "path": "/ws/{workspaceId}/" },
      "upstream": "http://upstream-b:3000",
      "auth": { "mode": "any", "workspace": { "param": "workspaceId", "requireUuid": true } },
      "websocket": true
    }
  ]
}
```

### Matching and precedence

A request is matched on the `Host` header and the path. Path templates may
contain `{placeholders}`; the value of a placeholder is available to the
authentication and access checks.

A template is a list of segments separated by `/`. A segment is either a
literal or a single `{placeholder}`; a literal must not contain `{`, `}`, `:`
or `*`, because those characters belong to the template syntax of
`path-to-regexp`. A template that breaks these rules is a configuration
error, it is never silently reinterpreted.

A template matches a path when the path starts with it: the upstream
application mounted under `/ws/{id}/` receives every request below that
prefix, and the whole path is forwarded to it.

Routes are evaluated in a fixed order, the first match wins:

1. **Host specificity** — an exact host beats a wildcard host (`*.example.com`)
   which beats the catch-all host (`*`).
2. **Literal path prefix** — the longer the literal part of the template, the
   more specific the route (`/ws/public/` beats `/ws/{id}/`).
3. **Number of path segments** — `/ws/{id}/assets/` beats `/ws/{id}/`.
4. **Route id** — a stable, alphabetical tie breaker.

Two routes that would match exactly the same request (same host pattern, same
template shape) are **ambiguous** and the configuration is rejected. A route
that claims one of the paths the gateway serves itself (`/healthz`, `/readyz`,
`/metrics`, `/auth/login`, `/auth/callback`, `/auth/logout`) is rejected for
the same reason: the gateway answers those paths itself, so the route would
never receive a request. The trailing slash does not matter: a route with the
path `/metrics/` claims `/metrics` as well, and neither spelling is ever
routed to an upstream. The configuration is never applied partially: a bad
route keeps the whole previous configuration in place.

### Route options

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier, used in logs and metrics |
| `match.host` | `example.com`, `*.example.com` or `*` |
| `match.path` | Path template, may contain `{placeholders}`. A placeholder is a whole segment, a literal may not contain `{`, `}`, `:` or `*` |
| `upstream` | Base URL of the upstream application |
| `auth` | The policy of the route. A route without one uses `defaults.auth` |
| `auth.mode` | `none`, `session`, `jwt` or `any` |
| `auth.workspace` | `{ "param": "<placeholder>", "requireUuid": true }` |
| `timeouts` | Per route overrides of `connectMs`, `headersMs`, `bodyMs` |
| `websocket` | Whether the route accepts websocket upgrades |
| `redirects` | `rewrite` (the default) or `pass`. How the redirects of the upstream are handled, see [Redirects](#redirects) |
| `maxBodyBytes` | Request body limit, `0` disables it. It wins over `defaults.maxBodyBytes` and over `SHUTTLE_MAX_BODY_BYTES` |

Every object of the configuration is strict: an unknown key is a
configuration error. A setting that looks active but is not implemented is a
security hole, so Shuttle rejects the configuration instead of ignoring the
key. A typo in `maxBodyBytes` therefore fails the configuration instead of
silently removing the body limit.

### Top level options

| Field | Meaning |
| --- | --- |
| `version` | The version of the configuration format, currently `1` |
| `defaults` | The values a route inherits, see [Defaults](#defaults) |
| `routes` | The route table |
| `trustedProxies` | CIDR ranges or addresses of reverse proxies whose forwarding headers are trusted. `SHUTTLE_TRUSTED_PROXIES` adds to them |
| `reservedPaths` | Additional paths the gateway reserves for itself. They are never routed to an upstream. The paths the gateway always serves itself are reserved whether or not they are listed here |

### Defaults

`defaults` holds the values a route inherits when it does not set them.

| Field | Meaning |
| --- | --- |
| `auth` | The policy of the routes that do not declare one. A policy of a route **replaces** the default policy, it is not merged with it |
| `timeouts` | The budgets of the routes that do not declare them. A route overrides them field by field, so a route that only sets `connectMs` keeps the header and the body budget of the configuration |
| `maxBodyBytes` | The request body limit of the routes that do not set one. `SHUTTLE_MAX_BODY_BYTES` is the fallback |

A default policy with a `workspace` and the mode `none` is a configuration
error, exactly like a route that declares such a policy. The default policy is
checked on its own: a route that declares its own policy does not inherit it,
so a broken default would otherwise stay unnoticed.

## Authentication

The policy of a route decides who may use it. A route that does not declare a
policy uses the policy of `defaults.auth`, see [Defaults](#defaults).

* **Browser** — `/auth/login` starts the provider's authorization code flow
  with PKCE (`S256`). The provider collects the credentials, the gateway never
  sees them. The `state` and `nonce` are stored in a signed, `HttpOnly` cookie
  that is single use. On success the gateway creates a server side session; the
  browser only receives an opaque session id.
* **API clients** — `Authorization: Bearer <jwt>`. The token is validated
  against the provider: signature, issuer, audience and expiry are all
  checked, the signing keys are fetched from the provider's JWKS.
* **Roles** — read from the `roles` claim (`SHUTTLE_OIDC_ROLES_CLAIM`) and
  handed to the access service and to the upstream. The gateway does not
  compare them to anything.

Requests without valid credentials are answered with `401`. Browser requests
(`Accept: text/html`) are redirected to the login instead.

The login flow has two optional query parameters:

| Parameter | Meaning |
| --- | --- |
| `redirect` | The path the browser is sent to after the login. Only a relative path is accepted, so a crafted value can never turn the login into an open redirect. The default is `/`. |

`/auth/logout` revokes the session of the caller and clears the session
cookie. The session dies with its lifetime in any case, so a failure to reach
the session store does not keep the caller signed in.

### Request identifiers

Every request carries an `x-request-id` header. The gateway uses the one of
the client when it is a short, printable identifier, and generates one
otherwise. The identifier is written to the log line of the request, to the
response and to the upstream, so a request can be followed through the whole
chain.

### Modes

The mode of a route decides **which credentials the route accepts**. The
order in which the credentials are evaluated is fixed, so the credential that
authenticates a request never depends on the shape of the request.

| Mode | Session cookie | Bearer token | Browser without credentials |
| --- | --- | --- | --- |
| `none` | – | – | served without authentication |
| `session` | accepted | ignored | redirected to the login |
| `jwt` | ignored | accepted | `401` with `WWW-Authenticate` |
| `any` | accepted | accepted, preferred | redirected to the login |

An explicit `Authorization` header is preferred over the session cookie in
`any` mode, and a credential that is present but invalid is rejected instead
of falling back to another one: a broken token is not silently replaced by a
session.

### Sessions

The session of a browser caller is an opaque id in an `HttpOnly` cookie; the
payload never leaves the server. Where the payload lives is decided by a
single url:

| `SHUTTLE_SESSION_URL` | Backend |
| --- | --- |
| `memory://local` | The in-process store. Enough for a single node, but a restart signs everybody out. |
| `redis://…` | A Redis compatible server. |
| `rediss://…` | A Redis compatible server with transport encryption. |

The scheme selects the backend, so the same build runs against every managed
cache: Amazon ElastiCache, Google Cloud Memorystore, Azure Cache for Redis or
a redis in the cluster.

A deployment that runs more than one task **has** to use a shared store: a
load balancer cannot pin a caller to a task, so a session that only lives in
the memory of one task is unknown to the next one and the caller is signed
out at random.

When the store cannot be reached the gateway **denies** the request. It never
falls back to a local copy of the sessions: a session that only one replica
knows is a session that the load balancer may route away from.

## Workspace access control

Shuttle never decides access on its own. For every route that declares a
workspace the gateway calls the access service:

```
POST {SHUTTLE_ACCESS_URL}/v1/decisions
{ "subject": "...", "workspaceId": "...", "routeId": "...", "roles": [...] }
```

The service answers `{ "allow": true|false, "reason": "..." }`. If the service
is unreachable, times out or answers nonsense the request is **denied** — the
gateway fails closed. Decisions are cached for a few seconds
(`SHUTTLE_ACCESS_CACHE_TTL_MS`). The roles are part of the key of the cache,
so a decision that was made for a caller with a role is never served to a
caller without it. The cache lives in the memory of the process, or in the
server that the replicas share when `SHUTTLE_SHARED_STATE_URL` names one. A
cache that is not reachable is skipped, never trusted: the decision is asked
for again.

Workspace identifiers are treated as opaque UUIDs: anything that is not an
RFC 4122 UUID is rejected with `400` before the access service is consulted.

The roles of the caller are part of the request, so the access service can
decide on them. A denial whose reason is about a role is counted as
`missing_role` in the metrics, a denial for any other reason as
`access_denied`.

The reason of a denial is written to the log and to the metrics, but it is
**not** given to the caller: it describes the policy of the platform and it
is not the business of the client. The caller is told that the workspace is
not available to it.

## Proxying

* Methods, paths, query strings, status codes and cookies are preserved.
* Request bodies are streamed, never buffered into memory.
* Upstream redirects are **not** followed (`redirect: manual`).
* Responses are streamed, so server sent events work unchanged.
* Every phase of the upstream exchange has its own budget; a body that
  exceeds `maxBodyBytes` is rejected with `413`.
* Client disconnects abort the upstream request.

The status code of an answer tells what happened: `413` for a body that is too
large, `504` for a budget that ran out, `502` for an upstream that could not
be reached, and `499` for a request the client aborted before the upstream
answered.

### Redirects

An upstream application answers a redirect with a `Location` header, and that
header has to be adapted to the gateway:

* an absolute location names the internal host of the upstream
  (`Location: http://upstream-b:3000/login`) — the hostname of an internal
  service never reaches the browser
* a relative location leaves the prefix the application is mounted under
  (`Location: /login` for an application that lives under `/ws/{id}/`)

The gateway rewrites both by default. The location becomes relative, so the
client stays on the origin it already used, and it keeps the prefix of the
application — a location that already carries the prefix is left alone. A
redirect to another host is never touched, so an application that sends the
user to an external identity provider keeps working.

A route that wants the locations of its upstream unchanged sets
`"redirects": "pass"`.

### Timeouts

An exchange with an upstream has four phases, and every phase has a budget:

| Phase | Budget | The phase ends when |
| --- | --- | --- |
| Upload | `bodyMs` | The request body reached the upstream |
| Connect | `connectMs` | The upstream started answering |
| Headers | `headersMs` | The body of the response started |
| Body | `bodyMs` | The response body was streamed completely |

`fetch` does not expose the TCP handshake, so the connect budget covers
everything up to the response headers: the upstream has to start answering
within `connectMs`. A budget that runs out aborts the request and answers
with `504`.

The connect budget is the one that matters when an upstream is down: an
upstream that does not answer at all is given up on after `connectMs` instead
of holding the request until the header budget is over. It is also the one
to raise for an upstream that needs a long time to produce its response
headers.

The budgets of a route override the budgets of the configuration field by
field, see [Defaults](#defaults).

### Header policy

| Header group | Behaviour |
| --- | --- |
| Hop-by-hop headers | Always removed |
| `x-shuttle-*`, `x-forwarded-user`, `x-remote-user`, … | Always removed, so clients cannot spoof an identity |
| `x-forwarded-for`, `x-forwarded-proto`, `x-forwarded-host` | Only honoured when the peer is listed in `trustedProxies`, otherwise the gateway writes its own values |
| `x-forwarded-port`, `x-real-ip` | Always removed from the request, the gateway writes `x-real-ip` itself |
| `x-shuttle-user`, `x-shuttle-email`, `x-shuttle-roles`, `x-shuttle-workspace` | Written by the gateway after the caller was authenticated |
| `x-request-id` | Written by the gateway, taken over from the client when it is a valid identifier |

`x-forwarded-for` is the chain of the addresses the request passed through:
the gateway appends the address of its peer to the chain it received. The
client itself is the left-most entry of the chain, that is the address
`x-real-ip` carries.

The list of stripped headers and the names of the identity headers are part of
the security invariant of the gateway and are therefore **not** configurable.
The upstream must only be reachable from the gateway, because these headers
are trusted implicitly.

### The identity signature

The identity headers are only trustworthy when the request went through the
gateway. The gateway signs the identity it writes, so an upstream that wants
to be sure can verify the signature:

```
x-shuttle-signature: v2=<hex hmac sha256>
```

The signature covers the identity **and** the request it belongs to, so it
cannot be moved to another request or to another route:

```
["v2", <method>, <path>, <query>, <host>, <subject>, <workspaceId>, <email>, <roles, sorted>]
```

The payload is a json array: the escaping of json keeps every value in its
own field, so a value that contains a newline, a comma or a quote cannot be
moved from one field into another.

The query string and the host are part of the payload since `v2`. A `v1`
signature only bound the method and the path, so it could be replayed onto
another query string of the same path (`?admin=true` on a path that was
signed without it). An upstream that verified a `v1` signature has to
verify a `v2` signature now; the version is part of the value, so the two
cannot be confused.

The key is derived from `SHUTTLE_SESSION_SECRET`, so the secret that signs
the login state is not used for the signature itself. An upstream verifies
the signature with the same secret:

```ts
import { createHmac } from 'node:crypto'

const key = createHmac('sha256', secret).update('shuttle-identity-signature-v1').digest()
const payload = JSON.stringify([
  'v2',
  method,
  path,
  query,
  host.toLowerCase(),
  subject,
  workspaceId ?? '',
  email ?? '',
  [...roles].sort(),
])
const expected = createHmac('sha256', key).update(payload).digest('hex')
const valid = signature === `v2=${expected}`
```

`src/auth/identity.ts` is the reference implementation, it exports
`deriveIdentityKey`, `canonicalIdentityPayload` and `verifyIdentity`.

The signature is written next to the identity, it does not replace it: an
upstream that does not verify it keeps working. The header of the caller is
removed like every other identity header, so a client cannot forge it.

### Cross site requests

A caller that authenticates with a **session cookie** is a browser, and a
browser can be made to send a request to the gateway from another site. The
gateway refuses those requests:

* a request with `Sec-Fetch-Site: cross-site` that changes the state of an
  upstream (`POST`, `PUT`, `PATCH`, `DELETE`) is refused with `403`
* a request with an `Origin` that is not the origin of the gateway is refused
  when it changes the state of an upstream
* a **navigation** from another site (a link in an e-mail) is allowed, because
  refusing it would break every deep link into an application.
  `SHUTTLE_CSRF_STRICT=true` refuses it as well
* an origin that is listed in `SHUTTLE_ALLOWED_ORIGINS` is always allowed, so
  a platform whose parts live on different domains keeps working
* a request without `Sec-Fetch-Site` and without `Origin` comes from a client
  that is not a browser (a command line tool, a service) and is allowed

The guard does not only look at the credential that authenticated the
request: **every request that carries the session cookie is a request of a
browser**, also the ones of a route that has no policy of its own. The
cookie is scoped to the root of the gateway, so a browser sends it to every
path of it. A route with `auth.mode: none` is therefore guarded as well.

The origin of the gateway is computed from the **effective protocol**: the
one the trusted proxy reports in `X-Forwarded-Proto`, the configured
`SHUTTLE_EXTERNAL_PROTO` otherwise. Only `http` and `https` are accepted, a
header that names another protocol is ignored. The origins are normalized
before they are compared, so `https://example.com` and
`https://example.com:443` are the same origin.

A caller that authenticates with a **bearer token** is not affected: a token
is not sent by a browser, so there is nothing to steal.

The logout is guarded as well: a link on another site must not be able to
log a caller out. A `GET /auth/logout` with `Sec-Fetch-Site: cross-site` or
with an `Origin` of another site is refused with `403`.

The login flow is never guarded: the callback of the identity provider is a
navigation from another site by design. It is protected by the signed state
cookie and by the OIDC state instead.

An upstream that changes the state of something on a `GET` is still exposed
to a cross site request: the gateway cannot tell a navigation from a link
that is meant to change something. Such an endpoint belongs behind a `POST`.

### Limits

| Limit | Variable | Default | Effect when it is reached |
| --- | --- | --- | --- |
| Requests of a caller | `SHUTTLE_RATE_LIMIT_MAX` | `0` (off) | `429` with a `Retry-After` header |
| Login attempts of a caller | `SHUTTLE_LOGIN_RATE_LIMIT_MAX` | `30` | `429` with a `Retry-After` header |
| Open websocket connections | `SHUTTLE_WS_MAX_CONNECTIONS` | `1000` | `503`, the handshake is refused |
| Request body | `SHUTTLE_MAX_BODY_BYTES` | `10485760` | `413` |

The request and the login limiters count per address of the caller, in the
window of `SHUTTLE_RATE_LIMIT_WINDOW_MS` (60 seconds). The address is the
one the trusted proxies report, so a caller behind a load balancer is counted
once and not once per proxy.

The windows live in the memory of the process, so every replica of a
deployment counts on its own. A deployment with more than one replica points
`SHUTTLE_SHARED_STATE_URL` at a Redis compatible server: the windows are
then counted once for the whole deployment. See
[More than one replica](#more-than-one-replica).

The request limiter is **off by default**: a gateway in front of unknown
applications is regularly used by internal clients that make a lot of
requests from one address, and a limit that is too low refuses legitimate
traffic. A deployment should set it to the number of requests a single
caller may make. The limit of the logins is on by default, because there is
no legitimate reason for one address to start many logins.

The number of open websocket connections is bounded, so a caller cannot open
connections until the process runs out of memory. The limit is **per
replica**. A connection that is refused because of the limit is counted in
the metrics (`shuttle_websocket_refusals_total`).

### Websockets

Websocket routes are upgraded with `server.upgrade()` **after** the
authentication and the workspace check have succeeded — an unauthorised client
never reaches the upstream handshake. The bridge buffers messages while the
upstream handshake is in flight, with a hard cap
(`SHUTTLE_WS_MAX_BUFFERED_BYTES`, `SHUTTLE_WS_MAX_BUFFERED_MESSAGES`); when
the cap is reached the connection is closed with `1013`. Both sides are closed
when either side goes away.

The **upstream connection is opened before the client is answered**. The
gateway therefore knows the outcome of the upstream handshake and the
subprotocol the upstream selected, and it can

* refuse the handshake with `502` when the upstream does not accept it,
  instead of accepting a connection that dies right away
* confirm the subprotocol the upstream selected to the client
  (`Sec-WebSocket-Protocol`), so both sides speak the same protocol

The subprotocols the client offers are forwarded to the upstream, the ones
the upstream did not ask for are not. The compression is **not** negotiated
on the upstream leg: the gateway terminates the compression of the client
leg, and a leg that negotiates its compression on its own would send frames
the other side cannot read.

The number of open connections is bounded
(`SHUTTLE_WS_MAX_CONNECTIONS`), a handshake that is over the limit is
refused with `503`. The limit is **per replica**: a deployment with several
replicas allows every replica its own number of connections. The gateway
cannot know how many connections the other replicas hold, so a platform that
needs a global bound puts one in front of the fleet.

The memory of the process is bounded on both legs:

* the messages that are buffered while the upstream handshake is in flight
  are capped (`SHUTTLE_WS_MAX_BUFFERED_BYTES`,
  `SHUTTLE_WS_MAX_BUFFERED_MESSAGES`)
* the messages that are queued for a client that does not read are capped
  (`SHUTTLE_WS_BACKPRESSURE_LIMIT_BYTES`), and the connection is closed when
  the cap is reached
* a client that is slower than the upstream is closed after a few
  consecutive slow sends, instead of growing the queue of the process
* the size of a single message is capped (`SHUTTLE_WS_MAX_PAYLOAD_BYTES`)

The gateway **pings** the client and the upstream
(`SHUTTLE_WS_PING_INTERVAL_MS`). The ping keeps the connection alive
through the proxies in between, and it tells the gateway that the other side
is still there: a connection that does not answer the pings
(`SHUTTLE_WS_PONG_TIMEOUT_MS`) is closed, so the registry does not count the
connections of the clients that went away without a close frame.

The reason of a close frame is cut to the 123 bytes the protocol allows: a
reason that is longer is refused by the other side, and a refused close
frame leaves the connection hanging.

## Operations

| Endpoint | Description |
| --- | --- |
| `GET /healthz` | Liveness probe |
| `GET /readyz` | Readiness probe, includes the configuration and the session store |
| `GET /metrics` | The metrics of the gateway in the Prometheus text format |
| `GET /auth/login` | Starts the browser login flow |
| `GET /auth/callback` | The callback of the identity provider |
| `GET /auth/logout` | Revokes the session of the caller |

The metrics endpoint is only served when `SHUTTLE_METRICS_TOKEN` is set, the
scraper sends the token as `Authorization: Bearer <token>`. Without the token
the endpoint does not exist.

The exposition format comes from [`prom-client`](https://github.com/siimon/prom-client),
the gateway only declares what it measures.

| Metric | Meaning |
| --- | --- |
| `shuttle_requests_total{route,method,status}` | Requests that reached an upstream |
| `shuttle_request_errors_total{route}` | Requests that failed with a server error |
| `shuttle_auth_failures_total{route,reason}` | Callers that were rejected (`unauthenticated`, `missing_role`, `access_denied`) |
| `shuttle_websocket_connections_total{route}` | Accepted websocket upgrades |
| `shuttle_request_duration_seconds{route}` | Latency histogram of the proxied requests |
| `shuttle_bytes_in_total` / `shuttle_bytes_out_total` | Bytes transferred, counted while the bodies stream |
| `shuttle_active_requests` | Requests currently in flight |
| `shuttle_config_reloads_total{result}` | Configuration reloads by outcome |
| `shuttle_rate_limited_total` | Requests that the rate limiter refused |
| `shuttle_cross_site_refusals_total{route}` | Requests that came from another site |
| `shuttle_websocket_refusals_total{reason}` | Websocket handshakes that were refused (`connection_limit`, `upstream_unavailable`) |
| `shuttle_shared_state_errors_total` | The times the state the replicas share was not reachable |

A request is counted when its response body is completely streamed, not when
the headers arrived: the duration of a request is the time the caller
waited, and the number of bytes is the number of bytes that were really
transferred. A client that goes away in the middle of a response is counted
as well.

Everything lives in bounded, in-memory structures (at most 500 routes, a fixed
set of latency buckets) and is reset when the gateway restarts. Credentials and
cookies are never written to the logs or to the metrics.

The configuration file is watched for changes and reloaded automatically;
`SIGHUP` triggers a reload as well. A reload is atomic: the new configuration
is parsed, validated and checked for ambiguity before it replaces the running
one, and a broken configuration leaves the previous one in place. Logs are
structured JSON lines on stdout with credentials, cookies and token bearing
query parameters redacted.

`SIGTERM` and `SIGINT` stop the listener, let in-flight requests finish and
close the websocket connections before the process exits.

The websockets are closed first: a websocket never finishes on its own, so a
shutdown that waited for the open connections would wait forever. The
requests that are still in flight get `SHUTTLE_SHUTDOWN_TIMEOUT_MS` to
finish, after which the remaining connections are closed.

### Environment

| Variable | Default | Description |
| --- | --- | --- |
| `SHUTTLE_CONFIG` | `./config/routes.json` | Route configuration |
| `SHUTTLE_GATEWAY_PORT` / `SHUTTLE_GATEWAY_HOST` | `8080` / `0.0.0.0` | Public listener |
| `SHUTTLE_OIDC_ISSUER` | `http://localhost:5556/dex`, **required** in production | OIDC issuer |
| `SHUTTLE_OIDC_CLIENT_ID` / `SHUTTLE_OIDC_CLIENT_SECRET` | `shuttle` / –, the id is **required** in production | OIDC client |
| `SHUTTLE_OIDC_REDIRECT_URI` | `http://localhost:8080/auth/callback`, **required** in production | Redirect URI |
| `SHUTTLE_OIDC_SCOPES` | `openid profile email groups` | Requested scopes |
| `SHUTTLE_OIDC_AUDIENCE` | the client id | Expected audience of a token |
| `SHUTTLE_OIDC_ROLES_CLAIM` | `roles` | Claim that carries the roles |
| `SHUTTLE_OIDC_ALLOW_INSECURE` | `true` outside production | Allows an identity provider that is not served over https. A deployment terminates TLS in front of the provider and leaves it off |
| `SHUTTLE_ACCESS_URL` | `http://localhost:8090`, **required** in production | Access service |
| `SHUTTLE_ACCESS_TOKEN` | –, **required** in production | Service token for the access service |
| `SHUTTLE_ACCESS_TIMEOUT_MS` | `3000` | Access service timeout |
| `SHUTTLE_ACCESS_CACHE_TTL_MS` | `5000` | Decision cache lifetime |
| `SHUTTLE_METRICS_TOKEN` | – | Bearer token that guards `/metrics` |
| `SHUTTLE_SESSION_SECRET` | random outside production, **required** in production | Key that signs the login state cookie. It has to be the same on every replica: a key that is generated per process is only valid on the replica that generated it, so a deployment with more than one replica would fail the login at random. The gateway refuses to start in production without it |
| `SHUTTLE_SESSION_URL` | `memory://local` | Session store, the scheme selects the backend |
| `SHUTTLE_SESSION_KEY_PREFIX` | `shuttle` | Prefix of every key, so environments can share a server |
| `SHUTTLE_SESSION_TTL_MS` | `28800000` | Lifetime of a session |
| `SHUTTLE_SESSION_TOUCH_INTERVAL_MS` | `60000` | Minimum delay between two expiry refreshes |
| `SHUTTLE_SESSION_MAX_SESSIONS` | `5000` | Maximum number of sessions of the in-process store |
| `SHUTTLE_SESSION_TLS_CA` / `SHUTTLE_SESSION_TLS_CA_BASE64` | – | Certificate authority of a private endpoint |
| `SHUTTLE_SHARED_STATE_URL` | the session url when it is a Redis server | Url of the server that holds the state the replicas share: the rate limits and the cached access decisions |
| `SHUTTLE_SHARED_STATE_KEY_PREFIX` | `shuttle` | Prefix of every key of the shared state |
| `SHUTTLE_SHARED_STATE_TLS_CA` / `SHUTTLE_SHARED_STATE_TLS_CA_BASE64` | the certificate authority of the session store | Certificate authority of a private endpoint |
| `SHUTTLE_COOKIE_SECURE` | `true` in production | `Secure` attribute of the cookies |
| `SHUTTLE_EXTERNAL_PROTO` | `http` | Protocol the clients use towards the gateway |
| `SHUTTLE_TRUSTED_PROXIES` | – | Extra CIDR ranges whose forwarding headers are trusted |
| `SHUTTLE_MAX_BODY_BYTES` | `10485760` | Request body limit, used when the configuration does not set `defaults.maxBodyBytes` |
| `SHUTTLE_WS_MAX_BUFFERED_BYTES` | `262144` | Bytes buffered while a websocket handshake is in flight |
| `SHUTTLE_WS_MAX_BUFFERED_MESSAGES` | `100` | Messages buffered while a websocket handshake is in flight |
| `SHUTTLE_WS_MAX_PAYLOAD_BYTES` | `16777216` | Maximum size of a single websocket message |
| `SHUTTLE_WS_BACKPRESSURE_LIMIT_BYTES` | `1048576` | Bytes that may be queued for a client that does not read, the connection is closed when the limit is reached |
| `SHUTTLE_WS_PING_INTERVAL_MS` | `30000` | How often the open websockets are pinged, `0` disables the keepalive |
| `SHUTTLE_WS_PONG_TIMEOUT_MS` | `90000` | How long a websocket may stay silent before it is closed |
| `SHUTTLE_WS_IDLE_TIMEOUT_SECONDS` | `120` | Idle timeout of the websockets of the runtime |
| `SHUTTLE_WS_MAX_CONNECTIONS` | `1000` | Number of websocket connections that may be open at the same time, `0` means no limit |
| `SHUTTLE_WS_HANDSHAKE_TIMEOUT_MS` | `10000` | How long the gateway waits for the handshake of the upstream |
| `SHUTTLE_RATE_LIMIT_MAX` | `0` (off) | Number of requests a single caller may make in a window, `0` disables the limiter |
| `SHUTTLE_RATE_LIMIT_WINDOW_MS` | `60000` | Length of the window of the request limiter |
| `SHUTTLE_LOGIN_RATE_LIMIT_MAX` | `30` | Number of login attempts a single caller may make in a window |
| `SHUTTLE_LOGIN_RATE_LIMIT_WINDOW_MS` | `60000` | Length of the window of the login limiter |
| `SHUTTLE_ALLOWED_ORIGINS` | – | Origins that may make requests to the gateway, in addition to the origin of the gateway itself |
| `SHUTTLE_CSRF_STRICT` | `false` | Refuse the navigations from another site as well |
| `SHUTTLE_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent` |
| `SHUTTLE_SHUTDOWN_TIMEOUT_MS` | `15000` | How long a shutdown waits for the requests that are still in flight |

TLS is terminated by the hosting platform; the gateway only speaks plain HTTP.

A value of the environment that cannot be understood **stops the gateway**,
the same way a route table with an unknown key is rejected: a typo in
`SHUTTLE_MAX_BODY_BYTES` would otherwise remove the limit of the request
bodies without a word. The level of the log is the only exception, it falls
back to `info`.

### What a production deployment has to set

A deployment in production (`NODE_ENV=production`) has to name its own
identity provider and its own access service, and it has to authenticate
against both. The gateway **refuses to start** when one of them is missing,
because the defaults of the development environment point at the fixtures of
the repository:

| Variable | Why it is required |
| --- | --- |
| `SHUTTLE_SESSION_SECRET` | The key that signs the login state has to be the same on every replica |
| `SHUTTLE_OIDC_ISSUER` | The gateway has to know against whom the callers authenticate |
| `SHUTTLE_OIDC_CLIENT_ID` | The client the gateway registers with the provider |
| `SHUTTLE_OIDC_REDIRECT_URI` | The url the provider sends the browser back to |
| `SHUTTLE_OIDC_CLIENT_SECRET` | The secret of the client. `SHUTTLE_OIDC_ALLOW_PUBLIC_CLIENT=true` when the provider accepts a public client |
| `SHUTTLE_ACCESS_URL` | The service that decides who may use a workspace |
| `SHUTTLE_ACCESS_TOKEN` | The gateway authenticates against the access service. `SHUTTLE_ACCESS_ALLOW_ANONYMOUS=true` when the service authenticates the gateway by other means |

A deployment that terminates TLS in front of the gateway also has to set
`SHUTTLE_EXTERNAL_PROTO=https` or to trust the proxy that reports the
protocol: the origin of a request is compared with the origin of the
gateway, and a wrong protocol refuses the legitimate requests of the site
itself.

## Deployment

* `Dockerfile` — two stages: `runtime` holds the gateway and nothing else,
  `fixtures` holds the development identity provider, the access fixture and
  the sample upstreams. Only the `runtime` stage is ever deployed.
* `deploy/compose.yaml` — the full local stack with dex as the identity
  provider and an optional redis for the sessions. The fixture services are
  built from the `fixtures` stage, the gateway from the `runtime` stage.
* `deploy/dex/config.yaml` — the configuration of the identity provider.

The development fixtures are never deployed:

* they are not part of the production image, the `runtime` stage copies
  `src/` only
* they refuse to start when `NODE_ENV=production`, so a fixture that is built
  by accident still refuses to serve traffic

The identity provider of a deployment is a real one (dex in the compose
stack), the access service is a real one as well — the fixtures only stand in
for them while developing and while testing.

The session store is a separate service: point `SHUTTLE_SESSION_URL` at a
Redis compatible server and every replica shares the sessions. Everything else
the platform provides (the load balancer, the certificates, the identity
provider, the access service) is consumed, not provisioned.

A deployment has to set `SHUTTLE_SESSION_SECRET`: the key that signs the
state cookie of the login flow has to be the same on every replica, so it
belongs in the secret store of the platform. The gateway refuses to start in
production without it, because a key that is generated per process is only
valid on the replica that generated it.

### More than one replica

| State | Where it lives | With several replicas |
| --- | --- | --- |
| Sessions | the session store | shared, when it is a Redis server |
| Rate limits | the shared state | shared, when `SHUTTLE_SHARED_STATE_URL` names a Redis server |
| Cached access decisions | the shared state | shared, when `SHUTTLE_SHARED_STATE_URL` names a Redis server |
| Websocket connections | the process | **per replica**, every replica allows its own number |
| The configuration | the file | the same file, the reload is atomic on every replica |
| The metrics | the process | per replica, the scraper collects them from every one |

`SHUTTLE_SHARED_STATE_URL` defaults to the session url when that one is a
Redis server: a deployment that shares its sessions shares its limits as
well. A deployment with a single replica keeps the state in the memory of
the process and needs nothing.

The shared state **fails open**: when the server cannot be reached, the rate
limiter lets the request through and the cache of the decisions is skipped,
so a hiccup of the cache does not turn into an outage of the gateway. The
failure is counted in `shuttle_shared_state_errors_total` and written to the
log, because it means the limits of the deployment are not enforced while it
lasts. The **decisions themselves** are never taken from the cache when the
access service is not reachable: a request without a valid decision is
denied.

## Repository layout

```
src/
  auth/         OIDC client, sessions, access service client, identity signature, crypto helpers
  auth/session/ the session port, the in-process and the Redis backend
  config/       configuration schema, matcher, atomic configuration store
  gateway/      request dispatch, header policy, HTTP proxy, websocket bridge, rate limiter, cross site guard
  log/          structured logging with redaction
  metrics/      the prom-client registry and the measurements
  redis/        the connection to a Redis compatible server
  runtime/      runtime wiring and environment handling
  util/         small helpers (IP/CIDR matching with `ipaddr.js`)
services/       development fixtures: identity provider, access service, sample upstreams
scripts/        the development runner and the load test
test/           unit, integration and end to end tests
deploy/         compose stack and the dex configuration
biome.json      the configuration of the linter
```

The directory `services/` holds fixtures, not services of a deployment: it is
not part of the production image and it refuses to run with
`NODE_ENV=production`.

## Tests

```bash
bun test
```

The suite needs the development identity provider and the access fixture, so
it must not run with `NODE_ENV=production` (`bun test` sets `NODE_ENV=test`
when it is not set).

The suite covers the configuration schema and route conflicts, atomic
reloads, the browser login flow, bearer token validation, the selection of
the credential per mode, cross workspace denials, header spoofing, the
signature of the identity, the cross site guard, the limits of the gateway,
request limits, uploads, server sent events, websocket upgrades,
subprotocol negotiation and disconnects, upstream failures and the metrics
endpoint.

Two parts of the suite need something that is not there by default:

* the session contract of the Redis store and the contract of the shared
  state run against a real server when `SHUTTLE_TEST_REDIS_URL` is set
  (`redis://127.0.0.1:6379/0`). Without it the parts that need a server are
  skipped and the rest of the contract is covered
* the store is also exercised against a RESP server that speaks the real
  protocol over a real socket, so the wire format is covered even without a
  Redis server

The continuous integration runs the whole suite with a Redis service, builds
the production image, checks that the image starts with a session secret and
refuses to start without one, and runs the load test.
