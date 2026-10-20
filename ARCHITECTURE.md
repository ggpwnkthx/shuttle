# The architecture of Shuttle

Shuttle is a modular monolith: one deployable, eight domains, explicit
boundaries. The specification ([SPECS.md](SPECS.md) §14) is normative for the
behavior and for the ownership; this document describes how the code is laid
out and which import is allowed where. The rules are checked by
`scripts/architecture.ts`, which runs in the test suite and in the CI
workflow.

## The layers

| Path | Owns |
| --- | --- |
| `src/main.ts` | The entry point of the process. It starts the runtime and nothing else. |
| `src/app/` | The Hono application: thin handlers, the middleware and the order of the pipeline. |
| `src/domains/<domain>/` | The policy, the use cases, the ports and the unit tests of one domain. |
| `src/domains/<domain>/adapters/` | The concrete implementations of the ports of the domain. The composition root is their only consumer. |
| `src/platform/bun/` | The listener, the peer address, the outbound HTTP transport and the socket primitives. |
| `src/platform/redis/` | The construction, the TLS settings and the disposal of the shared Redis clients. |
| `src/runtime/` | The environment, the composition root, the file watcher, the signals and the drain. |
| `src/observability/` | The logging, the metrics and the observation handles. It knows nothing else. |
| `services/` | The deterministic fixtures of the identity provider, of the access service and of the upstreams. |
| `test/` | The checks that are not unit tests of a domain. |

## The import graph

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

The rules that the checker enforces:

1. A domain is imported through its public entry point (`index.ts`). The
   internals of a domain belong to it.
2. The matrix above. A domain that is not in a row may not be used at all.
3. The core code of a domain (everything outside `adapters/`) imports no
   framework, no Bun api, no application, no platform, no runtime and no
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

## The lifecycle of the pieces

| Lifetime | Owner |
| --- | --- |
| The process | `src/runtime/composition.ts` (the construction) and `src/runtime/lifecycle.ts` (the disposal) |
| A configuration generation | The configuration domain: an immutable snapshot, published atomically |
| A request | The application: it captures one generation and hands it to the domains |
| An HTTP exchange | The proxying domain with the Bun transport |
| A websocket pair | The websockets domain with the Bun socket primitives |

A single owner finalizes an exchange or a connection exactly once. The
completion of a middleware is not the completion of an exchange.
