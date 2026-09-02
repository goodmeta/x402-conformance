#!/usr/bin/env node
/**
 * x402-conformance <url> [--json] [--timeout ms]
 *
 * Exits 0 when every core check passes, 1 when any fails, 2 on bad usage or an
 * unreachable target — so a red suite and a broken invocation are distinguishable
 * in CI.
 */

import { runConformance, type Report } from "./runner.js";

const USAGE = `x402-conformance <facilitator-url> [options]

  --json            machine-readable report on stdout, nothing else
  --timeout <ms>    per-request timeout (default 15000)

Every probe carries an unsignable signature, so a conforming facilitator
rejects all of them and no value moves. Safe against a mainnet deployment.`;

function render(report: Report): string {
  const lines: string[] = [];
  lines.push(`x402 v2 conformance`);
  lines.push(`target ${report.target}`);
  lines.push(`spec   ${report.specCommit}`);
  lines.push("");

  if (report.unreachable) {
    lines.push(`unreachable: ${report.unreachable}`);
    return lines.join("\n");
  }

  for (const severity of ["core", "optional"] as const) {
    const group = report.results.filter((r) => r.severity === severity);
    if (group.length === 0) continue;
    lines.push(severity === "core" ? "CORE — spec-required" : "OPTIONAL — informational");
    for (const r of group) {
      const mark = severity === "core" ? (r.pass ? "PASS" : "FAIL") : (r.pass ? "yes " : "no  ");
      const note = r.note ? `  — ${r.note}` : "";
      lines.push(`  ${mark}  ${r.clause.padEnd(7)} ${r.name}${note}`);
    }
    lines.push("");
  }

  lines.push(`core     ${report.core.passed}/${report.core.total}`);
  lines.push(`optional ${report.optional.passed}/${report.optional.total}`);
  lines.push("");
  lines.push(
    report.conformant
      ? "CONFORMANT — every spec-required check passed."
      : "NOT CONFORMANT — a spec-required check failed.",
  );
  lines.push("A pass is a claim about this deployment at this moment, not a standing property.");
  return lines.join("\n");
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return argv.length === 0 ? 2 : 0;
  }

  const wantsJson = argv.includes("--json");
  const timeoutIdx = argv.indexOf("--timeout");
  const timeoutMs = timeoutIdx >= 0 ? Number(argv[timeoutIdx + 1]) : undefined;
  if (timeoutIdx >= 0 && (!Number.isFinite(timeoutMs) || (timeoutMs as number) <= 0)) {
    console.error("--timeout needs a positive number of milliseconds");
    return 2;
  }

  const target = argv.find((a) => !a.startsWith("--") && a !== String(timeoutMs));
  if (!target) {
    console.error("no facilitator url given\n");
    console.error(USAGE);
    return 2;
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    console.error(`not a url: ${target}`);
    return 2;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    console.error(`unsupported protocol: ${url.protocol}`);
    return 2;
  }

  const report = await runConformance(url.toString(), timeoutMs ? { timeoutMs } : {});
  console.log(wantsJson ? JSON.stringify(report, null, 2) : render(report));
  if (report.unreachable) return 2;
  return report.conformant ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
