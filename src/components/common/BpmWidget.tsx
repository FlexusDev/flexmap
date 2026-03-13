import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../store/useAppStore";

export function BpmWidget() {
  const {
    bpmState,
    bpmMultiplier,
    refreshBpmState,
  } = useAppStore(
    useShallow((s) => ({
      bpmState: s.bpmState,
      bpmMultiplier: s.bpmMultiplier,
      refreshBpmState: s.refreshBpmState,
    })),
  );

  // Poll BPM state at ~20Hz for smooth metronome animation
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
  const [hovered, setHovered] = useState(false);

  // Metronome pulse — apply multiplier so dot matches effective speed
  const effectivePhase = (phase * bpmMultiplier) % 1;
  const metronomePulse = Math.max(0, 1 - effectivePhase / 0.15);
  const pulse = Math.max(beat, metronomePulse);
  const intensity = hovered ? pulse : pulse * 0.3;

  return (
    <div
      className="flex items-center gap-1 px-1.5"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* BPM display */}
      <div className="flex items-center gap-1 text-xs font-mono text-aura-text-dim">
        <span className="opacity-60">♩</span>
        <span className="w-10 text-right">{bpm.toFixed(1)}</span>
      </div>

      {/* Metronome dot */}
      <div
        className="w-2.5 h-2.5 rounded-full"
        style={{
          backgroundColor: `rgba(34, 197, 94, ${0.12 + intensity * 0.88})`,
          transform: hovered ? `scale(${0.7 + pulse * 0.6})` : "scale(1)",
          boxShadow:
            hovered && pulse > 0.15
              ? `0 0 ${4 + pulse * 8}px rgba(34, 197, 94, ${pulse * 0.6})`
              : "none",
          transition: "transform 50ms ease-out, box-shadow 50ms ease-out",
        }}
      />
    </div>
  );
}
