#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const standaloneRoot = path.join(appRoot, ".next", "standalone");
const staticSrc = path.join(appRoot, ".next", "static");
const staticDest = path.join(standaloneRoot, ".next", "static");
const publicSrc = path.join(appRoot, "public");
const publicDest = path.join(standaloneRoot, "public");

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return false;
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
  return true;
}

if (!fs.existsSync(standaloneRoot)) {
  console.error(`Standalone root not found: ${standaloneRoot}`);
  process.exit(1);
}

const copiedStatic = copyDir(staticSrc, staticDest);
const copiedPublic = copyDir(publicSrc, publicDest);

if (!copiedStatic && !copiedPublic) {
  console.log("No standalone assets to prepare.");
  process.exit(0);
}

console.log(
  [
    copiedStatic ? `Prepared ${path.relative(appRoot, staticDest)}` : null,
    copiedPublic ? `Prepared ${path.relative(appRoot, publicDest)}` : null,
  ]
    .filter(Boolean)
    .join("\n")
);
