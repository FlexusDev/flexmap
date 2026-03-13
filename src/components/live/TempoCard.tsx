import { useEffect, useRef, useState, useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../store/useAppStore";

const SPEED_STEPS = [
  { value: 0.0625, label: "4 Bar" },
  { value: 0.125, label: "2 Bar" },
  { value: 0.25, label: "1 Bar" },
  { value: 0.5, label: "1/2" },
  { value: 1, label: "Beat" },
  { value: 2, label: "1/8" },
  { value: 4, label: "1/16" },
];

function sliderToValue(t: number): number {
  const minLog = Math.log(0.0625);
  const maxLog = Math.log(4);
  return Math.exp(minLog + t * (maxLog - minLog));
}

function valueToSlider(v: number): number {
  const minLog = Math.log(0.0625);
  const maxLog = Math.log(4);
  return (Math.log(v) - minLog) / (maxLog - minLog);
}

function snapToStep(value: number): { value: number; label: string } {
  let closest = SPEED_STEPS[0];
  let minDist = Infinity;
  for (const step of SPEED_STEPS) {
    const dist = Math.abs(Math.log(value) - Math.log(step.value));
    if (dist < minDist) {
      minDist = dist;
      closest = step;
    }
  }
  return closest;
}

function formatFreeValue(value: number): string {
  if (value >= 1) return `${value.toFixed(1)}×`;
  return `${value.toFixed(2)}×`;
}

export function TempoCard() {
  const {
    bpmState,
    bpmMultiplier,
    bpmSource,
    setBpmMultiplier,
    setBpmSource,
    tapBpm,
    refreshBpmState,
  } = useAppStore(
    useShallow((s) => ({
      bpmState: s.bpmState,
      bpmMultiplier: s.bpmMultiplier,
      bpmSource: s.bpmSource,
      setBpmMultiplier: s.setBpmMultiplier,
      setBpmSource: s.setBpmSource,
      tapBpm: s.tapBpm,
      refreshBpmState: s.refreshBpmState,
    })),
  );

  const [shiftHeld, setShiftHeld] = useState(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftHeld(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Poll BPM state for metronome dot
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    intervalRef.current = setInterval(() => refreshBpmState(), 50);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refreshBpmState]);

  const beat = bpmState?.beat ?? 0;
  const phase = bpmState?.phase ?? 0;
  const bpm = bpmState?.bpm ?? 120;
  const effectivePhase = (phase * bpmMultiplier) % 1;
  const metronomePulse = Math.max(0, 1 - effectivePhase / 0.15);
  const pulse = Math.max(beat, metronomePulse);

  const sliderPos = valueToSlider(bpmMultiplier);
  const currentStep = snapToStep(bpmMultiplier);
  const isSnapped = Math.abs(bpmMultiplier - currentStep.value) < 0.001;

  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = parseFloat(e.target.value);
      const value = sliderToValue(raw);
      if (shiftHeld) {
        setBpmMultiplier(value);
      } else {
        const snapped = snapToStep(value);
        setBpmMultiplier(snapped.value);
      }
    },
    [shiftHeld, setBpmMultiplier],
  );

  const speedLabel = isSnapped ? currentStep.label : formatFreeValue(bpmMultiplier);

  return (
    <div className="rounded border border-aura-border bg-aura-surface p-3 min-w-[320px]">
      {/* Header */}
      <div className="text-[10px] text-aura-text-dim uppercase tracking-wider mb-2">
        Tempo
      </div>

      {/* Row 1: BPM + controls */}
      <div className="flex items-center gap-3 mb-3">
        {/* BPM readout + metronome */}
        <div className="flex items-center gap-2">
          <span className="text-2xl font-mono text-aura-text tabular-nums">
            {bpm.toFixed(1)}
          </span>
          <div
            className="w-3 h-3 rounded-full"
            style={{
              backgroundColor: `rgba(34, 197, 94, ${0.15 + pulse * 0.85})`,
              transform: `scale(${0.7 + pulse * 0.6})`,
              boxShadow:
                pulse > 0.15
                  ? `0 0 ${4 + pulse * 8}px rgba(34, 197, 94, ${pulse * 0.7})`
                  : "none",
              transition: "transform 50ms ease-out, box-shadow 50ms ease-out",
            }}
          />
          <span className="text-[10px] text-aura-text-dim">BPM</span>
        </div>

        <div className="flex-1" />

        {/* Source toggle */}
        <div className="flex rounded overflow-hidden border border-aura-border">
          <button
            onClick={() => setBpmSource("auto")}
            className={`px-2 py-1 text-[10px] transition-colors ${
              bpmSource === "auto"
                ? "bg-aura-hover text-aura-text"
                : "text-aura-text-dim hover:text-aura-text"
            }`}
          >
            AUTO
          </button>
          <button
            onClick={() => setBpmSource("manual")}
            className={`px-2 py-1 text-[10px] transition-colors ${
              bpmSource === "manual"
                ? "bg-aura-hover text-aura-text"
                : "text-aura-text-dim hover:text-aura-text"
            }`}
          >
            MANUAL
          </button>
        </div>

        {/* Tap tempo */}
        <button
          onClick={tapBpm}
          className="px-3 py-1 text-[10px] border border-aura-border rounded text-aura-text-dim hover:text-aura-text hover:bg-aura-hover transition-colors"
        >
          TAP
        </button>
      </div>

      {/* Row 2: Master speed slider */}
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-aura-text-dim w-8">Speed</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={sliderPos}
          onChange={handleSliderChange}
          className="flex-1 h-1.5 slider"
        />
        <span className="text-xs font-mono text-aura-text w-12 text-right">
          {speedLabel}
        </span>
      </div>

      {/* Step tick marks */}
      <div className="flex justify-between mt-0.5 px-8">
        {SPEED_STEPS.map((step) => (
          <button
            key={step.value}
            onClick={() => setBpmMultiplier(step.value)}
            className={`text-[8px] transition-colors ${
              isSnapped && currentStep.value === step.value
                ? "text-aura-text"
                : "text-aura-text-dim/50 hover:text-aura-text-dim"
            }`}
          >
            {step.label}
          </button>
        ))}
      </div>
    </div>
  );
}
