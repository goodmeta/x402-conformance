/**
 * The runner: drives a live facilitator over real HTTP and grades the answers.
 *
 * No mocking, by design. The thing being tested is a deployment, not a library,
 * so the only evidence worth anything comes from the wire.
 *
 * Nothing here is destructive. Every probe carries a signature that cannot
 * verify, so a conforming facilitator rejects all of them and no value moves.
 * That is what makes the suite safe to point at a mainnet deployment, including
 * someone else's.
 */

import {
  checkMalformed,
  checkSettle,
  checkSupported,
  checkUnknownNetwork,
  checkVerify,
  type CheckResult,
  type Probe,
  type Severity,
} from "./checks.js";

export interface Report {
  target: string;
  ranAt: string;
  specCommit: string;
  /**
   * `true` when every core check passed, `false` when one failed, and `null`
   * when the target could not be graded at all — see `notAssessable`. A suite
   * that collapses "not applicable" into "failed" makes a wrong accusation, so
   * the third state is deliberate rather than a convenience.
   */
  conformant: boolean | null;
  core: { passed: number; total: number };
  optional: { passed: number; total: number };
  results: CheckResult[];
  /** Set when the target could not be reached at all. */
  unreachable?: string;
  /** Set when the target was reached but is out of this suite's scope. */
  notAssessable?: string;
}

/**
 * The x402 spec revision these checks were written against. Pinned so a report
 * says which version of the rules it applied — a pass is a claim about a spec
 * revision as much as about a deployment.
 */
export const SPEC_COMMIT =
  "x402-foundation/x402 specs/x402-specification-v2.md @ e187dda1ef0c69c85416625342e5bb7c4b857dac (2026-08-31)";

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The requirements the probe claims to be paying against.
 *
 * Exactly the fields §5.1.2 defines, and nothing else. An earlier version added
 * `maxAmountRequired`, `resource`, `description` and `mimeType` here — none of
 * which exist in v2 — and left four Required fields off `accepted`. Facilitators
 * that validate strictly rejected the whole request, and the suite graded that
 * rejection as a spec violation. It was ours.
 */
function requirements(network: string) {
  return {
    scheme: "exact",
    network,
    amount: "1",
    asset: "0x0000000000000000000000000000000000000003",
    payTo: "0x0000000000000000000000000000000000000002",
    maxTimeoutSeconds: 60,
  };
}

/**
 * A payment whose signature is 65 zero bytes. Structurally well-formed so it
 * reaches the verifier's signature check, cryptographically hopeless so it can
 * never authorize anything.
 *
 * Built to §5.2: `resource` is a ResourceInfo object, and `accepted` is a
 * complete PaymentRequirements object rather than a two-field stub.
 */
function evmPayment(network: string) {
  return {
    x402Version: 2,
    resource: {
      url: "https://example.invalid/x402-conformance",
      description: "x402 conformance probe",
      mimeType: "application/json",
    },
    accepted: requirements(network),
    payload: {
      signature: `0x${"00".repeat(65)}`,
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        value: "1",
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        // EIP-3009 types `nonce` as bytes32. A decimal string is not one, and a
        // facilitator that checks the payload shape answers "unrecognized EVM
        // payment payload" — which this suite then read as its failure, not ours.
        nonce: `0x${Date.now().toString(16).padStart(64, "0")}`,
      },
    },
    extensions: {},
  };
}

async function probe(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, contentType: res.headers.get("content-type"), body };
  } finally {
    clearTimeout(timer);
  }
}

const json = (payload: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

/**
 * Pick a network to drive /verify and /settle against.
 *
 * EVM only, on purpose. The only payment this suite knows how to build is an
 * `exact` EIP-3009 authorization, so pointing it at a Solana, NEAR, Stellar or
 * XRPL facilitator produces an answer to a question that facilitator was never
 * asked. Returning null here makes the run report itself as out of scope instead
 * of grading a chain it cannot speak to.
 *
 * Prefers a testnet when one is advertised, purely to keep probes off mainnet
 * routing where the choice exists.
 */
export function pickNetwork(supported: unknown): string | null {
  const kinds = (supported as { kinds?: Record<string, unknown>[] } | null)?.kinds;
  if (!Array.isArray(kinds)) return null;
  const evm = kinds
    .filter((k) => k.x402Version === 2 && typeof k.network === "string")
    .map((k) => k.network as string)
    .filter((n) => n.startsWith("eip155:"));
  if (evm.length === 0) return null;
  const testnet = evm.find((n) => ["eip155:84532", "eip155:11155111", "eip155:43113"].includes(n));
  return testnet ?? evm[0] ?? null;
}

/**
 * Does the target declare v1 and only v1? Such a service never claimed v2, so
 * v2's requirements are not its to meet.
 *
 * Deliberately narrow: it must have answered 200 with a non-empty `kinds` array
 * in which nothing is v2. A `/supported` that 500s, or answers 200 with no
 * `kinds` at all, is BROKEN rather than out of scope, and must fall through to
 * the checks that say so — an earlier version of this gate swallowed both and
 * made two core checks unreachable.
 */
function declaresV1Only(probe: Probe): boolean {
  if (probe.status !== 200) return false;
  const kinds = (probe.body as { kinds?: Record<string, unknown>[] } | null)?.kinds;
  if (!Array.isArray(kinds) || kinds.length === 0) return false;
  return !kinds.some((k) => k.x402Version === 2);
}

export async function runConformance(
  target: string,
  opts: { timeoutMs?: number } = {},
): Promise<Report> {
  const base = target.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: CheckResult[] = [];
  const ctx = {
    add(name: string, severity: Severity, clause: string, ok: boolean, note?: string) {
      results.push({ name, severity, clause, pass: ok, ...(note ? { note } : {}) });
    },
  };

  const report = (opts: { unreachable?: string; notAssessable?: string } = {}): Report => {
    const core = results.filter((r) => r.severity === "core");
    const optional = results.filter((r) => r.severity === "optional");
    const ungraded = Boolean(opts.unreachable) || Boolean(opts.notAssessable);
    return {
      target: base,
      ranAt: new Date().toISOString(),
      specCommit: SPEC_COMMIT,
      conformant: ungraded ? null : core.every((r) => r.pass),
      core: { passed: core.filter((r) => r.pass).length, total: core.length },
      optional: { passed: optional.filter((r) => r.pass).length, total: optional.length },
      results,
      ...(opts.unreachable ? { unreachable: opts.unreachable } : {}),
      ...(opts.notAssessable ? { notAssessable: opts.notAssessable } : {}),
    };
  };

  let supported: Probe;
  try {
    supported = await probe(`${base}/supported`, { headers: { accept: "application/json" } }, timeoutMs);
  } catch (err) {
    return report({ unreachable: err instanceof Error ? err.message : String(err) });
  }

  // Scope gates run BEFORE any grading. Every check below asserts something the
  // v2 spec requires, so applying them to a service that never claimed v2, or on
  // a chain this suite cannot build a payment for, would manufacture failures.
  if (declaresV1Only(supported)) {
    return report({
      notAssessable:
        "declares x402 v1 kinds only at /supported — this suite grades v2, so there is nothing here it can judge",
    });
  }

  checkSupported(supported, ctx);

  // A scope gate must never overwrite a violation already found. If /supported
  // itself broke a Required rule, the run HAS graded something and the answer is
  // "not conformant" — "cannot assess" would bury the finding.
  const coreFailed = () => results.some((r) => r.severity === "core" && !r.pass);

  const network = pickNetwork(supported.body);
  if (!network) {
    if (coreFailed()) return report();
    return report({
      notAssessable:
        "advertises v2, but on no eip155 network — this suite builds `exact` EIP-3009 payments and cannot construct a valid one for the chains offered",
    });
  }
  ctx.add("probing network", "optional", "§7.3", true, network);

  const payload = {
    x402Version: 2,
    paymentPayload: evmPayment(network),
    paymentRequirements: requirements(network),
  };

  const verify = await probe(`${base}/verify`, json(payload), timeoutMs);
  if (verify.status === 401 || verify.status === 403) {
    if (coreFailed()) return report();
    return report({
      notAssessable: `POST /verify answered ${verify.status} — the facilitator requires credentials this suite does not hold, so nothing downstream of it can be read as conformance`,
    });
  }
  checkVerify(verify, ctx);

  // A namespace no facilitator can legitimately serve.
  const bogus = "eip155:999999999";
  checkUnknownNetwork(
    await probe(
      `${base}/verify`,
      json({ x402Version: 2, paymentPayload: evmPayment(bogus), paymentRequirements: requirements(bogus) }),
      timeoutMs,
    ),
    ctx,
  );

  checkSettle(await probe(`${base}/settle`, json(payload), timeoutMs), ctx);
  checkMalformed(await probe(`${base}/verify`, json({ nonsense: true }), timeoutMs), ctx);

  return report();
}
