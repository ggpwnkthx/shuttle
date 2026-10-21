# The architecture of Shuttle

Shuttle is a modular monolith: one deployable, eight domains, explicit
boundaries. [spec.md](spec.md) §14 is normative for the behavior and for
the ownership. This document describes how the code is laid out and which
import is allowed where.

The rules are checked by `scripts/architecture.ts`, which runs in the test
suite and in the CI workflow, so a violation fails the build instead of
being noticed in a review.

The names of the environment live in `src/runtime/env.ts` and nowhere else.
`scripts/environment.ts` checks that the example and the manual of the
deployment describe them: a variable that is not described is a variable
nobody sets, and a variable that is described and does not exist is a
setting that looks active but is not. It runs in the test suite and in the
CI workflow as well.

## The layers

| Path | Owns |
| --- | --- |
| `src/main.ts` | The entry point of the process. It starts the runtime and nothing else. |
| `src/app/` | The Hono application: thin handlers, the middleware, the order of the pipeline, and the mapping of the failures to the answers of the protocol. |
| `src/domains/<domain>/` | The policy, the use cases, the ports and the unit tests of one domain. |
| `src/domains/<domain>/adapters/` | The concrete implementations of the ports of the domain. The composition root is their only consumer. |
| `src/platform/bun/` | The listener, the peer address, the outbound HTTP transport and the socket primitives. |
| `src/platform/redis/` | The construction, the TLS settings and the disposal of the shared Redis clients. |
| `src/platform/postgres/` | The construction, the pool, the TLS settings, the schema and the disposal of the shared Postgres clients. |
| `src/runtime/` | The environment, the composition root, the file watcher, the signals, the drain and the log of the policy that is running. |
| `src/observability/` | The logging, the metrics and the observation handles. It knows nothing else. |
| `services/` | The deterministic fixtures of the identity provider, of the access service and of the upstreams, and the reference implementation of the access service. The fixtures are not part of a deployment; the reference implementation is. |
| `test/` | The checks that are not the unit tests of a domain. |

## The domains

| Domain | May use |
| --- | --- |
| `routing` | — |
| `authentication` | — |
| `rate-limiting` | — |
| `configuration` | `routing`, `authentication` |
| `workspace-access` | `authentication`, `routing` |
| `forwarding` | `authentication` |
| `proxying` | `forwarding` |
| `websockets` | `forwarding` |

```
                    ┌──────────────┐
                    │     app      │  Hono, the pipeline, the endpoints
                    └──────┬───────┘
                           │ uses the public entry points
      ┌────────────┬───────┼────────┬──────────────┬─────────────┐
      ▼            ▼       ▼        ▼              ▼             ▼
 routing   configuration  authentication  workspace-access  forwarding  rate-limiting
      ▲            │       ▲        ▲                      ▲            │
      │            │       │        └──────────────────────┘            │
      │            │       │                                           │
      └────────────┘       │                        proxying   websockets
                            │                            ▲           ▲
                            │                            └───────────┘
```

A domain that is not in a row may not be used at all.

## The rules the checker enforces

1. A domain is imported through its public entry point (`index.ts`). The
   internals of a domain belong to it.
2. The matrix above. A domain that is not in a row may not be used at all.
3. The core code of a domain (everything outside `adapters/`) imports no
   framework, no Bun API, no application, no platform, no runtime and no
   concrete adapter. It receives its dependencies through injected ports.
4. The public entry point of a domain holds no adapter: the adapters are
   assembled by the composition root.
5. The application uses the public entry points of the domains and the
   observation interfaces, never a concrete adapter.
6. The platform implements the ports of the domains, it makes no policy
   decision and it imports neither the application nor the runtime.
7. The observation layer imports nothing of the project.
8. The runtime is the composition root: it may assemble the application, the
   domains, the adapters, the platform and the observation layer.
9. There are no catch-all directories (`utils`, `services`, `repositories`,
   `common`, …) and no import cycle, type-only imports included.
10. The framework of the application (Hono) is only used by the application
    and the API of the runtime (the listener, the sockets, the client of the
    shared state) is only used by the platform.

## The lifecycle of the pieces

| Lifetime | Owner |
| --- | --- |
| The process | `src/runtime/composition.ts` (the construction) and `src/runtime/lifecycle.ts` (the disposal) |
| A configuration generation | The configuration domain: an immutable snapshot, published atomically |
| A request | The application: it captures one generation and hands it to the domains |
| An HTTP exchange | The proxying domain with the Bun transport |
| A WebSocket pair | The WebSockets domain with the Bun socket primitives |

A single owner finalizes an exchange or a connection exactly once. The
completion of a middleware is not the completion of an exchange.

## How a request flows through the code

```
Bun.serve (platform/bun/listener.ts)
  └─ app.fetch (app/app.ts)
       └─ middleware: the request id, the cookies
            ├─ the endpoints of the gateway (app/endpoints.ts)
            └─ the dispatcher (app/dispatcher.ts)
                 ├─ routing: matchRoute
                 ├─ rate-limiting: the four scopes
                 ├─ authentication: selectCredential, authenticate
                 ├─ forwarding: checkCrossSite, buildUpstreamHeaders
                 ├─ workspace-access: decide
                 ├─ proxying: execute  →  platform/bun/http-transport.ts
                 └─ websockets: handle   →  platform/bun/upstream-websocket.ts
```

The dispatcher is the only place where the domains are combined. Each of
them is called through its public entry point, and each of them decides
only for itself.

## The map of the source

Every rule of the gateway lives in exactly one domain, and the domain owns
the tests of that rule next to it. This map says where a change lands.

### `src/app/` — the application

The application is thin on purpose. It holds the order of the pipeline, it
maps the failures of the domains to the answers of the protocol, and it
writes the headers and the cookies of the answers.

| File | Owns |
| --- | --- |
| `app.ts` | The Hono application, the middleware of the request id, the endpoints of the gateway. |
| `dispatcher.ts` | The order of the pipeline (§2.3 of the spec). The only place where the domains are combined. |
| `limits.ts` | The budgets of a request: the three independent budgets of §9 are counted at the same time, so the shared state is asked once instead of three times. |
| `endpoints.ts` | The handlers of `/healthz`, `/readyz`, `/metrics`, `/auth/login`, `/auth/callback` and `/auth/logout`. |
| `revalidation.ts` | The revalidation of an open WebSocket: the route, the session and the access are checked again. |
| `dependencies.ts` | The interfaces the application is built with. It names the domains, never their adapters. |
| `state.ts` | The state of a request: the request id, the generation, the forwarding context, the route. |
| `errors.ts` | The body of a refusal of the gateway. |
| `cookies.ts` | The reading of the cookies of a request. |

### `src/domains/` — the domains

| Domain | The files | What each one owns |
| --- | --- | --- |
| `routing` | `schema.ts` | The shape of the id, of the host pattern and of the path template. The validation of a placeholder against the path. |
| | `match.ts` | The compilation of a route, the precedence, the matching, the decoding of the parameters, the detection of the ambiguities. |
| `configuration` | `schema.ts` | The schema of the file, the strict validation, the effective defaults. |
| | `store.ts` | The generation of the configuration: the immutable snapshot, the atomic publication, the last good state, the status of the reload. |
| | `describe.ts` | The description of the policy that is running, and the settings that are permissive. |
| `authentication` | `policy.ts` | The schema of the modes and of the workspace policy. |
| | `principal.ts` | The selection of the credential, per mode. The rule that an invalid credential is rejected and never replaced. |
| | `oidc.ts` | The relying party: the discovery, the PKCE, the exchange of the code, the validation of the bearer tokens. |
| | `login-state.ts` | The signed state of a login in flight, and the sanitization of the redirect target. |
| | `session.ts` | The record of a session, its bounds, the rules of the lifetime. |
| | `cookies.ts` | The names and the attributes of the cookies of the gateway. |
| | `service.ts` | The use cases: authenticate, begin a login, complete a login, log out. |
| | `adapters/memory-sessions.ts` | The store of the sessions in the memory of the process. |
| | `adapters/redis-sessions.ts` | The store of the sessions in Redis. The refresh of the expiry is one script of the server. |
| | `adapters/postgres-sessions.ts` | The store of the sessions in Postgres. The refresh of the expiry is one function of the server. |
| `workspace-access` | `workspace.ts` | The validation of the identifier of a workspace. |
| | `decision.ts` | The shape of a decision and the mapping of its reason to the metric. |
| | `client.ts` | The client of the access service: the request, the answer, the cache, the fail-closed behavior. |
| | `adapters/memory-cache.ts` | The cache of the decisions in the memory of the process. |
| | `adapters/redis-cache.ts` | The cache of the decisions in Redis. |
| | `adapters/postgres-cache.ts` | The cache of the decisions in Postgres. |
| `forwarding` | `network.ts` | The parsing of the CIDR ranges and the evaluation of the trusted proxies. |
| | `context.ts` | The peer address, the client address, the chain, the protocol and **the effective host**. |
| | `origins.ts` | The cross-site policy: the normalization of the origins, the guard of the requests, the guard of the navigations, the origin of a handshake. |
| | `headers.ts` | The header policy in both directions, and the cookies of the gateway. |
| | `cookies.ts` | The parsing of a `Cookie` header, the rendering of a `Set-Cookie` header, and the name of a cookie. |
| | `identity.ts` | The sanitization of the identity, the canonical payload, the signature and its verification. |
| | `trace.ts` | The trace context of a request: the parsing of the `traceparent` of the caller, the span of the gateway and the header it writes. |
| | `target.ts` | The url of the upstream, and the rewriting of the `Location` of an answer. |
| `rate-limiting` | `policy.ts` | The scopes and the keys of the windows. |
| | `window.ts` | The sliding window: the size of a bucket, the index of a bucket and the evaluation of the window. |
| | `limiter.ts` | The limiter of the memory: the bounded table, the shared window of the overflow. |
| | `adapters/redis-limiter.ts` | The limiter of Redis: the counter and the expiry are one script. It fails open. |
| | `adapters/postgres-limiter.ts` | The limiter of Postgres: the counter and the expiry are one function. It fails open. |
| `proxying` | `transport.ts` | The ports of the transport: the request and the answer. |
| | `exchange.ts` | The state machine of an exchange: the phases, the budgets, the limits, the cancellation, the finalization. |
| `websockets` | `ports.ts` | The ports of the sockets, of the handshake and of the revalidation. |
| | `context.ts` | The context of an upgrade, assembled by the application. |
| | `reservation.ts` | The slots of the connections, the handshakes in flight included. |
| | `bridge.ts` | The relay between the two legs, the buffers, the backpressure, the keepalive, the revalidation. |
| | `service.ts` | The order of the handshake: the origin, the slot, the upstream, the caller, the bridge. |

### `src/platform/` — the adapters of the runtime

The platform implements the ports of the domains. It makes no policy
decision.

| File | Owns |
| --- | --- |
| `bun/listener.ts` | `Bun.serve`, the peer address of a request, the stop of the listener. |
| `bun/http-transport.ts` | The outbound HTTP: no redirect is followed, no body is buffered, the answer is not decompressed. |
| `bun/access-transport.ts` | The call to the access service. |
| `bun/client-upgrade.ts` | The upgrade of the caller, with the headers of the gateway. |
| `bun/upstream-websocket.ts` | The handshake with the upstream, and the socket of the upstream. |
| `bun/runtime.ts` | The version of the runtime of the process. The api of the runtime belongs to the platform, so the version is read here and the policy that decides whether it is good enough lives in the runtime. |
| `redis/client.ts` | The construction of the client, the shapes of the server (a server, a cluster, a sentinel), the TLS, the background connection and the disposal. |
| `redis/commands.ts` | The commands of the shared state. |
| `postgres/client.ts` | The construction of the client, the pool of the connections, the TLS, the background connection and the disposal. |
| `postgres/schema.ts` | The tables and the functions of the shared state, and the bootstrap of the schema. |
| `postgres/commands.ts` | The commands of the shared state. |

### `src/runtime/` — the composition root

| File | Owns |
| --- | --- |
| `env.ts` | The schema of the environment, the defaults, the validation of a production deployment. The only place that reads `process.env`. |
| `shared-state.ts` | The backends the shared state may live in, and the choice of the backend by the scheme of the url. |
| `composition.ts` | The construction of everything: the clients, the stores, the domains, the application, the listener. |
| `lifecycle.ts` | The watcher of the configuration, the signals, the drain, the deadline. |
| `policy-log.ts` | The log of the policy that is running: the routes and the settings that are permissive. |
| `version.ts` | The version of the build. |

### `src/observability/` — the observation

| File | Owns |
| --- | --- |
| `logging.ts` | The redaction of the credentials, before anything is written. |
| `metrics.ts` | The metrics, and the bounded labels. |

### `services/` — the fixtures and the reference implementation

`services/oidc-provider.ts`, `services/access-fixture.ts`,
`services/upstream.ts` and `services/raw-http.ts` are the deterministic
stand-ins for the identity provider, the access service and the upstreams.
They refuse to run in a production environment, and they are not part of the
image of the gateway.

`services/access-service.ts` is the **reference implementation** of the
access service: it applies a policy file and it answers the protocol of
§6.1 of the specification. It is not a fixture — it runs in a production
environment and a deployment may use it — and it is the implementation the
conformance suite of `test/integration/access-conformance.ts` runs against,
so the protocol and its reference do not drift apart.

## Where a change lands

| The change | The file |
| --- | --- |
| A new authentication mode | `authentication/policy.ts`, then `authentication/principal.ts`. |
| A new header of the identity | `forwarding/identity.ts`, then `forwarding/headers.ts`. |
| A new limit scope | `rate-limiting/policy.ts`, then `app/dispatcher.ts`. |
| A new metric | `observability/metrics.ts`. |
| A new environment variable | `runtime/env.ts`, then `.env.example`. |
| A new phase of the exchange | `proxying/exchange.ts`, then the spec §11.2. |
| A new field of the route table | `configuration/schema.ts`, then `routing/schema.ts` if it is a match. |

## The rules of the work

- One rule, one domain, one test file next to it.
- A rule that has no test is a rule that is not implemented.
- A decision is recorded before the behavior it decides is implemented, not
  after.
- The import boundaries are checked by the build, not by a review.
- The measurements of the runtime are taken before the code depends on them.

## The verification

| Kind | Where | What it proves |
| --- | --- | --- |
| Unit | `src/domains/*/*.test.ts` | The policy of one domain, without the network. |
| Contract | `test/contract/` | The pipeline of the gateway, over a socket, with the real fixtures around it. |
| Network | `test/network/` | The capabilities of the runtime that the proxying depends on. |
| Integration | `test/integration/` | The shared state against a real Redis and a real Postgres, the contract the two backends share, and a deployment with several replicas. |
| Browser | `test/browser/` | The cookies and the origins in a real browser. |
| Load | `test/load/` | The soak and the resources that settle after the traffic. |
| Architecture | `test/architecture/` | The import boundaries. |

A rule that has no test is a rule that is not implemented. The domain owns
the test of its rule; the contract suite proves that the domains are wired
together the way the spec says.
