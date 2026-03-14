import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../store/useAppStore";
import { getGitHubToken, setGitHubToken } from "../../lib/shader-library";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

function SettingsModal({ open, onClose }: SettingsModalProps) {
  const {
    audioInputDevices,
    selectedAudioInputId,
    bpmConfig,
    bpmState,
    setAudioInputDevice,
    setBpmConfig,
    refreshBpmState,
    tapTempo,
    performanceProfile,
    setPerformanceProfile,
    previewQuality,
    setPreviewQuality,
    project,
  } = useAppStore(useShallow((s) => ({
    audioInputDevices: s.audioInputDevices,
    selectedAudioInputId: s.selectedAudioInputId,
    bpmConfig: s.bpmConfig,
    bpmState: s.bpmState,
    setAudioInputDevice: s.setAudioInputDevice,
    setBpmConfig: s.setBpmConfig,
    refreshBpmState: s.refreshBpmState,
    tapTempo: s.tapTempo,
    performanceProfile: s.performanceProfile,
    setPerformanceProfile: s.setPerformanceProfile,
    previewQuality: s.previewQuality,
    setPreviewQuality: s.setPreviewQuality,
    project: s.project,
  })));

  useEffect(() => {
    if (!open) return;
    let running = true;
    const tick = async () => {
      while (running) {
        await refreshBpmState();
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    };
    tick();
    return () => {
      running = false;
    };
  }, [open, refreshBpmState]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-2xl bg-aura-surface border border-aura-border rounded-lg shadow-2xl flex flex-col"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-aura-border">
          <div>
            <div className="text-sm font-semibold text-aura-text">Settings</div>
            <div className="text-[11px] text-aura-text-dim">Display / Audio / BPM</div>
          </div>
          <button className="btn-ghost text-xs px-3 py-1" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="p-4 space-y-4">
          <PerformanceProfileSection
            profile={performanceProfile}
            onChange={setPerformanceProfile}
          />

          <PreviewQualitySection
            quality={previewQuality}
            onChange={(q) => void setPreviewQuality(q)}
            outputWidth={project?.output.width ?? 1920}
            outputHeight={project?.output.height ?? 1080}
          />

          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-aura-text-dim">
              Input Device
              <select
                className="input mt-1 w-full text-xs"
                value={selectedAudioInputId ?? ""}
                onChange={(event) => void setAudioInputDevice(event.target.value || null)}
              >
                <option value="">None</option>
                {audioInputDevices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name}
                    {device.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="text-xs text-aura-text-dim flex items-center justify-between border border-aura-border rounded px-3">
              <span>BPM Engine</span>
              <button
                type="button"
                className={`px-2 py-1 rounded text-[11px] ${
                  bpmConfig.enabled
                    ? "bg-emerald-600 text-white"
                    : "bg-aura-hover text-aura-text-dim"
                }`}
                onClick={() => void setBpmConfig({ enabled: !bpmConfig.enabled })}
              >
                {bpmConfig.enabled ? "Enabled" : "Disabled"}
              </button>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <RangeControl
              label="Sensitivity"
              min={0.1}
              max={3}
              step={0.01}
              value={bpmConfig.sensitivity}
              onChange={(value) => void setBpmConfig({ sensitivity: value })}
            />
            <RangeControl
              label="Gate"
              min={0.01}
              max={1}
              step={0.01}
              value={bpmConfig.gate}
              onChange={(value) => void setBpmConfig({ gate: value })}
            />
            <RangeControl
              label="Smoothing"
              min={0}
              max={0.98}
              step={0.01}
              value={bpmConfig.smoothing}
              onChange={(value) => void setBpmConfig({ smoothing: value })}
            />
            <RangeControl
              label="Attack"
              min={0.05}
              max={1}
              step={0.01}
              value={bpmConfig.attack}
              onChange={(value) => void setBpmConfig({ attack: value })}
            />
            <RangeControl
              label="Decay"
              min={0.05}
              max={0.99}
              step={0.01}
              value={bpmConfig.decay}
              onChange={(value) => void setBpmConfig({ decay: value })}
            />
            <RangeControl
              label="Manual BPM"
              min={40}
              max={220}
              step={1}
              value={bpmConfig.manualBpm}
              onChange={(value) => void setBpmConfig({ manualBpm: value })}
            />
          </div>

          <div className="border border-aura-border rounded p-3 bg-aura-bg/40">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-aura-text">Calibration Meter</div>
              <button className="btn-ghost text-xs px-2 py-1" onClick={() => void tapTempo()}>
                Tap Tempo
              </button>
            </div>
            <div className="h-2 rounded bg-aura-hover overflow-hidden mb-2">
              <div
                className="h-full bg-emerald-400 transition-[width] duration-100"
                style={{ width: `${Math.max(0, Math.min(100, bpmState.level * 100))}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-aura-text-dim">
              <span>BPM: {bpmState.bpm.toFixed(1)}</span>
              <span>Phase: {bpmState.phase.toFixed(2)}</span>
              <span>Beat: {bpmState.beat.toFixed(2)}</span>
              <span>{bpmState.running ? "Input active" : "Input idle"}</span>
            </div>
          </div>

          <GitHubTokenSection />
        </div>
      </div>
    </div>
  );
}

interface RangeControlProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
}

function RangeControl({ label, min, max, step, value, onChange }: RangeControlProps) {
  return (
    <label className="text-xs text-aura-text-dim">
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <span className="font-mono text-aura-text text-[11px]">{value.toFixed(2)}</span>
      </div>
      <input
        type="range"
        className="slider w-full mt-1"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(parseFloat(event.target.value))}
      />
    </label>
  );
}

const QUALITY_PRESETS = [
  { value: 0.25, label: "25%", tag: "Low" },
  { value: 0.5, label: "50%", tag: "Medium" },
  { value: 0.75, label: "75%", tag: "High" },
  { value: 1.0, label: "100%", tag: "Full" },
] as const;

const PERFORMANCE_PROFILES = [
  {
    value: "balanced",
    label: "Balanced",
    tag: "Stable",
    description: "Lower preview traffic and CPU load for live sets.",
  },
  {
    value: "max_fps",
    label: "Max FPS",
    tag: "Smoothest",
    description: "Higher preview update rate with more CPU/GPU work.",
  },
] as const;

interface PerformanceProfileSectionProps {
  profile: "balanced" | "max_fps";
  onChange: (profile: "balanced" | "max_fps") => void;
}

function PerformanceProfileSection({
  profile,
  onChange,
}: PerformanceProfileSectionProps) {
  return (
    <div className="border border-aura-border rounded p-3 bg-aura-bg/40">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-aura-text">Performance Mode</div>
        <div className="text-[11px] text-aura-text-dim">
          Use `Balanced` for dense scenes and live playback.
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {PERFORMANCE_PROFILES.map((preset) => (
          <button
            key={preset.value}
            type="button"
            className={`rounded px-3 py-2 text-left transition-colors ${
              profile === preset.value
                ? "bg-emerald-600 text-white"
                : "bg-aura-hover text-aura-text-dim hover:text-aura-text"
            }`}
            onClick={() => onChange(preset.value)}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium">{preset.label}</span>
              <span className="text-[10px] opacity-75">{preset.tag}</span>
            </div>
            <div className="mt-1 text-[10px] opacity-80">{preset.description}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

interface PreviewQualitySectionProps {
  quality: number;
  onChange: (quality: number) => void;
  outputWidth: number;
  outputHeight: number;
}

function PreviewQualitySection({
  quality,
  onChange,
  outputWidth,
  outputHeight,
}: PreviewQualitySectionProps) {
  const previewWidth = Math.round(outputWidth * quality);
  const previewHeight = Math.round(outputHeight * quality);
  const pct = Math.round(quality * 100);

  return (
    <div className="border border-aura-border rounded p-3 bg-aura-bg/40">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs text-aura-text">Preview Quality</div>
        <div className="text-[11px] text-aura-text-dim font-mono">
          {previewWidth}x{previewHeight} ({pct}%)
        </div>
      </div>
      <div className="flex gap-2">
        {QUALITY_PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            className={`flex-1 px-2 py-1.5 rounded text-[11px] transition-colors ${
              quality === preset.value
                ? "bg-emerald-600 text-white"
                : "bg-aura-hover text-aura-text-dim hover:text-aura-text"
            }`}
            onClick={() => onChange(preset.value)}
          >
            <div className="font-medium">{preset.label}</div>
            <div className="text-[10px] opacity-70">{preset.tag}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function GitHubTokenSection() {
  const [token, setToken] = useState(() => getGitHubToken() ?? "");
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setGitHubToken(token.trim() || null);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="border border-aura-border rounded p-3 bg-aura-bg/40">
      <div className="text-xs text-aura-text mb-2">GitHub Token (ISF Catalog)</div>
      <div className="text-[11px] text-aura-text-dim mb-2">
        Optional. Raises the GitHub API rate limit from 60 to 5,000 requests/hour.
        Create a fine-grained token with no special permissions.
      </div>
      <div className="flex items-center gap-2">
        <input
          type="password"
          className="flex-1 bg-aura-bg border border-aura-border rounded px-3 py-1.5 text-xs text-aura-text outline-none focus:border-aura-success font-mono"
          placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setSaved(false);
          }}
        />
        <button
          className="btn-ghost text-xs px-3 py-1.5"
          onClick={handleSave}
        >
          {saved ? "Saved" : "Save"}
        </button>
        {token.length > 0 && (
          <button
            className="btn-ghost text-xs px-2 py-1.5 text-red-400"
            onClick={() => {
              setToken("");
              setGitHubToken(null);
              setSaved(false);
            }}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

export default SettingsModal;
