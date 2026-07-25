import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { App } from "./App";

const host = document.getElementById("root");
if (!host) throw new Error("index.html is missing #root");

/**
 * `window.vault` is injected by the preload, so it only exists inside Electron.
 * Opened in an ordinary browser this would blow up on the first call and render
 * nothing at all, which looks like a broken app rather than the wrong container.
 */
if (!window.vault) {
  host.innerHTML = `
    <div style="height:100%;display:grid;place-items:center;padding:32px;
                font:13px/1.6 system-ui,sans-serif;color:#9aa3b2;text-align:center">
      <div style="max-width:440px">
        <h1 style="font-size:17px;color:#e6e9ef;margin:0 0 10px">This is the renderer, not the app</h1>
        <p style="margin:0 0 8px">
          The vault lives in Electron's main process and is reached through a preload bridge,
          so opening this page in a browser gives it nothing to read.
        </p>
        <p style="margin:0">
          Run <code style="font-family:ui-monospace,monospace;color:#6ea8fe">npm run dev</code>
          from the repo root and use the window it opens.
        </p>
      </div>
    </div>`;
} else {
  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
