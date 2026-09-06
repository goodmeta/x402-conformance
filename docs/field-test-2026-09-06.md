# Field test, 2026-09-06 — the first run against facilitators we do not operate

Until this run, every target the suite had ever seen was either a mock written
alongside it or the one deployment it was extracted from. Both agree with the
assumptions in the probe, so neither could catch a wrong assumption.

Targets came from `docs/dev-tools/facilitators.md` on `x402-foundation/x402`
`main` — the spec repo's own list of production facilitators. Of those, three
answered `GET /supported` with an x402 kinds document at their listed domain:
PayAI, Mogami and the NEAR facilitator at `x402.mikedotexe.com`. The `x402.org`
reference facilitator and `x402.stablecoin.xyz` were run alongside as controls.
Six returned 404 at `<domain>/supported`, so their API base is not the domain in
the table and was not guessed. Six link to a docs page and were not probed.

**Three of five verdicts were wrong, and every cause was in this suite.**

| target | v0.1.0 said | true |
|---|---|---|
| `x402.org/facilitator` | CONFORMANT | ✅ |
| `x402.stablecoin.xyz` | CONFORMANT | ✅ |
| `facilitator.payai.network` | **NOT CONFORMANT** | ❌ it conforms |
| `facilitator.mogami.tech` | **NOT CONFORMANT** | ❌ v1-only service |
| `x402.mikedotexe.com` | **NOT CONFORMANT** | ❌ NEAR-only, and behind an API key |

## The false accusation, and how it was isolated

PayAI validates its input against the schema and says exactly what is wrong with
a request. That turned it into the best possible witness against our own probe.
Each row below changes one thing; the signature is 65 zero bytes throughout, so
nothing could ever authorize.

| probe | answer |
|---|---|
| v0.1.0's payload | `400 invalid_payload` — *"resource: expected object, received string; accepted.amount: undefined; accepted.payTo: undefined; accepted.maxTimeoutSeconds: undefined; accepted.asset: undefined"* |
| + `accepted` completed | `400 invalid_payload` — *"resource: expected object, received string"* |
| + `resource` as a ResourceInfo object | `400 invalid_payload` — *"unrecognized EVM payment payload: expected an EIP-3009 authorization or a Permit2 permit2Authorization"* |
| + `nonce` as bytes32 | **`200`** — `{"isValid":false,"invalidReason":"invalid_exact_evm_missing_eip712_domain","payer":"0x0000000000000000000000000000000000000001"}` |

A control run with the schema-shaped payload but the suite's deliberately fake
asset still returns `200`, so the asset was never the cause — the shape was.

## The five defects, all ours

1. **`paymentPayload.accepted` was a two-field stub.** §5.1.2 marks `amount`,
   `asset`, `payTo` and `maxTimeoutSeconds` Required; all four were missing.
2. **`paymentPayload.resource` was a string.** §5.2 types it as a `ResourceInfo`
   object.
3. **`paymentRequirements` carried four fields that do not exist in v2** —
   `maxAmountRequired` (the v1 name for `amount`), `resource`, `description`,
   `mimeType`. ⚠️ **Schema cleanup, not an observed cause.** No facilitator was
   seen to reject the request for carrying them, and no test covers it. It is in
   the list because the schema does not have those fields, not because it changed
   a verdict.
4. **`authorization.nonce` was a decimal timestamp.** EIP-3009 types it `bytes32`.
5. **Scope was never checked.** A v1-only service, a credential-walled one, and a
   non-EVM one were all graded against v2 EVM rules. Worse than the false
   failures: a facilitator advertising only `near:mainnet` was issued a
   **CONFORMANT** verdict on the strength of an EVM payload it could never have
   honored.

Defects 1–4 share one consequence. A lenient facilitator parses a malformed probe
anyway and passes; a facilitator that validates its input correctly rejects it and
is marked broken. **The suite rewarded leniency and punished correctness** — the
exact inversion of its purpose.

## What changed

- The probe is built to the §5.1.2 / §5.2 / `ResourceInfo` field tables.
- The POST envelope carries `x402Version: 2`, as §7.1's request shows.
- `pickNetwork` returns EVM networks only; anything else is out of scope.
- Three scope gates return `conformant: null` with a reason: no v2 kind
  advertised, no EVM network advertised, `/verify` answered 401 or 403.
- A scope gate never masks a violation already found. If `/supported` broke a
  Required rule, the verdict stays NOT CONFORMANT.
- `npm test` gained four cases asserting honest targets are not failed. All four
  were confirmed to fail against v0.1.0 before the fix.
- Two sabotages were added after the first cut of the v1 gate swallowed them: a
  `/supported` that returns 500, and one that returns 200 with no `kinds` array.
  Both were confirmed NOT CAUGHT before the gate was narrowed, which is what
  proved the gate had made two core checks unreachable.

After the fix, all five live verdicts are correct: PayAI joins the two controls
at CONFORMANT, Mogami and NEAR report CANNOT ASSESS with their reasons.

## Not established here

- Whether the six facilitators whose `/supported` 404'd, or the six never probed,
  conform. Unknown, not assumed.
- Defect 3 above. No target was observed to reject the request over it.
- Mogami's v1 conformance. There is no v1 suite and v1 is out of scope.
- NEAR conformance. Assessing it needs a NEAR payload builder, which does not
  exist yet.
