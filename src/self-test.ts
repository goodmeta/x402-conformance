/**
 * Self-test: does the suite actually catch anything?
 *
 * A conformance suite that only ever passes is worse than no suite, because it
 * certifies whatever it is pointed at. So this boots mock facilitators over REAL
 * sockets — one conforming, then several sabotaged in one specific way each —
 * and asserts the suite reaches the verdict it should, failing on the check that
 * corresponds to the sabotage and no other.
 *
 * Real sockets rather than a function call, because the suite's whole job is to
 * exercise an HTTP deployment; grading an in-process object would test a
 * different thing than the one that ships.
 *
 * Run: npm test
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runConformance } from "./runner.js";

type Handler = (path: string, body: unknown) => { status: number; json?: unknown; text?: string };

/** A facilitator that does everything §7 asks of it. */
const conforming: Handler = (path) => {
  if (path === "/supported") {
    return {
      status: 200,
      json: {
        kinds: [
          { x402Version: 2, scheme: "exact", network: "eip155:84532", extra: { assetTransferMethod: "eip3009" } },
          { x402Version: 2, scheme: "exact", network: "eip155:8453", extra: { assetTransferMethod: "eip3009" } },
        ],
        extensions: [],
        signers: { "eip155:*": ["0x0000000000000000000000000000000000000009"] },
      },
    };
  }
  if (path === "/verify") {
    return { status: 200, json: { isValid: false, payer: "0x0000000000000000000000000000000000000001", invalidReason: "invalid_signature" } };
  }
  if (path === "/settle") {
    return { status: 200, json: { success: false, payer: "0x0000000000000000000000000000000000000001", transaction: "", network: "eip155:84532", errorReason: "invalid_signature" } };
  }
  return { status: 404, json: { error: "not found" } };
};

/** Wrap the conforming handler and break exactly one thing. */
function sabotage(name: string, mutate: Handler): { name: string; handler: Handler } {
  return { name, handler: mutate };
}

const SABOTAGES = [
  sabotage("accepts an unsigned payment at /verify", (path, body) => {
    if (path === "/verify") return { status: 200, json: { isValid: true, payer: "0xdead", invalidReason: null } };
    return conforming(path, body);
  }),
  sabotage("settles an unsigned payment", (path, body) => {
    if (path === "/settle") return { status: 200, json: { success: true, payer: "0xdead", transaction: "0xabc", network: "eip155:84532" } };
    return conforming(path, body);
  }),
  sabotage("answers settlement_pending with no transaction hash", (path, body) => {
    // The exact shape §5.3.2 forbids: broadcast happened, the caller is told
    // "pending", and gets nothing to reconcile with. A client reads this as
    // did-not-happen and signs a fresh authorization — a second payment.
    if (path === "/settle")
      return {
        status: 200,
        json: {
          success: false,
          payer: "0xdead",
          transaction: "",
          network: "eip155:84532",
          errorReason: "settlement_pending",
        },
      };
    return conforming(path, body);
  }),
  sabotage("reports a pending settlement as a success", (path, body) => {
    if (path === "/settle")
      return {
        status: 200,
        json: {
          success: true,
          payer: "0xdead",
          transaction: "0xabc",
          network: "eip155:84532",
          errorReason: "settlement_pending",
        },
      };
    return conforming(path, body);
  }),
  sabotage("omits `signers` from /supported", (path, body) => {
    if (path === "/supported") {
      const ok = conforming(path, body).json as Record<string, unknown>;
      delete ok.signers;
      return { status: 200, json: ok };
    }
    return conforming(path, body);
  }),
  sabotage("advertises a bare chain id instead of CAIP-2", (path, body) => {
    if (path === "/supported") {
      return {
        status: 200,
        json: {
          kinds: [{ x402Version: 2, scheme: "exact", network: "base-sepolia" }],
          extensions: [],
          signers: { "eip155:*": ["0x09"] },
        },
      };
    }
    return conforming(path, body);
  }),
  sabotage("rejects without saying why", (path, body) => {
    if (path === "/verify") return { status: 200, json: { isValid: false, payer: "0x01" } };
    return conforming(path, body);
  }),
  sabotage("500s on a malformed body", (path, body) => {
    if (path === "/verify" && body && typeof body === "object" && "nonsense" in (body as object)) {
      return { status: 500, text: "TypeError: cannot read property 'accepted' of undefined" };
    }
    return conforming(path, body);
  }),
  sabotage("500s on /supported", (path, body) => {
    if (path === "/supported") return { status: 500, json: { error: "internal" } };
    return conforming(path, body);
  }),
  sabotage("returns /supported with no kinds array", (path, body) => {
    if (path === "/supported") return { status: 200, json: { extensions: [], signers: {} } };
    return conforming(path, body);
  }),
  sabotage("falls through to a default chain for an unknown network", (path, body) => {
    if (path === "/verify") {
      const b = body as { paymentPayload?: { accepted?: { network?: string } } };
      if (b?.paymentPayload?.accepted?.network === "eip155:999999999") {
        return { status: 200, json: { isValid: true, payer: "0x01", invalidReason: null } };
      }
    }
    return conforming(path, body);
  }),
];

/**
 * The other half of the job: a suite that fails honest services is as useless as
 * one that passes broken ones. Each target below is either conforming or simply
 * out of scope, and NONE of them may be reported as non-conformant.
 *
 * Written after the first field test against facilitators we do not own
 * (2026-09-06), which returned three wrong verdicts out of five.
 */

/** Required fields of PaymentRequirements, §5.1.2. */
const REQUIRED_PR = ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds"] as const;

/**
 * Conforming, and it validates its input the way the schema says — like PayAI,
 * which named every defect in our probe. A probe built to §5.2 gets a 200.
 */
const strictSchema: Handler = (path, body) => {
  if (path === "/verify" || path === "/settle") {
    const b = body as { paymentPayload?: Record<string, unknown> } | null;
    const pp = b?.paymentPayload;
    const complaints: string[] = [];
    if (!pp) complaints.push("paymentPayload: expected object");
    else {
      if (typeof pp.resource !== "object" || pp.resource === null) {
        complaints.push("resource: expected object, received " + typeof pp.resource);
      }
      const accepted = pp.accepted as Record<string, unknown> | undefined;
      if (typeof accepted !== "object" || accepted === null) complaints.push("accepted: expected object");
      else {
        for (const f of REQUIRED_PR) {
          if (accepted[f] === undefined) complaints.push(`accepted.${f}: received undefined`);
        }
      }
      // EIP-3009's nonce is bytes32. PayAI rejects anything else with
      // "unrecognized EVM payment payload", which the suite used to read as a
      // spec violation by PayAI.
      const auth = (pp.payload as { authorization?: Record<string, unknown> } | undefined)?.authorization;
      const nonce = auth?.nonce;
      if (typeof nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
        complaints.push("unrecognized EVM payment payload: expected an EIP-3009 authorization");
      }
    }
    if (complaints.length > 0) {
      return { status: 400, json: { isValid: false, invalidReason: "invalid_payload", invalidMessage: complaints.join("; ") } };
    }
  }
  return conforming(path, body);
};

/** Speaks x402 v1 only. It never claimed v2, so v2 checks do not apply to it. */
const v1Only: Handler = (path) => {
  if (path === "/supported") {
    return {
      status: 200,
      json: {
        kinds: [
          { x402Version: 1, scheme: "exact", network: "base-sepolia" },
          { x402Version: 1, scheme: "exact", network: "base" },
        ],
      },
    };
  }
  return { status: 404, json: { error: "not found" } };
};

/** Wants an API key. Nothing about its conformance can be read through a 401. */
const authRequired: Handler = (path, body) => {
  if (path === "/verify" || path === "/settle") {
    return { status: 401, json: { error: { code: "invalid_api_key", message: "missing or invalid API key" } } };
  }
  return conforming(path, body);
};

/** v2, but on a chain this suite cannot build a payment for. */
const nonEvmOnly: Handler = (path, body) => {
  if (path === "/supported") {
    return {
      status: 200,
      json: {
        kinds: [{ x402Version: 2, scheme: "exact", network: "near:mainnet" }],
        extensions: [],
        signers: { "near:mainnet": ["x402-relayer.example.near"] },
      },
    };
  }
  return conforming(path, body);
};

const MISJUDGMENTS: { name: string; handler: Handler; expect: "conformant" | "not-assessable" }[] = [
  { name: "a conforming facilitator that validates its input strictly", handler: strictSchema, expect: "conformant" },
  { name: "a v1-only facilitator", handler: v1Only, expect: "not-assessable" },
  { name: "a facilitator that requires an API key", handler: authRequired, expect: "not-assessable" },
  { name: "a v2 facilitator on a non-EVM chain only", handler: nonEvmOnly, expect: "not-assessable" },
];

async function boot(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString();
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      const out = handler(path, body);
      if (out.text !== undefined) {
        res.writeHead(out.status, { "content-type": "text/plain" });
        res.end(out.text);
        return;
      }
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.json ?? {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  console.log("self-test: does the suite catch what it claims to?\n");

  console.log("a conforming facilitator");
  {
    const s = await boot(conforming);
    try {
      const r = await runConformance(s.url);
      const failed = r.results.filter((x) => x.severity === "core" && !x.pass);
      check("passes every core check", r.conformant === true, failed.map((f) => f.name).join(", ") || undefined);
      check("runs a meaningful number of core checks", r.core.total >= 12, `${r.core.total} core checks`);
    } finally {
      await s.close();
    }
  }

  console.log("\nsabotaged facilitators — each must be caught");
  for (const { name, handler } of SABOTAGES) {
    const s = await boot(handler);
    try {
      const r = await runConformance(s.url);
      const failed = r.results.filter((x) => x.severity === "core" && !x.pass);
      // `=== false` and not `!r.conformant`: a sabotage that made the target
      // unreadable would satisfy a falsy test without any check having fired.
      check(name, r.conformant === false, failed.length ? `caught by: ${failed.map((f) => f.name).join("; ")}` : "NOT CAUGHT");
    } finally {
      await s.close();
    }
  }

  console.log("\nhonest targets — none of these may be called non-conformant");
  for (const { name, handler, expect } of MISJUDGMENTS) {
    const s2 = await boot(handler);
    try {
      const r = await runConformance(s2.url);
      const failed = r.results.filter((x) => x.severity === "core" && !x.pass);
      const detail = failed.length ? `wrongly failed: ${failed.map((f) => f.name).join("; ")}` : undefined;
      if (expect === "conformant") {
        check(`${name} — judged conformant`, r.conformant === true, detail);
      } else {
        check(
          `${name} — judged not assessable`,
          r.conformant === null && Boolean(r.notAssessable),
          r.notAssessable ?? detail ?? `conformant=${String(r.conformant)}`,
        );
      }
    } finally {
      await s2.close();
    }
  }

  console.log("\nan unreachable target");
  {
    // Port 1 on loopback: nothing listens, connection refused immediately.
    const r = await runConformance("http://127.0.0.1:1");
    check("is reported as unreachable, not as a failure", Boolean(r.unreachable) && r.conformant === null, r.unreachable);
  }

  console.log(failures === 0 ? "\nself-test passed" : `\nself-test FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
