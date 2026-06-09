import React, { useEffect, useState, useCallback, useRef } from "react";
import { APP_VERSION } from "./version.js";

/* ------------------------------------------------------------------ *
 * App update detection
 *
 * Two complementary signals decide that a new version is available:
 *   1. version.json on the server reports a different version than the
 *      APP_VERSION baked into this running bundle.
 *   2. The service worker finds a new worker installed and waiting.
 *
 * When either fires, we surface an Update banner. Tapping "Update" tells
 * the waiting service worker to take over and reloads to the new version.
 * ------------------------------------------------------------------ */

const CHECK_INTERVAL_MS = 60 * 1000; // poll once a minute while open

// Register the service worker. Call once, early (from main.jsx).
export function registerServiceWorker() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (!import.meta.env.PROD) return; // only in built/deployed app
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

export function useAppUpdate() {
  const [updateReady, setUpdateReady] = useState(false);
  const waitingRef = useRef(null);

  // Ask the server which version is currently published.
  const checkServerVersion = useCallback(async () => {
    try {
      const res = await fetch(`/version.json?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.version && data.version !== APP_VERSION) {
        setUpdateReady(true);
      }
    } catch {
      /* offline or not deployed — ignore */
    }
  }, []);

  useEffect(() => {
    const hasSW = typeof navigator !== "undefined" && "serviceWorker" in navigator;

    // 1) Service-worker based detection.
    if (hasSW) {
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (!reg) return;

        // A worker already waiting (e.g. installed on a previous visit).
        if (reg.waiting) {
          waitingRef.current = reg.waiting;
          setUpdateReady(true);
        }

        // A new worker starts installing -> watch until it's ready.
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            if (nw.state === "installed" && navigator.serviceWorker.controller) {
              waitingRef.current = reg.waiting || nw;
              setUpdateReady(true);
            }
          });
        });

        // Proactively ask the browser to look for an update now.
        reg.update().catch(() => {});
      });

      // When the controller changes (new worker took over), reload once.
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    }

    // 2) version.json polling — works even if service workers are unavailable.
    checkServerVersion();
    const id = setInterval(checkServerVersion, CHECK_INTERVAL_MS);

    // Re-check when the user returns to the tab/app.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        checkServerVersion();
        if (hasSW) navigator.serviceWorker.getRegistration().then((r) => r && r.update().catch(() => {}));
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [checkServerVersion]);

  // Apply the update: activate the waiting worker (it will trigger a reload
  // via controllerchange). If there's no waiting worker, just hard-reload.
  const applyUpdate = useCallback(() => {
    const hasSW = typeof navigator !== "undefined" && "serviceWorker" in navigator;
    if (hasSW && waitingRef.current) {
      waitingRef.current.postMessage({ type: "SKIP_WAITING" });
      // Safety net: if controllerchange doesn't fire shortly, force reload.
      setTimeout(() => window.location.reload(), 1500);
    } else if (hasSW) {
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (reg && reg.waiting) {
          reg.waiting.postMessage({ type: "SKIP_WAITING" });
          setTimeout(() => window.location.reload(), 1500);
        } else {
          window.location.reload();
        }
      });
    } else {
      window.location.reload();
    }
  }, []);

  return { updateReady, applyUpdate };
}

/* ------------------------------- banner UI ------------------------------- */
export function UpdateBanner({ onUpdate }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="sq-noprint sq-update" role="status" aria-live="polite">
      <span className="sq-update-emoji" aria-hidden="true">✨</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 800, fontFamily: "'Fredoka', sans-serif" }}>A new version is ready!</div>
        <div style={{ fontSize: 13, opacity: 0.85 }}>Update now to get the latest StudyQuest.</div>
      </div>
      <button
        className="sq-update-btn"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          onUpdate();
        }}
      >
        {busy ? "Updating…" : "Update"}
      </button>
    </div>
  );
}
