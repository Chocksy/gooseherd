import type { ContextBag } from "../context-bag.js";

export interface GateReportEntry {
  gate: string;
  verdict: string;
  reasons: string[];
}

/** Append a gate result to the accumulated gate report in context. */
export function appendGateReport(
  ctx: ContextBag,
  gateName: string,
  verdict: string,
  reasons: string[]
): void {
  const report = ctx.get<GateReportEntry[]>("gateReport") ?? [];
  report.push({ gate: gateName, verdict, reasons });
  ctx.set("gateReport", report);
}
