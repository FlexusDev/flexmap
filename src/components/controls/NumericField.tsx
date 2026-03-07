import { useCallback, useRef, useState } from "react";

interface NumericFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  decimals?: number;
  suffix?: string;
  mixed?: boolean;
  onChange: (value: number) => void;
  onPointerDown?: () => void;
  onPointerUp?: () => void;
}

export default function NumericField({
  label,
  value,
  min,
  max,
  step,
  decimals = 2,
  suffix = "",
  mixed = false,
  onChange,
  onPointerDown,
  onPointerUp,
}: NumericFieldProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const dragRef = useRef<{
    startY: number;
    startValue: number;
    pointerId: number;
  } | null>(null);

  const clamp = useCallback(
    (v: number) => {
      const clamped = Math.min(max, Math.max(min, v));
      const steps = Math.round((clamped - min) / step);
      return Math.min(max, min + steps * step);
    },
    [min, max, step],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (editing) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      dragRef.current = {
        startY: e.clientY,
        startValue: value,
        pointerId: e.pointerId,
      };
      onPointerDown?.();
    },
    [editing, value, onPointerDown],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const deltaY = drag.startY - e.clientY;
      const sensitivity = e.shiftKey ? 0.1 : 1;
      const newValue = drag.startValue + deltaY * step * sensitivity;
      onChange(clamp(newValue));
    },
    [step, onChange, clamp],
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      dragRef.current = null;
      onPointerUp?.();
    },
    [onPointerUp],
  );

  const startEdit = useCallback(() => {
    if (mixed) return;
    setEditText(value.toFixed(decimals));
    setEditing(true);
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

  const displayValue = mixed
    ? "Mixed"
    : `${value.toFixed(decimals)}${suffix}`;

  return (
    <div className="flex items-center h-6 gap-1.5 select-none">
      {/* Label */}
      <span className="w-6 shrink-0 text-[11px] text-zinc-400 truncate">
        {label}
      </span>

      {/* Value display / edit */}
      {editing ? (
        <input
          type="text"
          className="w-16 shrink-0 text-[11px] text-zinc-200 bg-zinc-800/50 border border-zinc-600 rounded px-1 py-0 text-right tabular-nums outline-none focus:border-indigo-500"
          value={editText}
          autoFocus
          onChange={(e) => setEditText(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={commitEdit}
          data-testid="numeric-input"
        />
      ) : (
        <span
          className="w-16 shrink-0 text-[11px] text-zinc-300 bg-zinc-800/50 rounded px-1 text-right tabular-nums cursor-ns-resize leading-6"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDoubleClick={startEdit}
          data-testid="numeric-value"
        >
          {displayValue}
        </span>
      )}
    </div>
  );
}
