# The identity of a request, for an upstream

The gateway writes the identity of the caller into the headers of the
request it forwards, and it signs it. An upstream that wants to be sure
that the request went through the gateway verifies the signature.

The specification is [spec.md](spec.md) §7.1 and §7.4; this document is
the guide for the upstream, with the code.

## The headers

| Header | Value |
| --- | --- |
| `x-shuttle-user` | The subject of the caller. |
| `x-shuttle-email` | The e-mail address of the caller, when it is known. |
| `x-shuttle-roles` | The roles of the caller, separated by commas. |
| `x-shuttle-workspace` | The workspace of the caller, when the route has one. |
| `x-shuttle-signature` | The signature of the identity: `v5=<the compact JWS>`. |

The gateway writes these headers and nothing else does: a client that
sends them has them removed. An upstream that trusts the headers without
verifying the signature trusts the network.

## The key

The gateway holds the **private** key of the deployment and the upstreams
are given the **public** key:

```bash
bun run identity:key              # a new pair
bun run identity:key --public     # the public key of the key in the environment
```

The public key is a PEM of an elliptic curve key on the curve P-256, and
the signature is an `ES256` one. An upstream that verifies an identity
with the public key cannot mint one.

The upstream never receives the **private** key of the deployment and
never receives the **secret of the sessions**: the private key signs, the
public key verifies, and the secret stays in the gateway. The only key an
upstream holds besides the public one is the derived key of the legacy
format, and that one is symmetric: an upstream that holds it can mint an
identity as well. It is deprecated and it is refused by default (§ *The
versions*).

## The verification

The upstream:

1. reads the identity headers and the signature;
2. rebuilds the payload of the signature from the request and from the
   identity headers;
3. rebuilds the compact serialization of the JWS around its own payload —
   the payload of the signature is **detached**, so the middle segment is
   empty and the upstream puts its own payload there;
4. verifies it with the public key.

The verification is **bound to one combination** of version, algorithm and
key. There is no fallback from one algorithm to another, and a signature
of one combination is never verified with the key of another one:

| The version of the value | The algorithm of the protected header | The key |
| --- | --- | --- |
| `v5` | `ES256` | The public key of the deployment, a key of the curve P-256. |
| `v4` | `HS256` | The derived key of the deployment, and only when the upstream is configured with it. |

An upstream therefore refuses:

- a version it does not know (`v3`, `v6`, an empty version, …);
- a value whose protected header names another algorithm than the one the
  version requires;
- a protected header whose type is not `shuttle-identity`;
- a public key that is not a public key of the curve P-256;
- a compact serialization that is malformed, and a payload that is not
  detached (the middle segment has to be empty).

The values that are signed are the values of the headers, as they are: the
upstream does not normalize them before it rebuilds the payload, apart
from the normalization the wire format requires — the method is
upper-cased, the host is lower-cased and the roles are sorted.

The payload is a canonical JSON object, and the fields are written in this
order:

```json
{"v":"v5","method":"GET","path":"/v1/assets","query":"?x=1","host":"api.example.com","subject":"user-1","workspaceId":"…","email":"…","roles":["admin","dev"]}
```

| Field | Value |
| --- | --- |
| `v` | The version of the format: `v5`. |
| `method` | The method, upper-cased. |
| `path` | The path **as the upstream received it**: the path the gateway forwarded, after the rewrite of the route (§11.1.1). |
| `query` | The query string as the upstream received it, with its leading `?`. The empty string when there is none. |
| `host` | The effective host, as the gateway wrote it in `x-forwarded-host`, lower-cased. |
| `subject` | The subject of the caller. |
| `workspaceId` | The workspace, or the empty string. |
| `email` | The e-mail of the caller, or the empty string. |
| `roles` | The roles of the caller, sorted ascending. |

The roles are the ones of the header `x-shuttle-roles`: a role that would
make the comma separated list ambiguous is dropped by the gateway, and the
signature covers exactly the roles of the header.

The verification is one call of a standard library. The reference
implementation is in
[examples/upstream-identity/verify.ts](../examples/upstream-identity/verify.ts),
and it is **standalone**: it imports nothing of the gateway — only the
`jose` package.

## The code

### TypeScript

```ts
import { importSPKI } from 'jose'
import { verifyIdentity } from './verify'

const key = await importSPKI(publicKeyPem, 'ES256')

const result = await verifyIdentity({
  request: { method: request.method, path: request.path, query: request.query, host: request.headers['x-forwarded-host'] ?? '' },
  headers: {
    'x-shuttle-user': request.headers['x-shuttle-user'] ?? '',
    'x-shuttle-email': request.headers['x-shuttle-email'],
    'x-shuttle-roles': request.headers['x-shuttle-roles'],
    'x-shuttle-workspace': request.headers['x-shuttle-workspace'],
    'x-shuttle-signature': request.headers['x-shuttle-signature'],
  },
  publicKey: key,
})

if (!result.ok) {
  // The request did not go through the gateway, or it was tampered with.
  return new Response('forbidden', { status: 403 })
}
const identity = result.identity
```

The reference verifier refuses a signature it does not understand, and it
says why: the reason is a text, and an upstream that logs it learns what
it refused. An upstream that also accepts the legacy format configures
the derived key explicitly:

```ts
const result = await verifyIdentity({
  request,
  headers,
  publicKey: key,
  // The deprecated symmetric format: the key is derived from the secret
  // of the sessions, HMAC-SHA256(secret, "shuttle-identity-signature-v1").
  legacyKey: derivedKey,
})
```

Without `legacyKey`, a `v4` signature is refused: the public key of the
deployment cannot verify it, and the verifier never falls back from
`ES256` to `HS256`.

### Go

```go
import (
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"strings"

	"github.com/go-jose/go-jose/v4"
)

type payload struct {
	V          string   `json:"v"`
	Method     string   `json:"method"`
	Path       string   `json:"path"`
	Query      string   `json:"query"`
	Host       string   `json:"host"`
	Subject    string   `json:"subject"`
	WorkspaceID string  `json:"workspaceId"`
	Email      string   `json:"email"`
	Roles      []string `json:"roles"`
}
```

The payload is rebuilt the same way: the fields in the same order, the
roles sorted, and the values as they are in the headers. The signature is
verified with the public key:

```go
object, err := jose.ParseSigned(signature[3:]) // the part after "v5="
if err != nil { return err }
body, err := object.Verify(key)
```

The `jose` package expects the payload of the JWS, so the detached payload
is put back before the verification: `object.DetachedPayload(canonical)`.

The Go implementation has to bind the combination as well: it reads the
version of the value, refuses a version it does not know, and checks that
the protected header names `ES256` and the type `shuttle-identity` before
it verifies:

```go
if !strings.HasPrefix(signature, "v5=") { return errUnknownVersion }
if len(object.Signatures) != 1 { return errMalformed }
header := object.Signatures[0].Header
if header.Algorithm != "ES256" || header.Type != "shuttle-identity" { return errMalformed }
```

## What to do when the verification fails

The request did not go through the gateway, or it was tampered with. The
upstream refuses it: `403` is the answer that says "the identity of this
request is not one I can trust".

The gateway never sends a request without a signature to an upstream that
asked for one: the signature is written whenever the request carries an
identity. A request that was not authenticated is forwarded without an
identity and without a signature — the route says whether it needs one.

## The versions

| Version | The format | The key | The state |
| --- | --- | --- | --- |
| `v5` | A JWS with a detached payload, signed with `ES256`. | The private key of the deployment; the upstreams hold the public one. | The format of a production deployment. |
| `v4` | The same format, signed with `HS256`. | The key that is derived from the secret of the sessions. The upstreams hold it, so an upstream that verifies an identity can mint one as well. | **Deprecated**: the reference verifier accepts it only when the upstream configures the derived key explicitly. |

An upstream that verifies `v4` has to be changed before the gateway signs
`v5`: it reads the version of the value and verifies with the public key
of the deployment. The reference verifier does the reading of the version
for it: `v5` is verified with the public key and `ES256`, and `v4` is
verified with the derived key and `HS256`. The public key of the
deployment never verifies a `v4` signature, and there is no fallback from
one algorithm to the other.

The legacy support of the gateway itself lives in
[src/domains/forwarding/identity.ts](../src/domains/forwarding/identity.ts):
`symmetricIdentityKey` and `deriveIdentityKey` build the derived key and
sign the `v4` format. It is there for the deployments that have not
migrated yet, and it is removed with the format.

## Compatibility with a revision of Shuttle

The contract of the identity is the one of §7.4 of the specification, and
an upstream that implements it is compatible with every revision of the
gateway that keeps that section. A project that wants **evidence** pins a
revision and checks its implementation against it.

The stable links follow `main` and they are the ones to read:

- The specification: [docs/spec.md §7.4](spec.md#74-the-identity-signature)
- The guide: [docs/upstream-identity.md](upstream-identity.md)
- The reference verifier: [examples/upstream-identity/verify.ts](../examples/upstream-identity/verify.ts)

The evidence of a tested baseline names the **full commit sha**, so the
link resolves to the same bytes that were tested:

```
https://github.com/ggpwnkthx/shuttle/blob/<commit-sha>/docs/spec.md#74-the-identity-signature
https://github.com/ggpwnkthx/shuttle/blob/<commit-sha>/examples/upstream-identity/verify.ts
https://github.com/ggpwnkthx/shuttle/blob/<commit-sha>/examples/upstream-identity/verify.test.ts
```

The tests of the verifier are the contract test of the format: they sign
with the real signer of the gateway and they verify with the reference
implementation, so a change of the payload, of the version or of the
algorithm fails the build of the gateway. A consumer runs the same check
against its own implementation, with the fixtures of its own project.

The protocol of the access service — the other contract between the
gateway and the services around it — has a conformance suite of its own:
[test/integration/access-conformance.ts](../test/integration/access-conformance.ts).
It is parameterized by the expectations of the implementation, so an
access service (Hub, for instance) runs it against itself with a profile
that names the subjects and the workspaces it knows. It is guidance for
the integration and it is not a runtime dependency of Shuttle.
