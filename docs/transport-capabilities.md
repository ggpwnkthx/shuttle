# The transport capabilities of the runtime

The gateway is written against the runtime, not against a library that hides
it. The rules of the specification (SPECS.md §10, §11 and §4) are only as
good as the observations that back them, so every boundary the gateway relies
on is proved by a test of `test/network/` that runs against a real socket.

**The runtime of this release is Bun 1.4.3.** The observations below were
made with it; the ones of the older releases are recorded as well, because
they explain why the version is pinned (see [DECISIONS.md](../DECISIONS.md),
decision 1).

## What was proved

| Capability | How it was proved | What the runtime does |
| --- | --- | --- |
| Streaming upload | `test/network/transport.test.ts`: the upstream polls the chunks it received while the client is still producing the body | The bytes reach the upstream while the upload runs. An upload that was buffered would not be visible before the end of the body. |
| The end of the upload | the same test, the `/upload` endpoint of the fixture | The end of the request stream is the end of the upload. It is the observable event the transport reports; the acceptance by the peer is a different observation and is not claimed. |
| The phases of the answer | the raw server sends the head at once and the body a second later | The promise of the transport resolves when the **final headers** arrived (1 ms), the first body byte arrives later (1002 ms). The two budgets of the specification (`responseMs`, `firstByteMs`) are therefore observable apart. |
| An interim answer | the raw server sends `103 Early Hints` and then the final answer | The runtime reports the final answer only. The gateway forwards the final response and never an interim one. |
| A protocol switch | the raw server answers `101 Switching Protocols` | The runtime refuses it: the transport fails and the exchange answers `502`. The websocket upgrade owns the protocol switch. |
| An early answer | the fixture answers `/early` without reading the body | The answer of the upstream is delivered while the upload runs, and the runtime drops the rest of the upload (the producer of the body is cancelled). The answer of the upstream wins, as the specification requires. |
| The cancellation of a caller | the signal of the exchange is aborted | The request of the upstream is cancelled and the promise of the transport is rejected. |
| A redirect | the fixture answers `302` with a location | The redirect is not followed: the answer of the upstream reaches the caller as it is. |
| A compressed answer | the fixture answers with `content-encoding: gzip` | The runtime decompresses the answers **by default**. The transport therefore asks for `decompress: false`, so the bytes of the upstream and its `content-encoding` reach the caller as they are. |
| The handshake with an upstream websocket | the fixture answers `403` instead of a handshake | The refusal is reported with its status, its headers and its body. It is not a network failure and the caller deserves to see it. |
| The subprotocol of the upstream | the fixture selects the first offered subprotocol | The subprotocol the upstream selected is reported and is mirrored to the caller. |
| The upgrade of the caller | a raw client reads the `101` answer | The handshake answer carries the headers of the gateway (the request id, the refreshed cookie). Neither a browser nor the websocket client of the runtime exposes them, so a test has to read the socket. |

## The versions that were measured

| Version | Result |
| --- | --- |
| **1.4.3** | Every boundary above is observable. This is the version of the release. |
| 1.2.23 | The early answer is delivered, but the runtime does not cancel the producer of the body; the `unexpected-response` event of the websocket client of the `ws` library is not implemented, so the refusal of an upstream is not observable; the upgrade of the caller with headers of the gateway is refused. |
| 1.2.0 | The early answer is not delivered at all: the exchange waits for the end of the upload. |

The specification states `Bun ≥ 1.2`. The measurements above show that the
boundaries the specification relies on are not observable on the 1.2 line, so
the version of the runtime is part of the contract and is pinned. The change
is recorded in SPECS.md (§15, decision 21) and in DECISIONS.md.
