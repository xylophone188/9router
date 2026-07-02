const http = require("http");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const origCreate = http.createServer.bind(http);

// Wrap Next standalone HTTP server: derive client IP from the TCP socket
// (unspoofable) and strip client-supplied forwarding headers so downstream
// rate-limiting keys on the real peer address instead of attacker-controlled XFF.
http.createServer = (...args) => {
  const handler = args.find((a) => typeof a === "function");
  const rest = args.filter((a) => typeof a !== "function");
  if (!handler) return origCreate(...args);
  const wrapped = (req, res) => {
    const socketIp = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    const isLoopbackProxy = socketIp === "127.0.0.1" || socketIp === "::1" || socketIp === "::ffff:127.0.0.1";
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackProxy && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    req.headers["x-9r-real-ip"] = ip;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    return handler(req, res);
  };
  return origCreate(...rest, wrapped);
};

// Auto-start headroom proxy if enabled in settings.
// Headroom is spawned as a child of the Next.js process, so it dies when
// 9router restarts. This hook reads the SQLite settings and re-spawns the
// proxy on startup so the user doesn't have to click "Start" every time.
(async function autoStartHeadroom() {
  try {
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

    // Check if headroom CLI is available
    let binary;
    try {
      binary = execSync("which headroom", {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    } catch {
      console.warn("[headroom] CLI not installed, skipping auto-start");
      return;
    }
    if (!binary) {
      console.warn("[headroom] CLI not found, skipping auto-start");
      return;
    }

    console.log(`[headroom] auto-starting proxy on port ${port}...`);
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
  } catch (e) {
    console.warn(`[headroom] auto-start failed: ${e.message}`);
  }
})();

require("./server.js");
