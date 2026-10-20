# Build status

The delivery follows [BUILD_PLAN.md](BUILD_PLAN.md). This file records what
was built, the checks that were actually executed, the decisions that were
taken and what is still missing.

**Runtime under test:** Bun 1.4.3 (`bun --version`), TypeScript 5.9.3, Hono
4.13.13. The contract states **Bun ≥ 1.4.3**: the 1.2 line of the runtime
does not expose the boundaries the specification relies on (see
[DECISIONS.md](DECISIONS.md), decision 1, and
[docs/transport-capabilities.md](docs/transport-capabilities.md)).

## The checkpoints

| # | Commit | State | Evidence |
| --- | --- | --- | --- |
| 01 | `chore: establish domain boundaries and build checks` | done | `bun test test/architecture` (21 tests), `bun run typecheck`, `bun run lint`, `bun run format:check` |
| 02 | `test: prove Bun transport capabilities` | done | `bun test test/network` (14 tests of the transport, 9 of the exchange, 5 of the websockets) with Bun 1.4.3; the transport suite was also run with Bun 1.2.0 and 1.2.23 to measure the boundaries |
| 03 | `feat: compile and publish route configuration` | done | `bun test src/domains/routing` (19), `src/domains/configuration` (20), `src/runtime/env.test.ts` (12) |
| 04 | `feat: enforce forwarding trust and identity policy` | done | `bun test src/domains/forwarding` (54 tests: 13 of the signature, 15 of the headers, 8 of the target, 18 of the origins), the vector of the specification is pinned |
| 05 | `feat: add bounded request limiters` | done | `bun test src/domains/rate-limiting` (14 tests), `bun test test/integration/redis-limiter.test.ts` (3 tests against a real Redis) |
| 06 | `feat: implement session storage and lifetime rules` | done | `bun test src/domains/authentication/session.test.ts` (16), `bun test test/integration/redis-sessions.test.ts` (4 tests against a real Redis) |
| 07 | `feat: implement OIDC and credential selection` | done | `bun test src/domains/authentication/principal.test.ts` (20), `login-state.test.ts` (9), `bun test test/integration/oidc.test.ts` (11) |
| 08 | `feat: authorize workspace access through decision service` | done | `bun test src/domains/workspace-access` (18 tests), `bun test test/integration/access.test.ts` (4 tests) |
| 09 | `feat: stream HTTP exchanges with bounded cleanup` | done | `bun test src/domains/proxying` (14 tests), `bun test test/network/exchange.test.ts` (9 tests) |
| 10 | `feat: compose gateway endpoints and request pipeline` | done | `bun test test/contract/endpoints.test.ts` (14), `test/contract/pipeline.test.ts` (13) |
| 11 | `feat: bridge WebSockets with bounded resources` | done | `bun test src/domains/websockets` (12), `bun test test/network/websocket.test.ts` (5) |
| 12 | `feat: complete reload drain and lifecycle observation` | done | `bun test test/contract/lifecycle.test.ts` (5) |
| 13 | `test: qualify the production deployment` | done | `bun test test/browser` (3 tests, Chromium), `bun test test/load` (2 tests), `bun run load` (the measurements of [docs/capacity.md](docs/capacity.md)) |
| 14 | `fix: close the gaps of the coverage of the release` | done | the redaction of the logs and the bounded labels of the metrics (`src/observability/observability.test.ts`), the bridge of the websockets (`src/domains/websockets/bridge.test.ts`), the table of the failures of an exchange (`test/contract/failures.test.ts`), the refusals of the endpoints and the store that is not reachable (`test/contract/endpoints-failures.test.ts`), the cache of the decisions and the sessions of two replicas (`test/integration/redis-runtime.test.ts`) |

## The checks of the project

| Check | Command | Here | In the CI |
| --- | --- | --- | --- |
| Types | `bun run typecheck` | run | run |
| Lint | `bun run lint` | run | run |
| Format | `bun run format:check` | run | run |
| Import boundaries | `bun test test/architecture` | run | run |
| Unit tests | `bun test src` | run | run |
| Contract tests | `bun test test/contract` | run | run |
| Network tests | `bun test test/network` | run | run |
| Redis tests | `bun test test/integration` | run (Redis 7.0.15, `scripts/redis-dev.sh`) | run (a Redis service) |
| Browser tests | `bun test test/browser` | run (Chromium 156) | run (`playwright install chromium`) |
| Soak | `bun test test/load` | run | run |
| Load | `bun run load` | run | run |
| The image | `docker build` | **not run** (no docker) | run |

The last full run of the suite: **358 tests passed, 0 failed, 0 skipped**
with Bun 1.4.3 and a Redis 7.0.15 (`SHUTTLE_TEST_REDIS_URL=redis://127.0.0.1:6399/0`),
over 33 files. The coverage of the lines of the source is **92.1 %** and the
coverage of the functions is **93.4 %** (`bun test --coverage`). Without a
server the suite skips the ten tests of the shared state and passes the
other 348.
The suite is 28 files: 14 unit test files of the domains and of the runtime,
the architecture check, 3 network test files, 5 integration test files, 3
contract test files, the browser test and the soak.

## The environment of this build

| Resource | Available | Consequence |
| --- | --- | --- |
| Bun 1.4.3 | yes | the tests of the runtime ran |
| Bun 1.2.0 and 1.2.23 | yes (downloaded) | the boundaries of the 1.2 line were measured, the runtime was pinned |
| Redis server | yes (7.0.15, extracted from the packages of the distribution with `scripts/redis-dev.sh`) | the tests of the atomicity of the shared state ran, including the race of four **processes** against the same window |
| Chromium (Playwright) | yes | the browser tests ran locally |
| Docker | no | the image is built by the CI workflow, not here |
| An ingress | no | the ingress settings are documented, the capacity behind an ingress was not measured |
| Several replicas | no (one process) | the shared state was exercised with four processes against the same window (`test/integration/redis-replicas.test.ts`); the capacity of a deployment with several replicas was not measured |

## The decisions

The decisions of IMPLEMENTATION.md §10 are recorded in
[DECISIONS.md](DECISIONS.md). Two of them change the contract of the
specification and are recorded in the specification itself (SPECS.md §15,
decisions 21 and 22): the version of the runtime and the removal of the
standard `forwarded` header.

## What is not claimed

- The image was not built here: there is no docker in the build
  environment. The CI workflow builds it and starts it with the
  configuration of a deployment.
- The capacity behind an ingress, with TLS and with several replicas was
  not measured: the measurements of [docs/capacity.md](docs/capacity.md) are
  the ones of the gateway alone, in one process.
- The minimum version of the runtime (1.2.x) does not expose the
  boundaries the specification needs: the contract states 1.4.3 and the CI
  matrix runs it.
