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
  conformant: boolean;
  core: { passed: number; total: number };
  optional: { passed: number; total: number };
  results: CheckResult[];
  /** Set when the target could not be reached at all. */
  unreachable?: string;
}

/**
 * The x402 spec revision these checks were written against. Pinned so a report
 * says which version of the rules it applied — a pass is a claim about a spec
 * revision as much as about a deployment.
 */
export const SPEC_COMMIT = "x402-foundation/x402@main specs/x402-specification-v2.md, read 2026-09-02";

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A payment whose signature is 65 zero bytes. Structurally well-formed so it
 * reaches the verifier's signature check, cryptographically hopeless so it can
 * never authorize anything.
 */
function evmPayment(network: string) {
  return {
    x402Version: 2,
    resource: "https://example.invalid/x402-conformance",
    accepted: { scheme: "exact", network },
    payload: {
      signature: `0x${"00".repeat(65)}`,
      authorization: {
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        value: "1",
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce: String(Date.now()),
      },
    },
    extensions: {},
  };
}

function requirements(network: string) {
  return {
    scheme: "exact",
    network,
    amount: "1",
    maxAmountRequired: "1",
    payTo: "0x0000000000000000000000000000000000000002",
    asset: "0x0000000000000000000000000000000000000003",
    resource: "https://example.invalid/x402-conformance",
    description: "x402 conformance probe",
    mimeType: "application/json",
    maxTimeoutSeconds: 60,
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
 * Taken from the target's OWN /supported rather than hardcoded, so the suite
 * works against a facilitator on any chain. Prefers a testnet-looking EVM
 * network when one is advertised, purely to keep probes off mainnet routing
 * where the choice exists.
 */
export function pickNetwork(supported: unknown): string | null {
  const kinds = (supported as { kinds?: Record<string, unknown>[] } | null)?.kinds;
  if (!Array.isArray(kinds)) return null;
  const networks = kinds
    .filter((k) => k.x402Version === 2 && typeof k.network === "string")
    .map((k) => k.network as string);
  if (networks.length === 0) return null;
  const evm = networks.filter((n) => n.startsWith("eip155:"));
  // Base Sepolia and the common EVM testnet ids, when offered.
  const testnet = evm.find((n) => ["eip155:84532", "eip155:11155111", "eip155:43113"].includes(n));
  return testnet ?? evm[0] ?? networks[0] ?? null;
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

  const report = (unreachable?: string): Report => {
    const core = results.filter((r) => r.severity === "core");
    const optional = results.filter((r) => r.severity === "optional");
    return {
      target: base,
      ranAt: new Date().toISOString(),
      specCommit: SPEC_COMMIT,
      conformant: !unreachable && core.every((r) => r.pass),
      core: { passed: core.filter((r) => r.pass).length, total: core.length },
      optional: { passed: optional.filter((r) => r.pass).length, total: optional.length },
      results,
      ...(unreachable ? { unreachable } : {}),
    };
  };

  let supported: Probe;
  try {
    supported = await probe(`${base}/supported`, { headers: { accept: "application/json" } }, timeoutMs);
  } catch (err) {
    return report(err instanceof Error ? err.message : String(err));
  }
  checkSupported(supported, ctx);

  const network = pickNetwork(supported.body);
  if (!network) {
    ctx.add(
      "a network could be selected from /supported",
      "core",
      "§7.3",
      false,
      "no v2 kind with a network to drive /verify and /settle against",
    );
    return report();
  }
  ctx.add("probing network", "optional", "§7.3", true, network);

  const payload = { paymentPayload: evmPayment(network), paymentRequirements: requirements(network) };

  checkVerify(await probe(`${base}/verify`, json(payload), timeoutMs), ctx);

  // A namespace no facilitator can legitimately serve.
  const bogus = "eip155:999999999";
  checkUnknownNetwork(
    await probe(
      `${base}/verify`,
      json({ paymentPayload: evmPayment(bogus), paymentRequirements: requirements(bogus) }),
      timeoutMs,
    ),
    ctx,
  );

  checkSettle(await probe(`${base}/settle`, json(payload), timeoutMs), ctx);
  checkMalformed(await probe(`${base}/verify`, json({ nonsense: true }), timeoutMs), ctx);

  return report();
}
