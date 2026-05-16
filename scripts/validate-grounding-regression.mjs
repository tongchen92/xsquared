#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bad = [
  "Claude can now build your viral feed from scratch.",
  "",
  "1. Drop in your niche + 10 top posts",
  "2. It pulls the hooks, angles, and cadence that actually worked",
  "3. You get a ready-to-post content plan",
  "",
  "No more guessing. Just intent-matched content your audience already wants."
].join("\n");

const good = [
  "Anthropic shipping 31 small-business Claude skills is the right wedge.",
  "",
  "Not \"AI replaces the owner.\"",
  "",
  "More like:",
  "- reconcile the messy back office",
  "- draft the overdue follow-up",
  "- surface the cash risk before payroll",
  "",
  "Small businesses do not need more dashboards. They need fewer dropped balls."
].join("\n");

function runValidate(text) {
  const result = spawnSync("node", [
    "dist/xsquared.js",
    "validate-draft",
    "src_viral_default",
    "--text",
    text,
    "--json"
  ], { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "validate-draft failed").trim());
  }
  return JSON.parse(result.stdout);
}

const badResult = runValidate(bad);
const goodResult = runValidate(good);

if (badResult.ok) {
  throw new Error("Expected bad hallucinated draft to be rejected");
}
if (!goodResult.ok) {
  throw new Error("Expected grounded draft to pass: " + JSON.stringify(goodResult.issues));
}

process.stdout.write(JSON.stringify({
  ok: true,
  rejectedBadIssues: badResult.issues.length,
  acceptedGrounded: true
}, null, 2) + "\n");
