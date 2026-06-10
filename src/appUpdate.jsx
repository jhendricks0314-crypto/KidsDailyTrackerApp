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

/* ------------------------------------------------------------------ *
 * Install ("Add to Home screen") support
 *
 * Chrome/Edge/Android fire `beforeinstallprompt` when the PWA meets the
 * install criteria. We capture it and expose a promptInstall() so the app
 * can show its own "Install app" button (more reliable than waiting for the
 * browser's mini-infobar, which it often suppresses).
 *
 * iOS Safari has no prompt event — installing is manual via the Share menu —
 * so we detect iOS and surface short instructions instead.
 * ------------------------------------------------------------------ */
export function isStandalone() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    window.navigator.standalone === true // iOS
  );
}

function isIOS() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOSDevice = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ reports as Mac but has touch
  const iPadOS = navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
  return iOSDevice || iPadOS;
}

export function useInstallPrompt() {
  const deferredRef = useRef(null);
  const [canInstall, setCanInstall] = useState(false);
  const [installed, setInstalled] = useState(isStandalone());
  const ios = isIOS();

  useEffect(() => {
    if (typeof window === "undefined") return;

    const onBeforeInstall = (e) => {
      e.preventDefault(); // stop the mini-infobar; we'll show our own button
      deferredRef.current = e;
      setCanInstall(true);
    };
    const onInstalled = () => {
      setInstalled(true);
      setCanInstall(false);
      deferredRef.current = null;
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    const mq = window.matchMedia?.("(display-mode: standalone)");
    const onDisplayChange = (e) => setInstalled(e.matches);
    mq?.addEventListener?.("change", onDisplayChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      mq?.removeEventListener?.("change", onDisplayChange);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    const e = deferredRef.current;
    if (!e) return false;
    e.prompt();
    try {
      await e.userChoice;
    } catch {}
    deferredRef.current = null;
    setCanInstall(false);
    return true;
  }, []);

  // Show the button when the browser offered a prompt, or on iOS (manual),
  // as long as we're not already running as an installed app.
  const showInstall = !installed && (canInstall || ios);
  return { showInstall, canInstall, installed, ios, promptInstall };
}

export function InstallButton() {
  const { showInstall, canInstall, ios, promptInstall } = useInstallPrompt();
  const [showHelp, setShowHelp] = useState(false);
  if (!showInstall) return null;

  return (
    <>
      <button
        className="sq-install-btn"
        onClick={() => (canInstall ? promptInstall() : setShowHelp(true))}
      >
        📲 Install app
      </button>
      {showHelp && ios && (
        <div className="sq-overlay" onClick={() => setShowHelp(false)}>
          <div
            className="sq-card"
            style={{ maxWidth: 360, width: "100%", padding: 24, borderRadius: 18, textAlign: "center" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: 40 }}>📲</div>
            <h2 style={{ fontFamily: "'Fredoka', sans-serif", color: "#4a3f5e", margin: "8px 0" }}>
              Install StudyQuest
            </h2>
            <p style={{ color: "#6a5f7e", lineHeight: 1.5 }}>
              In Safari, tap the <strong>Share</strong> button{" "}
              <span aria-hidden="true">⬆️</span>, then choose{" "}
              <strong>“Add to Home Screen”</strong>.
            </p>
            <button
              className="sq-install-btn"
              style={{ marginTop: 8 }}
              onClick={() => setShowHelp(false)}
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
