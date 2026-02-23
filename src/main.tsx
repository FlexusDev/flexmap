import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ProjectorView from "./components/output/ProjectorView";
import "./styles/globals.css";

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

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isGpuProjector ? <GpuProjectorView /> :
     isProjector ? <ProjectorView /> :
     <App />}
  </React.StrictMode>
);
