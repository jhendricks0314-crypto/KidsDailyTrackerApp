import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stampVersion } from "./scripts/stamp-version.mjs";

// Stamp a fresh build id (writes public/version.json + src/version.js) and
// remember it so we can bake it into the service worker.
const BUILD_ID = stampVersion();

// Small plugin: after the build, rewrite dist/sw.js so its cache name carries
// this exact build id (the source uses a __BUILD_ID__ placeholder).
function serviceWorkerVersion() {
  return {
    name: "service-worker-version",
    apply: "build",
    closeBundle() {
      const swPath = resolve(__dirname, "dist/sw.js");
      try {
        const src = readFileSync(swPath, "utf8");
        writeFileSync(swPath, src.replace(/__BUILD_ID__/g, BUILD_ID));
      } catch (e) {
        this.warn(`Could not stamp dist/sw.js: ${e.message}`);
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorkerVersion()],
  define: {
    // Also available as a global fallback if needed.
    __APP_BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  build: {
    outDir: "dist",
  },
});
