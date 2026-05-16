#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.PORT || "3888";
const host = process.env.HOST || "127.0.0.1";
const watchRoots = ["src", "skills", "package.json", "tsconfig.json"].map((p) => path.join(root, p));
let server = null;
let lastSig = "";
let restarting = false;

function walk(target, out = []) {
  if (!existsSync(target)) return out;
  const stat = statSync(target);
  if (stat.isDirectory()) {
    for (const name of readdirSync(target)) {
      if (name === "node_modules" || name === ".git" || name === "dist" || name === ".xsquared") continue;
      walk(path.join(target, name), out);
    }
  } else {
    out.push(target + ":" + stat.mtimeMs + ":" + stat.size);
  }
  return out;
}

function signature() {
  return watchRoots.flatMap((item) => walk(item)).sort().join("|");
}

function build() {
  const result = spawnSync("npm", ["run", "build", "--silent"], { cwd: root, stdio: "inherit" });
  return result.status === 0;
}

function start() {
  if (!build()) {
    process.stderr.write("xsquared dev: build failed; keeping previous server state\n");
    return;
  }
  server = spawn("node", ["dist/xsquared.js", "dashboard", "--port", port, "--host", host], {
    cwd: root,
    stdio: "inherit"
  });
}

function stop(callback) {
  if (!server || server.killed) {
    callback();
    return;
  }
  const old = server;
  old.once("exit", callback);
  old.kill("SIGTERM");
  setTimeout(() => {
    if (!old.killed) old.kill("SIGKILL");
  }, 1500);
}

function restart() {
  if (restarting) return;
  restarting = true;
  stop(() => {
    start();
    restarting = false;
  });
}

lastSig = signature();
start();

setInterval(() => {
  const next = signature();
  if (next !== lastSig) {
    lastSig = next;
    process.stdout.write("xsquared dev: change detected; rebuilding dashboard\n");
    restart();
  }
}, 1000);

process.on("SIGINT", () => stop(() => process.exit(0)));
process.on("SIGTERM", () => stop(() => process.exit(0)));
