import { useCallback, useRef, useState } from "react";

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  mixed?: boolean;
  onChange: (value: number) => void;
  onPointerDown?: () => void;
  onPointerUp?: () => void;
  onReset?: () => void;
}

export default function Slider({
  label,
  value,
  min,
  max,
  step,
  decimals = 2,
  mixed = false,
  onChange,
  onPointerDown,
  onPointerUp,
  onReset,
}: SliderProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [dragging, setDragging] = useState(false);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const fraction = max === min ? 0 : (value - min) / (max - min);
  const percent = Math.max(0, Math.min(100, fraction * 100));

  const clamp = useCallback(
    (v: number) => {
      const clamped = Math.min(max, Math.max(min, v));
      // Round to step
      const steps = Math.round((clamped - min) / step);
      return Math.min(max, min + steps * step);
    },
    [min, max, step],
  );

  const valueFromPointer = useCallback(
    (clientX: number) => {
      const track = trackRef.current;
      if (!track) return value;
      const rect = track.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return clamp(min + frac * (max - min));
    },
    [min, max, value, clamp],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDragging(true);
      onPointerDown?.();
      onChange(valueFromPointer(e.clientX));
    },
    [onChange, onPointerDown, valueFromPointer],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      onChange(valueFromPointer(e.clientX));
    },
    [dragging, onChange, valueFromPointer],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      setDragging(false);
      onPointerUp?.();
    },
    [dragging, onPointerUp],
  );

  const startEdit = useCallback(() => {
    if (mixed) return;
    setEditText(value.toFixed(decimals));
    setEditing(true);
    // Focus happens via autoFocus on the input
  }, [value, decimals, mixed]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const parsed = parseFloat(editText);
    if (!isNaN(parsed)) {
      onChange(clamp(parsed));
    }
  }, [editText, onChange, clamp]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commitEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelEdit();
      }
    },
    [commitEdit, cancelEdit],
  );

  const displayValue = mixed ? "Mixed" : value.toFixed(decimals);

  return (
    <div className="flex items-center h-6 gap-1.5 select-none">
      {/* Label */}
      <span className="w-16 shrink-0 text-[11px] text-zinc-400 truncate">
        {label}
      </span>

      {/* Reset button */}
      {onReset && (
        <button
          type="button"
          className="shrink-0 text-[11px] text-zinc-500 hover:text-zinc-300 leading-none"
          onClick={onReset}
          title="Reset"
        >
          ↺
        </button>
      )}

      {/* Track */}
      <div
        ref={trackRef}
        className="relative flex-1 h-3 bg-zinc-700 rounded-full cursor-pointer"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {/* Filled portion */}
        <div
          className="absolute top-0 left-0 h-full bg-indigo-500 rounded-full pointer-events-none"
          style={{ width: `${percent}%` }}
        />
        {/* Thumb */}
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 bg-white rounded-full shadow pointer-events-none"
          style={{ left: `${percent}%` }}
        />
      </div>

      {/* Value display / edit */}
      {editing ? (
        <input
          ref={inputRef}
          type="text"
          className="w-12 shrink-0 text-[11px] text-zinc-200 bg-zinc-800 border border-zinc-600 rounded px-1 py-0 text-right tabular-nums outline-none focus:border-indigo-500"
          value={editText}
          autoFocus
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitEdit}
        />
      ) : (
        <span
          className="w-12 shrink-0 text-[11px] text-zinc-300 text-right tabular-nums cursor-text"
          onClick={startEdit}
          data-testid="slider-value"
        >
          {displayValue}
        </span>
      )}
    </div>
  );
}
