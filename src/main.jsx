import React from "react";
import { createRoot } from "react-dom/client";
import App from "./StudyQuest.jsx";
import { registerServiceWorker } from "./appUpdate.jsx";

// full-height, no default margins
const baseStyle = document.createElement("style");
baseStyle.textContent = `
  html, body, #root { margin: 0; padding: 0; min-height: 100%; }
  body { background: #f3eefb; }
`;
document.head.appendChild(baseStyle);

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Register the PWA service worker (no-op in dev / unsupported browsers).
registerServiceWorker();
