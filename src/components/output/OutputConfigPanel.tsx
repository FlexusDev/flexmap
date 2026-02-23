import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../store/useAppStore";
import { tauriInvoke } from "../../lib/tauri-bridge";
import type { AspectRatioId, AspectRatioUiState, OutputConfig } from "../../types";
import {
  COMMON_ASPECT_RATIOS,
  computeHeightFromWidth,
  computeWidthFromHeight,
  findAspectRatioByDimensions,
  resolveAspectRatioUiState,
  withAspectRatioUiState,
} from "../../lib/aspect-ratios";

const PRESETS: { label: string; width: number; height: number }[] = [
  { label: "1920x1080 (1080p)", width: 1920, height: 1080 },
  { label: "2560x1440 (1440p)", width: 2560, height: 1440 },
  { label: "3840x2160 (4K)", width: 3840, height: 2160 },
  { label: "1024x768 (XGA)", width: 1024, height: 768 },
  { label: "1280x800 (WXGA)", width: 1280, height: 800 },
];
const FALLBACK_OUTPUT: OutputConfig = {
  width: 1920,
  height: 1080,
  framerate: 60,
  monitor_preference: null,
};

function parseDimension(value: string): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  if (rounded < 1) return null;
  return rounded;
}

function OutputConfigPanel() {
  const {
    project,
    monitors,
    projectorWindowOpen,
    setOutputConfig,
    setProjectUiState,
    refreshMonitors,
  } = useAppStore();
  const [open, setOpen] = useState(false);
  const [widthText, setWidthText] = useState("");
  const [heightText, setHeightText] = useState("");
  const [mainFullscreen, setMainFullscreen] = useState(false);
  const [projectorFullscreen, setProjectorFullscreen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const config = project?.output ?? FALLBACK_OUTPUT;
  const aspectState = useMemo(
    () => resolveAspectRatioUiState(project?.uiState ?? null, config),
    [project?.uiState, config.width, config.height]
  );
  const selectedPresetValue = useMemo(() => {
    return PRESETS.find((p) => p.width === config.width && p.height === config.height)
      ? `${config.width}x${config.height}`
      : "custom";
  }, [config.width, config.height]);

  useEffect(() => {
    setWidthText(String(config.width));
    setHeightText(String(config.height));
  }, [config.width, config.height]);

  useEffect(() => {
    if (!open) return;
    let active = true;

    void tauriInvoke<boolean>("get_main_window_fullscreen")
      .then((value) => {
        if (active) setMainFullscreen(value);
      })
      .catch(() => {});

    if (projectorWindowOpen) {
      void tauriInvoke<boolean>("get_projector_fullscreen")
        .then((value) => {
          if (active) setProjectorFullscreen(value);
        })
        .catch(() => {});
    } else {
      setProjectorFullscreen(false);
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current && !rootRef.current.contains(target)) {
        setOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      active = false;
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open, projectorWindowOpen]);

  const updateOutput = (partial: Partial<OutputConfig>) => {
    if (!project) return;
    void setOutputConfig({ ...config, ...partial });
  };

  const updateAspectState = (next: AspectRatioUiState) => {
    if (!project) return;
    const uiState = withAspectRatioUiState(project.uiState, next);
    void setProjectUiState(uiState);
  };

  const commitWidth = (raw: string) => {
    const width = parseDimension(raw);
    if (width === null) {
      setWidthText(String(config.width));
      return;
    }

    setWidthText(String(width));
    if (aspectState.lockEnabled) {
      const height = computeHeightFromWidth(width, aspectState.ratioId);
      setHeightText(String(height));
      updateOutput({ width, height });
      return;
    }
    updateOutput({ width });
  };

  const commitHeight = (raw: string) => {
    const height = parseDimension(raw);
    if (height === null) {
      setHeightText(String(config.height));
      return;
    }

    setHeightText(String(height));
    if (aspectState.lockEnabled) {
      const width = computeWidthFromHeight(height, aspectState.ratioId);
      setWidthText(String(width));
      updateOutput({ width, height });
      return;
    }
    updateOutput({ height });
  };

  if (!project) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => {
          setOpen(!open);
          void refreshMonitors();
        }}
        className="btn-ghost text-xs"
        title="Output Settings"
      >
        Output
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 bg-aura-surface border border-aura-border rounded-lg shadow-xl z-50 p-3 w-80">
          <div className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim mb-3">
            Output Configuration
          </div>

          <label className="text-xs text-aura-text-dim block mb-1">Resolution Preset</label>
          <select
            value={selectedPresetValue}
            onChange={(e) => {
              const preset = PRESETS.find(
                (p) => `${p.width}x${p.height}` === e.target.value
              );
              if (!preset) return;
              updateOutput({ width: preset.width, height: preset.height });
              setWidthText(String(preset.width));
              setHeightText(String(preset.height));
              const matched = findAspectRatioByDimensions(preset.width, preset.height);
              if (matched) {
                updateAspectState({ ...aspectState, ratioId: matched.id });
              }
            }}
            className="input w-full text-xs mb-3"
          >
            {PRESETS.map((p) => (
              <option key={`${p.width}x${p.height}`} value={`${p.width}x${p.height}`}>
                {p.label}
              </option>
            ))}
            <option value="custom">
              Custom ({config.width}x{config.height})
            </option>
          </select>

          <div className="grid grid-cols-2 gap-2 mb-3">
            <div>
              <label className="text-xs text-aura-text-dim block mb-1">Width</label>
              <input
                value={widthText}
                onChange={(e) => setWidthText(e.target.value)}
                onBlur={() => commitWidth(widthText)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitWidth(widthText);
                }}
                className="input w-full text-xs"
                inputMode="numeric"
                aria-label="Output width"
              />
            </div>
            <div>
              <label className="text-xs text-aura-text-dim block mb-1">Height</label>
              <input
                value={heightText}
                onChange={(e) => setHeightText(e.target.value)}
                onBlur={() => commitHeight(heightText)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitHeight(heightText);
                }}
                className="input w-full text-xs"
                inputMode="numeric"
                aria-label="Output height"
              />
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 mb-2">
            <label className="text-xs text-aura-text-dim">Aspect Ratio Lock</label>
            <button
              type="button"
              onClick={() => {
                const nextLockEnabled = !aspectState.lockEnabled;
                const next = { ...aspectState, lockEnabled: nextLockEnabled };
                updateAspectState(next);
                if (nextLockEnabled) {
                  const nextHeight = computeHeightFromWidth(config.width, next.ratioId);
                  setHeightText(String(nextHeight));
                  updateOutput({ height: nextHeight });
                }
              }}
              className={`px-2 py-1 rounded text-xs border transition-colors ${
                aspectState.lockEnabled
                  ? "border-aura-accent bg-aura-accent/20 text-aura-text"
                  : "border-aura-border text-aura-text-dim hover:text-aura-text"
              }`}
            >
              {aspectState.lockEnabled ? "Locked" : "Unlocked"}
            </button>
          </div>

          <label className="text-xs text-aura-text-dim block mb-1">Aspect Ratio</label>
          <select
            value={aspectState.ratioId}
            onChange={(e) => {
              const ratioId = e.target.value as AspectRatioId;
              const next = { ...aspectState, ratioId };
              updateAspectState(next);
              if (next.lockEnabled) {
                const nextHeight = computeHeightFromWidth(config.width, ratioId);
                setHeightText(String(nextHeight));
                updateOutput({ height: nextHeight });
              }
            }}
            className="input w-full text-xs mb-3"
          >
            {COMMON_ASPECT_RATIOS.map((ratio) => (
              <option key={ratio.id} value={ratio.id}>
                {ratio.label}
              </option>
            ))}
          </select>

          <label className="text-xs text-aura-text-dim block mb-1">Framerate</label>
          <select
            value={config.framerate}
            onChange={(e) => updateOutput({ framerate: parseInt(e.target.value, 10) })}
            className="input w-full text-xs mb-3"
          >
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
            <option value={120}>120 fps</option>
          </select>

          <label className="text-xs text-aura-text-dim block mb-1">Monitor</label>
          <select
            value={config.monitor_preference ?? ""}
            onChange={(e) => {
              const monitorName = e.target.value || null;
              updateOutput({ monitor_preference: monitorName });
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

          <div className="flex items-center justify-between gap-2 mt-3">
            <label className="text-xs text-aura-text-dim">Main Window</label>
            <button
              type="button"
              onClick={() => {
                const next = !mainFullscreen;
                void tauriInvoke<void>("set_main_window_fullscreen", { fullscreen: next })
                  .then(() => setMainFullscreen(next))
                  .catch(() => {});
              }}
              className="px-2 py-1 rounded text-xs border border-aura-border text-aura-text-dim hover:text-aura-text transition-colors"
            >
              {mainFullscreen ? "Exit Fullscreen" : "Fullscreen"}
            </button>
          </div>

          <div className="flex items-center justify-between gap-2 mt-2">
            <label className="text-xs text-aura-text-dim">Projector Window</label>
            <button
              type="button"
              disabled={!projectorWindowOpen}
              onClick={() => {
                const next = !projectorFullscreen;
                void tauriInvoke<void>("set_projector_fullscreen", { fullscreen: next })
                  .then(() => setProjectorFullscreen(next))
                  .catch(() => {});
              }}
              className={`px-2 py-1 rounded text-xs border transition-colors ${
                projectorWindowOpen
                  ? "border-aura-border text-aura-text-dim hover:text-aura-text"
                  : "border-aura-border text-aura-text-dim/40 cursor-not-allowed"
              }`}
            >
              {!projectorWindowOpen
                ? "Projector Closed"
                : projectorFullscreen
                  ? "Exit Fullscreen"
                  : "Fullscreen"}
            </button>
          </div>

          <div className="text-xs text-aura-text-dim mt-2">
            {config.width}x{config.height} @ {config.framerate}fps
          </div>
        </div>
      )}
    </div>
  );
}

export default OutputConfigPanel;
