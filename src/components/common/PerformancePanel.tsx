import { useState, useEffect, useCallback } from "react";
import { useAppStore } from "../../store/useAppStore";
import { tauriInvoke } from "../../lib/tauri-bridge";
import type { RenderStats, SourceDiagnostics, FramePacingMode } from "../../types";

const PACING_MODES: { value: FramePacingMode; label: string; desc: string }[] = [
  { value: "show", label: "Show", desc: "VSync — smooth, no tearing" },
  { value: "lowLatency", label: "Low Latency", desc: "Mailbox — skip old frames" },
  { value: "benchmark", label: "Benchmark", desc: "Immediate — uncapped FPS" },
];

function PerformancePanel() {
  const { framePacingMode, setFramePacing, togglePerformancePanel } = useAppStore();
  const [renderStats, setRenderStats] = useState<RenderStats | null>(null);
  const [sourceDiag, setSourceDiag] = useState<SourceDiagnostics[]>([]);

  const refresh = useCallback(async () => {
    try {
      const [stats, diag] = await Promise.all([
        tauriInvoke<RenderStats>("get_render_stats"),
        tauriInvoke<SourceDiagnostics[]>("get_source_diagnostics"),
      ]);
      setRenderStats(stats);
      setSourceDiag(diag);
    } catch {
      // ignore polling errors
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 2000);
    return () => clearInterval(interval);
  }, [refresh]);

  const cacheTotal =
    (renderStats?.buffer_cache_hits ?? 0) + (renderStats?.buffer_cache_misses ?? 0);
  const cacheHitRate =
    cacheTotal > 0
      ? ((renderStats?.buffer_cache_hits ?? 0) / cacheTotal * 100).toFixed(1)
      : "—";

  return (
    <div className="absolute bottom-7 right-2 z-50 w-80 bg-aura-bg border border-aura-border rounded-lg shadow-xl text-xs font-mono text-aura-text overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-aura-surface border-b border-aura-border">
        <span className="text-[11px] font-semibold uppercase tracking-wider">Performance</span>
        <button
          onClick={togglePerformancePanel}
          className="text-aura-text-dim hover:text-aura-text transition-colors"
        >
          &times;
        </button>
      </div>

      <div className="p-3 space-y-3 max-h-96 overflow-y-auto">
        {/* Frame Pacing */}
        <Section title="Frame Pacing">
          <div className="flex gap-1">
            {PACING_MODES.map((m) => (
              <button
                key={m.value}
                onClick={() => setFramePacing(m.value)}
                className={`flex-1 px-2 py-1.5 rounded text-[10px] transition-colors ${
                  framePacingMode === m.value
                    ? "bg-aura-accent text-white"
                    : "bg-aura-surface text-aura-text-dim hover:text-aura-text"
                }`}
                title={m.desc}
              >
                {m.label}
              </button>
            ))}
          </div>
        </Section>

        {/* GPU Info */}
        {renderStats?.gpu_ready && (
          <Section title="GPU">
            <InfoRow label="Adapter" value={renderStats.gpu_name} />
            <InfoRow label="Backend" value={renderStats.gpu_backend} />
            <InfoRow label="Device" value={renderStats.gpu_device_type} />
            {renderStats.gpu_driver && (
              <InfoRow label="Driver" value={renderStats.gpu_driver} />
            )}
          </Section>
        )}

        {/* Sources */}
        <Section title={`Sources (${sourceDiag.length})`}>
          {sourceDiag.length === 0 ? (
            <div className="text-aura-text-dim py-1">No active sources</div>
          ) : (
            <div className="space-y-1.5">
              {sourceDiag.map((s) => (
                <div
                  key={s.source_id}
                  className="bg-aura-surface rounded px-2 py-1.5"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-aura-text truncate">{s.name}</span>
                    <span className="text-aura-text-dim text-[10px] ml-2 uppercase">
                      {s.protocol}
                    </span>
                  </div>
                  <div className="flex gap-3 text-aura-text-dim text-[10px] mt-0.5">
                    {s.width && s.height && (
                      <span>{s.width}x{s.height}</span>
                    )}
                    {s.fps && <span>{s.fps} fps</span>}
                    <span>
                      {s.layers_using.length} layer{s.layers_using.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Cache */}
        {renderStats?.gpu_ready && (
          <Section title="Buffer Cache">
            <InfoRow label="Source textures" value={`${renderStats.texture_count}`} />
            <InfoRow label="Cache hits" value={`${renderStats.buffer_cache_hits}`} />
            <InfoRow label="Cache misses" value={`${renderStats.buffer_cache_misses}`} />
            <InfoRow label="Hit rate" value={`${cacheHitRate}%`} />
          </Section>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-aura-text-dim mb-1.5 font-semibold">
        {title}
      </div>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-px">
      <span className="text-aura-text-dim">{label}</span>
      <span className="text-aura-text tabular-nums">{value}</span>
    </div>
  );
}

export default PerformancePanel;
