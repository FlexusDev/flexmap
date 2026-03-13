import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../store/useAppStore";

const MULTIPLIERS = [
  { value: 0.25, label: "÷4" },
  { value: 0.5, label: "÷2" },
  { value: 1, label: "1x" },
  { value: 2, label: "×2" },
  { value: 4, label: "×4" },
];

export function BpmWidget() {
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

  // Poll BPM state at ~20Hz for smooth metronome animation
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      refreshBpmState();
    }, 50);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refreshBpmState]);

  const beat = bpmState?.beat ?? 0;
  const phase = bpmState?.phase ?? 0;
  const bpm = bpmState?.bpm ?? 120;

  // Metronome pulse: sharp flash at start of each beat cycle (phase=0),
  // decays over first 15% of the cycle. Blend with audio beat envelope
  // so detected beats reinforce the visual.
  const metronomePulse = Math.max(0, 1 - phase / 0.15);
  const pulse = Math.max(beat, metronomePulse);

  return (
    <div className="flex items-center gap-1 px-1.5">
      {/* BPM display */}
      <div className="flex items-center gap-1 text-xs font-mono text-aura-text-dim">
        <span className="opacity-60">♩</span>
        <span className="w-10 text-right">{bpm.toFixed(1)}</span>
      </div>

      {/* Beat indicator — optical metronome dot */}
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

      {/* Separator */}
      <div className="w-px h-4 bg-aura-border mx-0.5" />

      {/* Multiplier buttons */}
      <div className="flex gap-px">
        {MULTIPLIERS.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => setBpmMultiplier(value)}
            className={`px-1 py-0.5 text-[10px] rounded transition-colors ${
              bpmMultiplier === value
                ? "bg-aura-hover text-aura-text"
                : "text-aura-text-dim hover:text-aura-text"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Separator */}
      <div className="w-px h-4 bg-aura-border mx-0.5" />

      {/* Tap tempo */}
      <button
        onClick={tapBpm}
        className="px-1.5 py-0.5 text-[10px] text-aura-text-dim hover:text-aura-text hover:bg-aura-hover rounded transition-colors"
      >
        TAP
      </button>

      {/* Source toggle */}
      <div className="flex rounded overflow-hidden">
        <button
          onClick={() => setBpmSource("auto")}
          className={`px-1.5 py-0.5 text-[10px] transition-colors ${
            bpmSource === "auto"
              ? "bg-aura-hover text-aura-text"
              : "text-aura-text-dim hover:text-aura-text"
          }`}
        >
          AUTO
        </button>
        <button
          onClick={() => setBpmSource("manual")}
          className={`px-1.5 py-0.5 text-[10px] transition-colors ${
            bpmSource === "manual"
              ? "bg-aura-hover text-aura-text"
              : "text-aura-text-dim hover:text-aura-text"
          }`}
        >
          MAN
        </button>
      </div>
    </div>
  );
}
