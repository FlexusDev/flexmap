import { useEffect, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import type { PerfStats } from "../../store/useAppStore";
import { tauriInvoke, isTauri } from "../../lib/tauri-bridge";
import type { RenderStats, SystemStats, ProjectorStats } from "../../types";
import PerformancePanel from "./PerformancePanel";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ─── Tooltip row ─────────────────────────────────────────────────────────────

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <tr>
      <td className="pr-3 text-aura-text-dim py-px whitespace-nowrap">{label}</td>
      <td className={`text-right py-px tabular-nums whitespace-nowrap ${warn ? "text-aura-warning" : "text-aura-text-dim"}`}>
        {value}
      </td>
    </tr>
  );
}

// ─── Frame perf tooltip (editor preview — IPC-based) ────────────────────────

function PerfTooltip({ label, stats }: { label: string; stats: PerfStats }) {
  return (
    <div className="absolute bottom-full mb-1 right-0 z-50 min-w-[200px] bg-aura-bg border border-aura-border rounded shadow-lg p-2 text-xs font-mono text-aura-text pointer-events-none">
      <div className="font-semibold text-aura-text mb-1 text-[11px] uppercase tracking-wider">{label}</div>
      <table className="w-full">
        <tbody>
          <Row label="FPS" value={`${stats.fps}`} />
          <Row label="Frametime" value={`${stats.frametime} ms`} warn={stats.frametime > 50} />
          <Row label="IPC poll" value={`${stats.pollMs} ms`} warn={stats.pollMs > 30} />
          <Row label="Decode" value={`${stats.decodeMs} ms`} warn={stats.decodeMs > 20} />
          {stats.drawMs > 0 && <Row label="Draw" value={`${stats.drawMs} ms`} />}
          <Row label="Layers" value={`${stats.frameCount}`} />
          <Row label="Payload" value={fmtBytes(stats.totalBytes)} warn={stats.totalBytes > 500_000} />
        </tbody>
      </table>
    </div>
  );
}

// ─── GPU projector tooltip ──────────────────────────────────────────────────

function GpuProjectorTooltip({ stats }: { stats: ProjectorStats }) {
  return (
    <div className="absolute bottom-full mb-1 right-0 z-50 min-w-[200px] bg-aura-bg border border-aura-border rounded shadow-lg p-2 text-xs font-mono text-aura-text pointer-events-none">
      <div className="font-semibold text-aura-text mb-1 text-[11px] uppercase tracking-wider">
        Projector {stats.gpu_native ? "(GPU Direct)" : "(WebView)"}
      </div>
      <table className="w-full">
        <tbody>
          <Row label="FPS" value={`${stats.fps}`} />
          <Row label="Frametime" value={`${stats.frametime_ms.toFixed(1)} ms`} warn={stats.frametime_ms > 20} />
          <Row label="Render" value={stats.gpu_native ? "wgpu → Metal/Vulkan" : "IPC → Canvas2D"} />
          <Row label="Pipeline" value={stats.gpu_native ? "Zero-copy GPU" : "base64 → JS"} />
        </tbody>
      </table>
    </div>
  );
}

// ─── System stats tooltip ────────────────────────────────────────────────────

function SystemTooltip({ gpu, sys }: { gpu: string; sys: SystemStats | null }) {
  return (
    <div className="absolute bottom-full mb-1 right-0 z-50 min-w-[240px] bg-aura-bg border border-aura-border rounded shadow-lg p-2 text-xs font-mono text-aura-text pointer-events-none">
      <div className="font-semibold text-aura-text mb-1 text-[11px] uppercase tracking-wider">System</div>
      <table className="w-full">
        <tbody>
          <Row label="GPU" value={gpu} />
          {sys && (
            <>
              <Row label="CPU" value={sys.cpu_name || "Unknown"} />
              <Row label="Cores" value={`${sys.cpu_count}`} />
              <Row label="CPU usage" value={`${sys.system_cpu.toFixed(1)}%`} warn={sys.system_cpu > 80} />
              <Row label="Process CPU" value={`${sys.process_cpu.toFixed(1)}%`} warn={sys.process_cpu > 100} />
              <Row label="Process mem" value={fmtBytes(sys.process_mem)} warn={sys.process_mem > 1024 * 1024 * 1024} />
              <Row label="System mem" value={`${fmtBytes(sys.used_mem)} / ${fmtBytes(sys.total_mem)}`} />
            </>
          )}
          {!sys && <Row label="" value="Loading..." />}
        </tbody>
      </table>
    </div>
  );
}

// ─── PerfBadge (editor preview) ─────────────────────────────────────────────

function PerfBadge({ label, stats }: { label: string; stats: PerfStats }) {
  const [hovered, setHovered] = useState(false);
  if (stats.fps <= 0) return null;

  const fpsColor =
    stats.fps >= 25 ? "text-aura-success" :
    stats.fps >= 12 ? "text-aura-text" :
    "text-aura-warning";

  return (
    <span
      className="relative cursor-default"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="font-mono tabular-nums">
        {label}:{" "}
        <span className={fpsColor}>{stats.fps}</span>
        <span className="text-aura-text-dim"> fps</span>
        <span className="text-aura-text-dim ml-1">({stats.frametime}ms)</span>
      </span>
      {hovered && <PerfTooltip label={label} stats={stats} />}
    </span>
  );
}

// ─── GPU Projector FPS badge ────────────────────────────────────────────────

function ProjectorBadge() {
  const [hovered, setHovered] = useState(false);
  const [stats, setStats] = useState<ProjectorStats | null>(null);

  // Poll GPU projector stats every 500ms while projector is open
  useEffect(() => {
    let running = true;
    const poll = async () => {
      while (running) {
        try {
          const s = await tauriInvoke<ProjectorStats>("get_projector_stats");
          if (running) setStats(s);
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    };
    poll();
    return () => { running = false; };
  }, []);

  if (!stats || stats.fps <= 0) {
    // Fall back to JS-based projector perf if GPU projector isn't active
    return <ProjectorBadgeFallback />;
  }

  const fpsColor =
    stats.fps >= 50 ? "text-aura-success" :
    stats.fps >= 25 ? "text-aura-text" :
    "text-aura-warning";

  return (
    <span
      className="relative cursor-default"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="font-mono tabular-nums">
        Projector:{" "}
        <span className={fpsColor}>{stats.fps}</span>
        <span className="text-aura-text-dim"> fps</span>
        <span className="text-aura-text-dim ml-1">({stats.frametime_ms.toFixed(1)}ms)</span>
        {stats.gpu_native && (
          <span className="text-aura-success ml-1">GPU</span>
        )}
      </span>
      {hovered && <GpuProjectorTooltip stats={stats} />}
    </span>
  );
}

// ─── Fallback: JS-based projector perf (when GPU native isn't active) ───────

function ProjectorBadgeFallback() {
  const projectorPerf = useAppStore((s) => s.projectorPerf);
  const setProjectorPerf = useAppStore((s) => s.setProjectorPerf);
  const [hovered, setHovered] = useState(false);

  // Listen for projector perf events from the webview projector window
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<PerfStats>(
          "projector-perf",
          (event) => setProjectorPerf(event.payload)
        );
      } catch { /* ignore */ }
    })();

    return () => { unlisten?.(); };
  }, [setProjectorPerf]);

  if (projectorPerf.fps <= 0) return null;

  const fpsColor =
    projectorPerf.fps >= 25 ? "text-aura-success" :
    projectorPerf.fps >= 12 ? "text-aura-text" :
    "text-aura-warning";

  return (
    <span
      className="relative cursor-default"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span className="font-mono tabular-nums">
        Projector:{" "}
        <span className={fpsColor}>{projectorPerf.fps}</span>
        <span className="text-aura-text-dim"> fps</span>
        <span className="text-aura-text-dim ml-1">({projectorPerf.frametime}ms)</span>
      </span>
      {hovered && <PerfTooltip label="Projector" stats={projectorPerf} />}
    </span>
  );
}

// ─── GpuBadge with system stats on hover ─────────────────────────────────────

function GpuBadge({ gpuInfo }: { gpuInfo: RenderStats }) {
  const [hovered, setHovered] = useState(false);
  const [sysStats, setSysStats] = useState<SystemStats | null>(null);

  // Poll system stats while hovered
  useEffect(() => {
    if (!hovered) return;

    let running = true;

    const poll = async () => {
      while (running) {
        try {
          const stats = await tauriInvoke<SystemStats>("get_system_stats");
          if (running) setSysStats(stats);
        } catch {
          // ignore
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    };

    poll();
    return () => { running = false; };
  }, [hovered]);

  return (
    <span
      className={`relative cursor-default ${gpuInfo.gpu_ready ? "text-aura-text-dim" : "text-aura-warning"}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {gpuInfo.gpu_ready ? `GPU: ${gpuInfo.gpu_name}` : gpuInfo.gpu_name}
      {hovered && gpuInfo.gpu_ready && (
        <SystemTooltip gpu={gpuInfo.gpu_name} sys={sysStats} />
      )}
    </span>
  );
}

// ─── StatusBar ───────────────────────────────────────────────────────────────

function StatusBar() {
  const {
    layers,
    selectedLayerId,
    selectedLayerIds,
    sources,
    monitors,
    projectorWindowOpen,
    isDirty,
    calibrationEnabled,
    snapEnabled,
    editorSelectionMode,
    project,
    editorPerf,
    performancePanelOpen,
    togglePerformancePanel,
  } = useAppStore();

  const [gpuInfo, setGpuInfo] = useState<RenderStats | null>(null);

  // Poll GPU status until it's ready, then stop
  useEffect(() => {
    const poll = async () => {
      try {
        const stats = await tauriInvoke<RenderStats>("get_render_stats");
        setGpuInfo(stats);
        if (stats.gpu_ready) return true;
      } catch { /* ignore */ }
      return false;
    };

    poll();
    const interval = setInterval(async () => {
      const ready = await poll();
      if (ready) clearInterval(interval);
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  const output = project?.output;
  const selectedLayer = selectedLayerId
    ? layers.find((l) => l.id === selectedLayerId) ?? null
    : null;
  const selectedCount = selectedLayerIds.length > 0
    ? selectedLayerIds.length
    : selectedLayer
      ? 1
      : 0;
  const isUvLike = editorSelectionMode === "uv" && !!selectedLayer;
  const modeLabel = selectedCount !== 1
    ? "SHAPE"
    : !isUvLike
    ? "SHAPE"
    : selectedLayer?.geometry.type === "Mesh"
      ? "UV"
      : "INPUT";

  return (
    <div className="flex items-center h-6 px-3 bg-aura-surface border-t border-aura-border text-xs text-aura-text-dim gap-4">
      <span>{layers.length} layer{layers.length !== 1 ? "s" : ""}</span>
      <span>{sources.length} source{sources.length !== 1 ? "s" : ""}</span>
      <span>{monitors.length} monitor{monitors.length !== 1 ? "s" : ""}</span>
      <span>
        {selectedCount} selected
        {selectedLayer && selectedCount > 0 ? ` · primary: ${selectedLayer.name}` : ""}
      </span>

      {output && (
        <span>
          {output.width}x{output.height}@{output.framerate}
        </span>
      )}

      <div className="flex-1" />

      {/* Performance badges with hover tooltip */}
      <PerfBadge label="Preview" stats={editorPerf} />
      {projectorWindowOpen && <ProjectorBadge />}

      <span className="text-aura-border">|</span>

      {/* GPU badge — click to toggle Performance panel */}
      {gpuInfo && (
        <span
          className="cursor-pointer hover:text-aura-text transition-colors"
          onClick={togglePerformancePanel}
          title="Toggle Performance panel"
        >
          <GpuBadge gpuInfo={gpuInfo} />
        </span>
      )}

      {/* Performance panel flyout */}
      {performancePanelOpen && <PerformancePanel />}

      <span
        className={
          modeLabel === "UV"
            ? "text-amber-400 font-medium"
            : modeLabel === "INPUT"
              ? "text-cyan-300 font-medium"
              : "text-indigo-300 font-medium"
        }
      >
        MODE: {modeLabel}
      </span>
      {snapEnabled && (
        <span className="text-cyan-400 font-medium">SNAP</span>
      )}
      {calibrationEnabled && (
        <span className="text-amber-400 font-medium">CALIBRATION</span>
      )}
      {projectorWindowOpen && (
        <span className="text-aura-success font-medium">PROJECTOR LIVE</span>
      )}
      {isDirty && <span className="text-aura-warning">Unsaved changes</span>}
    </div>
  );
}

export default StatusBar;
