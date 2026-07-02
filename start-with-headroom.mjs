#!/usr/bin/env node
/**
 * Start 9router with headroom auto-start.
 * Headroom proxy dies when 9router restarts because it's a child process.
 * This wrapper reads settings from SQLite and starts headroom before launching
 * the Next.js standalone server, so headroom survives 9router restarts.
 *
 * Usage: node start-with-headroom.mjs
 */

import { spawn, execSync } from "child_process";
import { createRequire } from "module";
import path from "path";
import fs from "fs";
import os from "os";

const require = createRequire(import.meta.url);

async function startHeadroom() {
  const configured = process.env.DATA_DIR;
  const dataDir = configured || path.join(os.homedir(), ".9router");
  const dbPath = path.join(dataDir, "db", "data.sqlite");

  if (!fs.existsSync(dbPath)) return;

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  const row = db.get("SELECT data FROM settings WHERE id = 1");
  if (!row) return;

  const settings = JSON.parse(row.data);
  if (!settings.headroomEnabled) return;

  const url = settings.headroomUrl || "http://localhost:8787";
  let port = 8787;
  try {
    const u = new URL(url);
    if (u.port) port = parseInt(u.port, 10);
  } catch {}

  // Check if already running
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      console.log(`[headroom] proxy already running on port ${port}`);
      return;
    }
  } catch {}

  // Find headroom binary
  let binary;
  try {
    binary = execSync("which headroom", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    console.warn("[headroom] CLI not installed, skipping");
    return;
  }
  if (!binary) {
    console.warn("[headroom] CLI not found, skipping");
    return;
  }

  console.log(`[headroom] starting proxy on port ${port}...`);
  const logDir = path.join(dataDir, "headroom");
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "proxy.log");
  const outFd = fs.openSync(logFile, "a");

  const child = spawn(binary, ["proxy", "--port", String(port)], {
    stdio: ["ignore", outFd, outFd],
    detached: true,
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(outFd);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        process.kill(child.pid, 0);
        resolve();
      } catch {
        reject(new Error("exited during startup"));
      }
    }, 8000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited early (code=${code})`));
    });
  });

  console.log(`[headroom] proxy started (pid=${child.pid})`);
}

// Start headroom, then launch Next.js
try {
  await startHeadroom();
} catch (e) {
  console.warn(`[headroom] auto-start failed: ${e.message}`);
}

// Start the Next.js standalone server
const standaloneServer = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  ".next",
  "standalone",
  "server.js"
);

console.log("[9router] starting server...");
require(standaloneServer);
