/**
 * The check catalogue.
 *
 * Every check cites the clause of the x402 v2 specification it enforces, so a
 * failure is arguable against the spec text rather than against our reading of
 * it. Checks are split two ways:
 *
 *   core     — the spec marks the behaviour Required. A facilitator that fails
 *              one of these does not conform, and the runner exits non-zero.
 *   optional — the spec marks the field Optional, or describes a capability by
 *              example rather than requirement. Reported, never fatal. A
 *              facilitator legitimately differs here.
 *
 * The distinction matters more than it looks. The suite this was extracted from
 * asserted `scheme === "exact"` on every kind, required `extra.assetTransferMethod`
 * on every kind, and checked for three specific networks by name. The spec makes
 * none of those requirements — §7.3.1 lists `scheme` as Required with "exact" as
 * an example, `extra` as Optional, and says nothing about which networks a
 * facilitator must carry. Those checks describe one deployment, not the protocol,
 * and they would fail a conforming facilitator built by anyone else.
 *
 * Spec: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
 */

export type Severity = "core" | "optional";

export interface CheckResult {
  name: string;
  severity: Severity;
  /** Spec clause this check enforces, e.g. "§7.3.1". */
  clause: string;
  pass: boolean;
  /** Present on failure, and on a pass where the observed value is worth recording. */
  note?: string;
}

export interface Probe {
  status: number;
  contentType: string | null;
  body: unknown;
}

/** CAIP-2 is `namespace:reference`, namespace 3-8 lowercard, reference 1-32. */
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
/** A signer key is a CAIP-2 pattern, so the reference may be the `*` wildcard. */
const CAIP2_PATTERN = /^[-a-z0-9]{3,8}:([-_a-zA-Z0-9]{1,32}|\*)$/;

interface Ctx {
  add(name: string, severity: Severity, clause: string, ok: boolean, note?: string): void;
}

/**
 * GET /supported — §7.3.
 *
 * "Returns the list of payment schemes, networks, and extensions supported by
 * the facilitator."
 */
export function checkSupported(probe: Probe, ctx: Ctx): void {
  const c = "§7.3";
  ctx.add("GET /supported returns 200", "core", c, probe.status === 200, `status ${probe.status}`);
  ctx.add(
    "GET /supported is JSON",
    "core",
    c,
    Boolean(probe.contentType?.includes("application/json")),
    probe.contentType ?? "no content-type",
  );

  const body = probe.body as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    ctx.add("GET /supported has a JSON object body", "core", c, false, "body was not an object");
    return;
  }

  // §7.3.1 — kinds, extensions and signers are each marked Required.
  const kinds = body.kinds;
  const extensions = body.extensions;
  const signers = body.signers;

  const hasKinds = Array.isArray(kinds);
  ctx.add("`kinds` is an array (Required)", "core", "§7.3.1", hasKinds);
  ctx.add("`extensions` is an array (Required)", "core", "§7.3.1", Array.isArray(extensions));
  ctx.add(
    "`signers` is an object (Required)",
    "core",
    "§7.3.1",
    Boolean(signers) && typeof signers === "object" && !Array.isArray(signers),
  );

  if (!hasKinds) return;
  const list = kinds as Record<string, unknown>[];

  // A facilitator that supports nothing is well-formed but useless to a client.
  // The spec does not forbid it, so this is reported rather than enforced.
  ctx.add("`kinds` is non-empty", "optional", "§7.3", list.length > 0, `${list.length} kinds`);

  // Each SupportedKind: x402Version, scheme and network are Required; extra is Optional.
  const missingVersion = list.filter((k) => typeof k.x402Version !== "number");
  ctx.add(
    "every kind has a numeric `x402Version` (Required)",
    "core",
    "§7.3.1",
    missingVersion.length === 0,
    missingVersion.length ? `${missingVersion.length} without one` : undefined,
  );

  const missingScheme = list.filter((k) => typeof k.scheme !== "string" || !k.scheme);
  ctx.add(
    "every kind has a `scheme` string (Required)",
    "core",
    "§7.3.1",
    missingScheme.length === 0,
    missingScheme.length ? `${missingScheme.length} without one` : undefined,
  );

  // §7.3.1 requires CAIP-2 FORMAT. It does not enumerate namespaces, so this
  // validates the shape and never an allow-list — a facilitator on a namespace
  // we have never heard of is conforming.
  const v2 = list.filter((k) => k.x402Version === 2);
  const badNetwork = v2.filter((k) => typeof k.network !== "string" || !CAIP2.test(k.network as string));
  ctx.add(
    "every v2 kind's `network` is CAIP-2 (Required)",
    "core",
    "§7.3.1",
    badNetwork.length === 0,
    badNetwork.length ? `not CAIP-2: ${badNetwork.map((k) => String(k.network)).join(", ")}` : undefined,
  );

  ctx.add(
    "advertises at least one v2 kind",
    "core",
    "§7.3.1",
    v2.length > 0,
    `${v2.length} of ${list.length} kinds are v2`,
  );

  if (signers && typeof signers === "object") {
    const keys = Object.keys(signers as object);
    const badKeys = keys.filter((k) => !CAIP2_PATTERN.test(k));
    ctx.add(
      "`signers` keys are CAIP-2 patterns (Required)",
      "core",
      "§7.3.1",
      badKeys.length === 0,
      badKeys.length ? `not CAIP-2 patterns: ${badKeys.join(", ")}` : keys.join(", "),
    );
  }

  // Optional in §7.3.1. Recorded because a client that wants to pick a transfer
  // method without scheme-specific knowledge depends on it being there.
  const withExtra = list.filter((k) => k.extra && typeof k.extra === "object");
  ctx.add(
    "kinds carry `extra` scheme configuration (Optional)",
    "optional",
    "§7.3.1",
    withExtra.length === list.length,
    `${withExtra.length} of ${list.length}`,
  );

  // §6.1 introduced payment flows beyond `authorization`. A facilitator that
  // advertises one is exercising a newer part of the spec, not a required one.
  const flows = new Set(
    list
      .map((k) => (k.extra as Record<string, unknown> | undefined)?.paymentFlow)
      .filter((f): f is string => typeof f === "string"),
  );
  ctx.add(
    "declares a non-default `paymentFlow` (Optional)",
    "optional",
    "§6.1",
    flows.size > 0,
    flows.size ? [...flows].join(", ") : "none declared (authorization default)",
  );

  const schemes = [...new Set(list.map((k) => String(k.scheme)))];
  ctx.add(
    "scheme coverage",
    "optional",
    "§6",
    true,
    schemes.join(", "),
  );
}

/**
 * POST /verify — §7.1.
 *
 * "Verifies a payment authorization without executing the transaction on the
 * blockchain. `/verify` is read-only: it validates payment state but MUST NOT
 * commit payment state or write onchain state."
 *
 * Driven with a deliberately unsignable payload. A conforming facilitator
 * answers `isValid: false` with a reason — it does not fault, and it does not
 * accept it.
 */
export function checkVerify(probe: Probe, ctx: Ctx): void {
  const c = "§7.1";
  const body = probe.body as Record<string, unknown> | null;

  // §5.4 VerifyResponse is a response body, so a rejected payment is still 200.
  ctx.add(
    "POST /verify answers 200 for an invalid payment",
    "core",
    c,
    probe.status === 200,
    `status ${probe.status}`,
  );

  if (!body || typeof body !== "object") {
    ctx.add("POST /verify returns a VerifyResponse object", "core", "§5.4", false, "body was not an object");
    return;
  }

  ctx.add("`isValid` is a boolean", "core", "§5.4", typeof body.isValid === "boolean");
  // The facilitator may decline before it ever reaches the signature — an asset
  // it does not carry, a payee it will not serve. That is still a decline, which
  // is the property §7.1 fixes; the reason is recorded so a reader can see how
  // deep the probe got rather than having to assume.
  ctx.add(
    "a payment it cannot authorize is declined",
    "core",
    c,
    body.isValid === false,
    body.isValid === true ? "accepted a payload carrying an unsignable signature" : undefined,
  );
  ctx.add(
    "a rejection carries a reason",
    "core",
    "§5.4",
    typeof body.invalidReason === "string" && body.invalidReason.length > 0,
    typeof body.invalidReason === "string" ? body.invalidReason : "absent",
  );
  ctx.add(
    "`payer` is echoed on a rejection (Optional)",
    "optional",
    "§5.4",
    typeof body.payer === "string" && body.payer.length > 0,
  );
}

/**
 * POST /verify with an unknown network — §7.1.
 *
 * A facilitator asked about a network it never advertised must decline. The
 * failure mode this catches is a router that falls through to a default chain.
 */
export function checkUnknownNetwork(probe: Probe, ctx: Ctx): void {
  const body = probe.body as Record<string, unknown> | null;
  const declined = probe.status >= 400 || (body && body.isValid === false);
  ctx.add(
    "an unadvertised network is declined",
    "core",
    "§7.1",
    Boolean(declined),
    declined ? undefined : "did not decline a network absent from /supported",
  );
}

/**
 * POST /settle — §7.2.
 *
 * Driven with the same unsignable payload. Settlement commits state, so
 * accepting one that `/verify` rejects is the most serious failure the suite
 * can find.
 */
export function checkSettle(probe: Probe, ctx: Ctx): void {
  const c = "§7.2";
  const body = probe.body as Record<string, unknown> | null;

  ctx.add(
    "POST /settle answers without a server fault",
    "core",
    c,
    probe.status < 500,
    `status ${probe.status}`,
  );

  if (!body || typeof body !== "object") {
    ctx.add("POST /settle returns a SettlementResponse object", "core", "§5.3", false, "body was not an object");
    return;
  }

  ctx.add("`success` is a boolean", "core", "§5.3", typeof body.success === "boolean");
  ctx.add(
    "a payment it cannot authorize is not settled",
    "core",
    c,
    body.success === false,
    body.success === true ? "SETTLED a payload carrying an unsignable signature" : undefined,
  );
  ctx.add(
    "a failed settlement carries a reason",
    "core",
    "§5.3",
    typeof body.errorReason === "string" && body.errorReason.length > 0,
    typeof body.errorReason === "string" ? body.errorReason : "absent",
  );

  checkSettlementPending(body, ctx);
}

/**
 * §9 / §5.3.2 — `settlement_pending`.
 *
 * "The settlement transaction was broadcast but its confirmation could not be
 * established ... A SettleResponse with this errorReason MUST carry a non-empty
 * transaction (the broadcast hash) and network so the caller can reconcile on
 * chain before deciding whether to retry."
 *
 * Added upstream 2026-08-17 (x402-foundation/x402 PR #3083). It is the answer to
 * a real and expensive failure: a facilitator that broadcasts the transfer, then
 * cannot read the receipt, and reports a flat failure with no hash. A conforming
 * client reads that as did-not-happen and signs a fresh authorization, which is a
 * second payment. The hash is what makes the outcome reconcilable instead.
 *
 * WHY THIS CHECK REPORTS "NOT EXERCISED" RATHER THAN A PASS
 * --------------------------------------------------------
 * A prober cannot make a facilitator lose a receipt. So on almost every run this
 * clause is never reached, and asserting it anyway would produce a check that
 * cannot fail — worse than no check, because it reports safety nobody measured.
 * The invariant is graded only when a `settlement_pending` response is actually
 * observed. Otherwise this records, as an optional note, that it went untested.
 */
export function checkSettlementPending(body: Record<string, unknown>, ctx: Ctx): void {
  if (body.errorReason !== "settlement_pending") {
    ctx.add(
      "settlement_pending invariant NOT EXERCISED by this probe",
      "optional",
      "§9",
      true,
      "no settlement_pending response was observed, so the MUST-carry-a-hash rule went untested. " +
        "A prober cannot force a receipt failure; only a facilitator under real RPC trouble reaches it.",
    );
    return;
  }

  const tx = body.transaction;
  ctx.add(
    "settlement_pending carries the broadcast transaction hash",
    "core",
    "§5.3.2",
    typeof tx === "string" && tx.length > 0,
    typeof tx === "string" && tx.length === 0
      ? "empty transaction — the caller cannot reconcile, and reads this as did-not-happen"
      : typeof tx === "string"
        ? tx
        : "transaction absent",
  );

  ctx.add(
    "settlement_pending carries the network",
    "core",
    "§9",
    typeof body.network === "string" && (body.network as string).length > 0,
    typeof body.network === "string" ? (body.network as string) : "absent",
  );

  ctx.add(
    "settlement_pending is not reported as success",
    "core",
    "§9",
    body.success === false,
    body.success === true ? "success:true with a pending settlement" : undefined,
  );
}

/**
 * Malformed request handling.
 *
 * Not a numbered clause — this is the ordinary HTTP contract §7 assumes. A
 * facilitator that 500s on a bad body is leaking its own errors to callers.
 */
export function checkMalformed(probe: Probe, ctx: Ctx): void {
  ctx.add(
    "a malformed request is a 4xx, not a 5xx",
    "core",
    "§7",
    probe.status < 500,
    `status ${probe.status}`,
  );
}
