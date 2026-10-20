# The decisions of the release

IMPLEMENTATION.md §10 lists the questions that have to be answered before the
release. A recommendation is not a decision: each row below records what was
decided, why, and where the evidence is.

A decision that changes the contract of the specification is marked as such:
the specification itself is the normative document, so a change of the public
contract is recorded here and in the changelog of the release, never only in
the code.

| # | Question | Decision | Status | Evidence |
| --- | --- | --- | --- | --- |
| 1 | Supported runtime versions | The gateway is built and tested on **Bun 1.4.3**. The specification states Bun ≥ 1.2; that lower bound is *not* claimed as supported until the CI matrix has run on it. | open (CI matrix runs `1.2.0` and `1.4.3`) | `bun --version` in the build log |
| 2 | Upload and response commitment boundaries | The proxying domain owns the state machine; the Bun adapter reports the observable events (the upload stream ends, the final headers arrive, the first body byte arrives). The commitment of the answer happens when the final headers are handed to the caller. | open (commit 02) | network tests of commit 02 |
| 3 | Upstream websocket non-101 / refusal mapping | A refusal of the upstream handshake is answered to the caller with the status of the refusal when it is a valid http status, `502 bad_gateway` otherwise; the body of the upstream is not forwarded. | open (commit 11) | contract tests of commit 11 |
| 4 | Connection establishment during the upload | The upload is bounded by the idle `bodyMs` budget only. A finite ceiling for the establishment of the connection is *not* added: it would cut a slow but progressing upload. | open (commit 09) | network tests of commit 09 |
| 5 | Caller `Authorization` and the standard `Forwarded` header | The `Authorization` header of the caller is forwarded to the upstream unchanged. The standard `Forwarded` header is removed like every other forwarding header of the client: the gateway writes its own `x-forwarded-*` chain. | open (commit 04) | forwarding tests of commit 04 |
| 6 | Header representation | The roles are written as a comma separated list; an empty list is an empty header value. A role that contains a comma or a control character is dropped from the header (it stays in the request to the access service). The identity values are truncated to 512 characters. | open (commit 04) | forwarding tests of commit 04 |
| 7 | Token purpose | The provider of the repository does not publish a token type claim; the gateway validates the signature, the issuer, the audience, the expiry and the subject, and nothing else. A deployment whose provider publishes a token type claim adds the check in the authentication domain. | open (commit 07) | authentication tests of commit 07 |
| 8 | Login transaction consumption | The state cookie is deleted when the callback is processed, the state is compared, the PKCE verifier and the nonce bind the exchange. A *concurrent* consumption of the same cookie by two replicas is not atomic: the provider refuses the replay of the authorization code, so the second attempt fails at the provider. | open (commit 07) | authentication tests of commit 07 |
| 9 | Decision cache outage | Only an explicit decision of the access service is cached. A transport failure is never cached. When the cache is unavailable the gateway asks the access service again and denies when that fails. | open (commit 08) | workspace tests of commit 08 |
| 10 | Live websocket authorization | The websocket is authorized at the handshake only. The live connection is not revalidated when a session expires, when the access is revoked or when the configuration is reloaded. | open (commit 11) | websocket tests of commit 11 |
| 11 | Provisioning of the verifier of the signature | The upstream is given the *derived* key (the output of the HMAC), not the master secret. The key is versioned by the version of the signature (`v3`). | open (commit 04) | forwarding tests of commit 04 |
| 12 | External host and response caching | The gateway does not cache a response and does not add cache headers. An upstream that wants a response to be private has to say so itself. | open (commit 10) | contract tests of commit 10 |
| 13 | Replica topology and Redis TLS | The replicas share the sessions, the rate limits and the decision cache through Redis. The TLS of the endpoint is verified with the certificate authority of the deployment (`SHUTTLE_SESSION_TLS_CA_BASE64`). The caps of a process (sessions, connections, buffers) are per process. | open (commit 13) | deployment documentation of commit 13 |
| 14 | Drain policy | During the drain the readiness probe answers `503`, the listener stops accepting new work and the websocket connections are closed with the code 1001. The requests that are in flight get `SHUTTLE_SHUTDOWN_TIMEOUT_MS`. | open (commit 12) | shutdown tests of commit 12 |
