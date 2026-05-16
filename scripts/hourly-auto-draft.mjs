#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = process.env.XSQUARED_HOME || path.join(root, ".xsquared");
const lockPath = path.join(appDir, "hourly-auto-draft.lock");
const logPath = path.join(appDir, "hourly-auto-draft.log");
const maxDrafts = process.env.XSQUARED_AUTO_DRAFT_MAX || "3";
const minScore = process.env.XSQUARED_AUTO_DRAFT_MIN_SCORE || "75";

function log(event) {
  mkdirSync(appDir, { recursive: true });
  appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n");
}

function run(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env }
  });
}

function main() {
  mkdirSync(appDir, { recursive: true });
  let fd = null;
  try {
    fd = openSync(lockPath, existsSync(lockPath) ? "wx" : "wx");
  } catch {
    process.stdout.write("NO_REPLY\n");
    return;
  }

  try {
    const build = run("npm", ["run", "build", "--silent"]);
    if (build.status !== 0) {
      log({ ok: false, step: "build", stderr: build.stderr, stdout: build.stdout });
      process.stdout.write("xsquared hourly auto-draft failed during build:\n" + (build.stderr || build.stdout || "unknown error").trim() + "\n");
      process.exitCode = 1;
      return;
    }

    const draft = run("node", ["dist/xsquared.js", "auto-draft", "--max-drafts", maxDrafts, "--min-score", minScore, "--json"]);
    const raw = (draft.stdout || "").trim();
    if (draft.status !== 0) {
      log({ ok: false, step: "auto-draft", stderr: draft.stderr, stdout: draft.stdout });
      process.stdout.write("xsquared hourly auto-draft failed:\n" + (draft.stderr || draft.stdout || "unknown error").trim() + "\n");
      process.exitCode = 1;
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log({ ok: false, step: "parse", stdout: raw });
      process.stdout.write("xsquared hourly auto-draft returned invalid JSON:\n" + raw.slice(0, 2000) + "\n");
      process.exitCode = 1;
      return;
    }

    log({ ok: true, result: parsed });
    if (!parsed.totalDrafted) {
      process.stdout.write("NO_REPLY\n");
      return;
    }

    const lines = ["xsquared created " + parsed.totalDrafted + " draft(s) from viral feed:"];
    for (const result of parsed.results || []) {
      if (!result.drafted) continue;
      lines.push("- " + result.sourceName + ": " + result.drafted + " draft(s) " + (result.postIds || []).join(", "));
    }
    lines.push("Review in dashboard: http://127.0.0.1:3888");
    process.stdout.write(lines.join("\n") + "\n");
  } finally {
    if (fd !== null) closeSync(fd);
    try { unlinkSync(lockPath); } catch {}
  }
}

main();
