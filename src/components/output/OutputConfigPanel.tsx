import { useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { tauriInvoke } from "../../lib/tauri-bridge";
import type { OutputConfig } from "../../types";

const PRESETS: { label: string; width: number; height: number }[] = [
  { label: "1920x1080 (1080p)", width: 1920, height: 1080 },
  { label: "2560x1440 (1440p)", width: 2560, height: 1440 },
  { label: "3840x2160 (4K)", width: 3840, height: 2160 },
  { label: "1024x768 (XGA)", width: 1024, height: 768 },
  { label: "1280x800 (WXGA)", width: 1280, height: 800 },
];

function OutputConfigPanel() {
  const { project, monitors, setOutputConfig, refreshMonitors } = useAppStore();
  const [open, setOpen] = useState(false);

  if (!project) return null;

  const config = project.output;

  const update = (partial: Partial<OutputConfig>) => {
    setOutputConfig({ ...config, ...partial });
  };

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen(!open);
          refreshMonitors();
        }}
        className="btn-ghost text-xs"
        title="Output Settings"
      >
        Output
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 bg-aura-surface border border-aura-border rounded-lg shadow-xl z-50 p-3 w-72">
          <div className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim mb-3">
            Output Configuration
          </div>

          {/* Resolution presets */}
          <label className="text-xs text-aura-text-dim block mb-1">Resolution</label>
          <select
            value={`${config.width}x${config.height}`}
            onChange={(e) => {
              const preset = PRESETS.find(
                (p) => `${p.width}x${p.height}` === e.target.value
              );
              if (preset) {
                update({ width: preset.width, height: preset.height });
              }
            }}
            className="input w-full text-xs mb-3"
          >
            {PRESETS.map((p) => (
              <option key={`${p.width}x${p.height}`} value={`${p.width}x${p.height}`}>
                {p.label}
              </option>
            ))}
          </select>

          {/* Framerate */}
          <label className="text-xs text-aura-text-dim block mb-1">Framerate</label>
          <select
            value={config.framerate}
            onChange={(e) => update({ framerate: parseInt(e.target.value) })}
            className="input w-full text-xs mb-3"
          >
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
            <option value={120}>120 fps</option>
          </select>

          {/* Monitor preference */}
          <label className="text-xs text-aura-text-dim block mb-1">Monitor</label>
          <select
            value={config.monitor_preference ?? ""}
            onChange={(e) => {
              const monitorName = e.target.value || null;
              update({ monitor_preference: monitorName });
              tauriInvoke("retarget_projector", { monitorName }).catch(() => {});
            }}
            className="input w-full text-xs mb-2"
          >
            <option value="">Auto (any external)</option>
            {monitors.map((m) => (
              <option key={m.name ?? "unknown"} value={m.name ?? ""}>
                {m.name ?? "Unknown"} ({m.width}x{m.height})
              </option>
            ))}
          </select>

          <div className="text-xs text-aura-text-dim mt-2">
            {config.width}x{config.height} @ {config.framerate}fps
          </div>
        </div>
      )}
    </div>
  );
}

export default OutputConfigPanel;
