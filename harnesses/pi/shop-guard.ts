// Pi extension: the same PII masking + refund policy, expressed as Pi extension events.
// Compare with plugins/shop-pii and plugins/shop-policy (dsh) to see how each harness exposes the same seams.
//
//   Pi event        dsh equivalent
//   context         agent/pre-step        rewrite what the model will read
//   tool_call       tools/pre-execute     block (or mutate) a call
//   tool_result     tools/post-execute    redact or replace a result
//
// Run:  SHOPOPS_PII=dictionary SHOPOPS_POLICY=strict pi --extension ./harnesses/pi/shop-guard.ts
// Pi has NO built-in permission system, so "ask" is turned into a block here (add ctx.ui.confirm if you want a prompt).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
// @ts-ignore plain ESM helpers shared with the dsh plugins
import { loadStore } from "../../lib/data.mjs";
// @ts-ignore
import { buildDictionary, redact } from "../../lib/redact.mjs";
// @ts-ignore
import { decide } from "../../lib/policy.mjs";

// run Pi from the repo root, or set SHOPOPS_DATA to the absolute path of data/shop.json
const DATA = process.env.SHOPOPS_DATA ?? join(process.cwd(), "data", "shop.json");
const PII = (process.env.SHOPOPS_PII ?? "regex") as "off" | "regex" | "dictionary";
const POLICY = (process.env.SHOPOPS_POLICY ?? "lenient") as "off" | "lenient" | "strict";

export default function (pi: ExtensionAPI) {
  const dictionary = PII === "dictionary" ? buildDictionary(loadStore(DATA)) : [];
  const mask = (s: string): string => redact(s, PII, dictionary).text;

  // 1. what the model reads
  pi.on("context", async (event: any) => {
    if (PII === "off") return;
    const messages = event.messages.map((m: any) => {
      if (m.role !== "user") return m;
      if (typeof m.content === "string") return { ...m, content: mask(m.content) };
      return { ...m, content: (m.content ?? []).map((b: any) => (b.type === "text" ? { ...b, text: mask(b.text) } : b)) };
    });
    return { messages };
  });

  // 2. refund policy (MCP tools arrive as mcp__shopops__issue_refund)
  pi.on("tool_call", async (event: any) => {
    if (POLICY === "off" || !String(event.toolName).endsWith("issue_refund")) return;
    const d = decide(loadStore(DATA), "issue_refund", event.input, { mode: POLICY, autoLimit: 200, askAbove: 50, hardCap: 500 });
    if (d.kind === "allow") return;
    return { block: true, reason: d.reason ?? "Refund needs human approval." };
  });

  // 3. what the model receives back from tools. The docs say to replace structuredContent too.
  pi.on("tool_result", async (event: any) => {
    if (PII === "off") return;
    const content = (event.content ?? []).map((b: any) => (b.type === "text" ? { ...b, text: mask(b.text) } : b));
    const out: any = { content };
    if (event.structuredContent !== undefined) out.structuredContent = JSON.parse(mask(JSON.stringify(event.structuredContent)));
    return out;
  });
}
