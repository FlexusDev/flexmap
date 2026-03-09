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

  // Poll BPM state at ~10Hz for beat indicator animation
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    intervalRef.current = setInterval(() => {
      refreshBpmState();
    }, 100);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refreshBpmState]);

  const beat = bpmState?.beat ?? 0;
  const bpm = bpmState?.bpm ?? 120;

  return (
    <div className="flex items-center gap-1 px-1.5">
      {/* BPM display */}
      <div className="flex items-center gap-1 text-xs font-mono text-aura-text-dim">
        <span className="opacity-60">♩</span>
        <span className="w-10 text-right">{bpm.toFixed(1)}</span>
      </div>

      {/* Beat indicator — dot that pulses */}
      <div
        className="w-2 h-2 rounded-full transition-all duration-75"
        style={{
          backgroundColor: beat > 0.3 ? "#22c55e" : "#3f3f46",
          transform: `scale(${1 + beat * 0.5})`,
          boxShadow: beat > 0.3 ? "0 0 4px #22c55e" : "none",
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
