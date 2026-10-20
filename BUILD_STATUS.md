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
| 01 | `chore: establish domain boundaries and build checks` | done | `bun test test/architecture`, `bun x biome lint`, `bun x biome format .`, `bun run typecheck` |
| 02 | `test: prove Bun transport capabilities` | done | `bun test test/network` (14 tests), `bun run typecheck`, `bun x biome lint`; the same network suite was executed with Bun 1.2.0 and 1.2.23 to measure the boundaries |
| 03 | `feat: compile and publish route configuration` | pending | — |
| 04 | `feat: enforce forwarding trust and identity policy` | pending | — |
| 05 | `feat: add bounded request limiters` | pending | — |
| 06 | `feat: implement session storage and lifetime rules` | pending | — |
| 07 | `feat: implement OIDC and credential selection` | pending | — |
| 08 | `feat: authorize workspace access through decision service` | pending | — |
| 09 | `feat: stream HTTP exchanges with bounded cleanup` | pending | — |
| 10 | `feat: compose gateway endpoints and request pipeline` | pending | — |
| 11 | `feat: bridge WebSockets with bounded resources` | pending | — |
| 12 | `feat: complete reload drain and lifecycle observation` | pending | — |
| 13 | `test: qualify the production deployment` | pending | — |

## The checks of the project

| Check | Command | Where it runs |
| --- | --- | --- |
| Types | `bun run typecheck` | local, CI |
| Lint | `bun run lint` | local, CI |
| Format | `bun run format:check` | local, CI |
| Import boundaries | `bun test test/architecture` | local, CI |
| Unit tests | `bun test src` | local, CI |
| Contract tests | `bun test test/contract` | local, CI |
| Network tests | `bun test test/network` | local, CI |
| Redis tests | `bun test test/integration` | CI only (needs `SHUTTLE_TEST_REDIS_URL`) |
| Browser tests | `bun test test/browser` | local, CI (needs the Chromium of Playwright) |
| Load and soak | `bun test test/load` | manual, `bun run load` |

## The environment of this build

| Resource | Available | Consequence |
| --- | --- | --- |
| Bun 1.4.3 | yes | the tests of the runtime ran |
| Redis server | no | the atomicity tests of the Redis adapters are written but only run in the CI job with a Redis service |
| Chromium (Playwright) | yes | the browser tests ran locally |
| Docker | no | the image is built by the CI workflow, not here |
| A load balancer / ingress | no | the ingress settings are documented, the capacity behind an ingress was not measured |

## The decisions

The decisions of IMPLEMENTATION.md §10 are recorded in
[DECISIONS.md](DECISIONS.md). A decision that blocks a commit is resolved
before the commit that depends on it.
