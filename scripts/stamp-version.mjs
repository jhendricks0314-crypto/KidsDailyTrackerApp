// scripts/stamp-version.mjs
// Generates a unique build id and writes it where both the app and the
// service worker can read it. Run automatically by the Vite build (see
// vite.config.js) and also usable standalone: `node scripts/stamp-version.mjs`.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A build id that changes every deploy. Date + short random keeps it readable.
const buildId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random()
  .toString(36)
  .slice(2, 8)}`;

export function stampVersion() {
  // 1) public/version.json — fetched at runtime to detect new deploys.
  mkdirSync(resolve(root, "public"), { recursive: true });
  writeFileSync(
    resolve(root, "public/version.json"),
    JSON.stringify({ version: buildId, builtAt: new Date().toISOString() }, null, 2)
  );

  // 2) src/version.js — compiled into the app bundle so the running app knows
  //    which version IT is.
  mkdirSync(resolve(root, "src"), { recursive: true });
  writeFileSync(
    resolve(root, "src/version.js"),
    `// AUTO-GENERATED at build time. Do not edit.\nexport const APP_VERSION = ${JSON.stringify(
      buildId
    )};\n`
  );

  return buildId;
}

// Allow running directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const id = stampVersion();
  console.log("Stamped build version:", id);
}
