import React from "react";
import ReactDOM from "react-dom/client";
import {
  error as tauriError,
  warn as tauriWarn,
  info as tauriInfo,
  debug as tauriDebug,
  attachLogger,
  LogLevel,
} from "@tauri-apps/plugin-log";
import App from "./App";
import ProjectorView from "./components/output/ProjectorView";
import { isTauri } from "./lib/tauri-bridge";
import "./styles/globals.css";

// Format console args for the log plugin (single string)
function formatLogArgs(...args: unknown[]): string {
  return args
    .map((a) => (typeof a === "object" && a !== null ? JSON.stringify(a) : String(a)))
    .join(" ");
}

// Pipe frontend console → terminal, and backend Rust logs → browser devtools.
// Must be called before rendering so all React logs are captured.
async function setupTauriLogForwarding() {
  if (!isTauri) return;

  // Capture originals before any overrides so we can call them without recursion.
  const origLog   = console.log.bind(console);
  const origDebug = console.debug.bind(console);
  const origInfo  = console.info.bind(console);
  const origWarn  = console.warn.bind(console);
  const origError = console.error.bind(console);

  const onFail = (err: unknown) =>
    origError("[log-fwd] Failed to forward to Rust:", err);

  // ── Frontend → terminal ────────────────────────────────────────────────
  // Every console method calls its original (browser devtools) AND sends an
  // IPC log record to the Rust process so it appears in the cargo tauri dev
  // terminal alongside backend log output.
  console.log   = (...a) => { origLog(...a);   tauriInfo (formatLogArgs(...a)).catch(onFail); };
  console.debug = (...a) => { origDebug(...a); tauriDebug(formatLogArgs(...a)).catch(onFail); };
  console.info  = (...a) => { origInfo(...a);  tauriInfo (formatLogArgs(...a)).catch(onFail); };
  console.warn  = (...a) => { origWarn(...a);  tauriWarn (formatLogArgs(...a)).catch(onFail); };
  console.error = (...a) => { origError(...a); tauriError(formatLogArgs(...a)).catch(onFail); };

  window.onerror = (_msg, _src, _line, _col, err) => {
    const text = err?.stack ?? `${String(_msg)} at ${String(_src)}:${_line}:${_col}`;
    tauriError(`[window.onerror] ${text}`).catch(onFail);
  };
  window.onunhandledrejection = (e) => {
    tauriError(`[unhandledrejection] ${String(e.reason)}`).catch(onFail);
  };

  // ── Backend → browser devtools ─────────────────────────────────────────
  // The Rust side emits log://log events for the Webview target (configured
  // in lib.rs with a filter that excludes frontend logs to prevent echoing).
  // We pipe those events to the *original* console methods so we see Rust
  // logs in the browser devtools without triggering the overrides above.
  attachLogger(({ level, message }) => {
    switch (level) {
      case LogLevel.Trace: origDebug("[rust/trace]", message); break;
      case LogLevel.Debug: origDebug("[rust]", message);       break;
      case LogLevel.Info:  origInfo ("[rust]", message);       break;
      case LogLevel.Warn:  origWarn ("[rust]", message);       break;
      case LogLevel.Error: origError("[rust]", message);       break;
    }
  }).catch(() => {
    // Webview target not enabled on Rust side — backend→devtools is disabled.
  });

  tauriInfo("Frontend log forwarding active").catch(onFail);
}

// Simple hash-based routing for main vs projector window
const hash = window.location.hash;
const isProjector = hash === "#/projector";
const isGpuProjector = hash === "#/projector-gpu";

function GpuProjectorView() {
  // Minimal transparent view — wgpu renders directly to the window surface underneath
  return (
    <div style={{
      width: "100vw",
      height: "100vh",
      background: "transparent",
      pointerEvents: "none",
    }} />
  );
}

function renderApp() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {isGpuProjector ? <GpuProjectorView /> :
       isProjector ? <ProjectorView /> :
       <App />}
    </React.StrictMode>
  );
}

// In Tauri: set up log forwarding first so browser errors (e.g. WebGL context) show in terminal, then render
if (isTauri) {
  setupTauriLogForwarding().then(renderApp);
} else {
  renderApp();
}
