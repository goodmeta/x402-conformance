# x402-conformance

Point it at any x402 facilitator and find out whether it conforms to the v2 spec.

```bash
npx @goodmeta/x402-conformance https://your-facilitator.example
```

Exits `0` when every spec-required check passes, `1` when one fails, and `2` when
nothing was graded — the target is unreachable, or it is outside what this suite
can judge. A red suite, a broken invocation and an unanswerable question stay
distinguishable in CI.

## What it does

An x402 facilitator is the service that answers two questions for a merchant:
*is this payment authorization valid*, and *did the money move*. Merchants pick a
facilitator and then trust its answers. There has been no way to check one from
the outside.

This runs the facilitator's own `/supported`, `/verify` and `/settle` endpoints
over real HTTP and grades the answers against the published specification, citing
the clause behind each check so a failure is arguable against the spec text
rather than against our reading of it.

## Safe against a live deployment

Every probe carries a signature of 65 zero bytes — structurally well-formed, so
it reaches the verifier, and cryptographically hopeless, so it can never
authorize anything. A conforming facilitator declines all of them and no value
moves. Nothing is written, nothing is queued, no funds are touched.

The network probed is taken from the target's **own** `/supported` rather than
hardcoded, so the suite works against a facilitator on any chain, and it prefers
a testnet when one is advertised.

## What it will not judge

A suite that fails an honest service is as useless as one that passes a broken
one. Three kinds of target are reported as **CANNOT ASSESS** — `conformant` is
`null`, exit code `2` — rather than graded:

- **It declares v1 kinds only.** A facilitator speaking x402 v1 never claimed v2,
  so v2's requirements are not its to meet. This gate is narrow on purpose: a
  `/supported` that errors, or answers 200 with no `kinds`, is broken rather than
  out of scope and is graded as such.
- **It advertises v2 only on non-EVM networks.** The only payment this suite can
  build is an `exact` EIP-3009 authorization. Pointing it at a Solana, NEAR,
  Stellar or XRPL facilitator would grade an answer to a question that
  facilitator was never asked.
- **`/verify` answers 401 or 403.** Behind a credential wall there is nothing to
  read.

A violation found before the scope gate still stands: if `/supported` itself
breaks a Required rule, the verdict is NOT CONFORMANT, not "cannot assess."

## Core vs optional

**Core** is what the spec marks Required. Failing one means the facilitator does
not conform, and the run exits non-zero.

**Optional** is what the spec marks Optional, or describes by example rather than
requirement. Reported, never fatal. A facilitator that differs here is not
broken — it is making a different, permitted choice.

That split is the point of the tool, and it is easy to get wrong. This suite was
extracted from one embedded in a single facilitator's own repository, which
asserted `scheme === "exact"` on every kind, required `extra.assetTransferMethod`
on every kind, and checked for three named networks. §7.3.1 requires none of
those: `scheme` is Required with `"exact"` given as an example, `extra` is
Optional, and the spec says nothing about which networks anyone must carry. Those
checks described one deployment rather than the protocol, and would have failed a
conforming facilitator built by anyone else.

## Example

```
CORE — spec-required
  PASS  §7.3.1  `signers` keys are CAIP-2 patterns (Required)  — eip155:*, solana:*
  PASS  §7.1    a payment it cannot authorize is declined
  PASS  §5.4    a rejection carries a reason  — unsupported_asset
  PASS  §7.2    a payment it cannot authorize is not settled
  PASS  §7      a malformed request is a 4xx, not a 5xx  — status 400

OPTIONAL — informational
  yes   §7.3.1  kinds carry `extra` scheme configuration (Optional)  — 14 of 14
  no    §6.1    declares a non-default `paymentFlow` (Optional)  — none declared
  yes   §6      scheme coverage  — exact

core     20/20
optional 5/6

CONFORMANT — every spec-required check passed.
A pass is a claim about this deployment at this moment, not a standing property.
```

`--json` emits the whole report as machine-readable JSON and nothing else, so a
result can be stored, diffed, or published.

## Does it actually catch anything?

`npm test` boots mock facilitators over real sockets — one conforming, then
several sabotaged in exactly one way each — and asserts the suite reaches the
right verdict on every one. A conformance suite that only ever passes is worse
than no suite, because it certifies whatever it is pointed at.

Currently caught: accepting an unsigned payment at `/verify`; settling one;
omitting `signers`; advertising a bare chain id instead of CAIP-2; rejecting
without a reason; returning 500 on a malformed body; returning 500 on
`/supported`; answering `/supported` with no `kinds` array; falling through to a
default chain when asked about a network never advertised.

The other half of the same test asserts that honest targets are **not** failed: a
facilitator that validates its input strictly against the v2 schema is judged
conformant, and a v1-only service, a credential-walled one and a non-EVM one are
each reported as not assessable. Those four cases were added after the first run
against facilitators nobody here operates, which returned three wrong verdicts —
including NOT CONFORMANT against a service that conforms. The cause was this
suite's own probe, not the targets. See [`docs/field-test-2026-09-06.md`](https://github.com/goodmeta/x402-conformance/blob/main/docs/field-test-2026-09-06.md).

## Spec

Checks are written against
[`x402-foundation/x402` `specs/x402-specification-v2.md`](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md)
at commit `e187dda1ef0c69c85416625342e5bb7c4b857dac`. The revision is recorded in
every report: a pass is a claim about a spec revision as much as about a
deployment.

The probe itself is built to the field tables in §5.1.2 (`PaymentRequirements`),
§5.2 (`PaymentPayload`) and `ResourceInfo` — not to §7.1's illustrative example,
which omits fields those tables mark Required.

Note that `x402-foundation/x402` is the live repository. `coinbase/x402` is not.

## Use it as a library

```ts
import { runConformance } from "@goodmeta/x402-conformance";

const report = await runConformance("https://your-facilitator.example");
// `conformant` is `true`, `false`, or `null` when the target was out of scope —
// check for null before treating a falsy value as a failure.
if (report.conformant === null) throw new Error(report.notAssessable ?? report.unreachable);
process.exit(report.conformant ? 0 : 1);
```

## Related

[`ap2-conformance`](https://github.com/goodmeta/ap2-conformance) does the
equivalent for AP2 mandate verification, minting its vectors from AP2's own
reference SDK.

---

Independent and open source, Apache-2.0, by [Good Meta](https://goodmeta.co).
Not affiliated with or endorsed by the x402 Foundation or Coinbase. "Conformant"
means the deployment satisfied the spec-required checks in this suite at the time
it ran.
