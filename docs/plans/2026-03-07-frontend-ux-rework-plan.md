# Frontend UX Rework Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rework the FlexMap frontend with point selection, context-aware properties, coordinate HUD, alignment guides, magnifier mode, and purpose-built controls.

**Architecture:** All changes are frontend-only (React/TypeScript/Tailwind). No Rust backend changes. New shared UI components (Slider, NumericField, Popover, BlendModePicker, SourcePicker) are created first, then used by the reworked properties panel. Canvas features (point selection, HUD, guides, magnifier) are added to EditorCanvas.tsx.

**Tech Stack:** React 18.3, Zustand 4.5, Tailwind 3.4, Vitest, TypeScript

**Required reading before any task:** `docs/react-zustand.md`

---

### Task 1: Custom Slider Component

**Files:**
- Create: `src/components/controls/Slider.tsx`
- Test: `src/components/controls/Slider.test.tsx`

**Context:** Replace raw `<input type="range">` with a styled slider: filled indigo track, inline value display, click-to-edit value, drag anywhere on track. This component will be reused by Look, Transform, and Edit panes.

**Step 1: Create Slider component**

```tsx
// src/components/controls/Slider.tsx
import { useState, useRef, useCallback } from "react";

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

export function Slider({
  label, value, min, max, step, decimals = 2, mixed,
  onChange, onPointerDown, onPointerUp, onReset,
}: SliderProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const pct = ((value - min) / (max - min)) * 100;

  const valueFromPointer = useCallback((clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return value;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const raw = min + ratio * (max - min);
    return Math.round(raw / step) * step;
  }, [min, max, step, value]);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    onPointerDown?.();
    onChange(valueFromPointer(e.clientX));
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    onChange(valueFromPointer(e.clientX));
  };

  const handlePointerUp = () => {
    dragging.current = false;
    onPointerUp?.();
  };

  const commitEdit = () => {
    const parsed = parseFloat(editValue);
    if (!isNaN(parsed)) {
      onChange(Math.max(min, Math.min(max, parsed)));
    }
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-2 h-6">
      <span className="text-[11px] text-zinc-400 w-16 shrink-0 truncate">{label}</span>
      {onReset && (
        <button
          onClick={onReset}
          className="text-[10px] text-zinc-500 hover:text-zinc-300 shrink-0"
          title="Reset"
        >
          ↺
        </button>
      )}
      <div
        ref={trackRef}
        className="relative flex-1 h-3 bg-zinc-700 rounded-full cursor-pointer select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onLostPointerCapture={handlePointerUp}
      >
        <div
          className="absolute inset-y-0 left-0 bg-indigo-500 rounded-full pointer-events-none"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow pointer-events-none"
          style={{ left: `calc(${pct}% - 6px)` }}
        />
      </div>
      {editing ? (
        <input
          type="text"
          className="w-12 text-[11px] text-right bg-zinc-800 text-zinc-200 border border-indigo-500 rounded px-1 h-5"
          value={editValue}
          autoFocus
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <span
          className="w-12 text-[11px] text-right text-zinc-300 cursor-text shrink-0 tabular-nums"
          onClick={() => { setEditing(true); setEditValue(value.toFixed(decimals)); }}
        >
          {mixed ? "Mixed" : value.toFixed(decimals)}
        </span>
      )}
    </div>
  );
}
```

**Step 2: Write test**

```tsx
// src/components/controls/Slider.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Slider } from "./Slider";

describe("Slider", () => {
  it("renders label and value", () => {
    render(<Slider label="Opacity" value={0.75} min={0} max={1} step={0.01} onChange={() => {}} />);
    expect(screen.getByText("Opacity")).toBeTruthy();
    expect(screen.getByText("0.75")).toBeTruthy();
  });

  it("shows Mixed when mixed prop is true", () => {
    render(<Slider label="Opacity" value={0.5} min={0} max={1} step={0.01} mixed onChange={() => {}} />);
    expect(screen.getByText("Mixed")).toBeTruthy();
  });

  it("enters edit mode on value click", () => {
    render(<Slider label="Opacity" value={0.5} min={0} max={1} step={0.01} onChange={() => {}} />);
    fireEvent.click(screen.getByText("0.50"));
    expect(screen.getByDisplayValue("0.50")).toBeTruthy();
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run src/components/controls/Slider.test.tsx`
Expected: PASS

**Step 4: Commit**

```bash
git add src/components/controls/Slider.tsx src/components/controls/Slider.test.tsx
git commit -m "feat(ui): add custom Slider component with filled track and click-to-edit"
```

---

### Task 2: NumericField Component

**Files:**
- Create: `src/components/controls/NumericField.tsx`
- Test: `src/components/controls/NumericField.test.tsx`

**Context:** Compact inline numeric input with vertical drag-to-scrub. Label on the left, not above. Used for position X/Y, rotation, scale fields.

**Step 1: Create NumericField component**

```tsx
// src/components/controls/NumericField.tsx
import { useState, useRef, useCallback } from "react";

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

export function NumericField({
  label, value, min, max, step, decimals = 2, suffix = "", mixed,
  onChange, onPointerDown, onPointerUp,
}: NumericFieldProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const scrubRef = useRef({ active: false, startY: 0, startValue: 0 });

  const clamp = useCallback((v: number) => Math.max(min, Math.min(max, Math.round(v / step) * step)), [min, max, step]);

  const handlePointerDown = (e: React.PointerEvent) => {
    if (editing) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubRef.current = { active: true, startY: e.clientY, startValue: value };
    onPointerDown?.();
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!scrubRef.current.active) return;
    const dy = scrubRef.current.startY - e.clientY;
    const sensitivity = e.shiftKey ? 0.1 : 1;
    onChange(clamp(scrubRef.current.startValue + dy * step * sensitivity));
  };

  const handlePointerUp = () => {
    scrubRef.current.active = false;
    onPointerUp?.();
  };

  const commitEdit = () => {
    const parsed = parseFloat(editValue);
    if (!isNaN(parsed)) onChange(clamp(parsed));
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-1.5 h-6">
      <span className="text-[11px] text-zinc-400 w-6 shrink-0">{label}</span>
      {editing ? (
        <input
          type="text"
          className="w-16 text-[11px] bg-zinc-800 text-zinc-200 border border-indigo-500 rounded px-1.5 h-5 tabular-nums"
          value={editValue}
          autoFocus
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <div
          className="w-16 text-[11px] bg-zinc-800/50 text-zinc-300 rounded px-1.5 h-5 flex items-center cursor-ns-resize select-none tabular-nums"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onLostPointerCapture={handlePointerUp}
          onDoubleClick={() => { setEditing(true); setEditValue(value.toFixed(decimals)); }}
        >
          {mixed ? "Mixed" : `${value.toFixed(decimals)}${suffix}`}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Write test**

```tsx
// src/components/controls/NumericField.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NumericField } from "./NumericField";

describe("NumericField", () => {
  it("renders label and value", () => {
    render(<NumericField label="X" value={0.5} min={0} max={1} step={0.01} onChange={() => {}} />);
    expect(screen.getByText("X")).toBeTruthy();
    expect(screen.getByText("0.50")).toBeTruthy();
  });

  it("enters edit mode on double-click", () => {
    render(<NumericField label="X" value={0.342} min={0} max={1} step={0.001} decimals={3} onChange={() => {}} />);
    fireEvent.doubleClick(screen.getByText("0.342"));
    expect(screen.getByDisplayValue("0.342")).toBeTruthy();
  });

  it("shows suffix", () => {
    render(<NumericField label="R" value={45} min={-180} max={180} step={1} decimals={0} suffix="°" onChange={() => {}} />);
    expect(screen.getByText("45°")).toBeTruthy();
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run src/components/controls/NumericField.test.tsx`
Expected: PASS

**Step 4: Commit**

```bash
git add src/components/controls/NumericField.tsx src/components/controls/NumericField.test.tsx
git commit -m "feat(ui): add NumericField component with drag-to-scrub"
```

---

### Task 3: Popover Component

**Files:**
- Create: `src/components/controls/Popover.tsx`

**Context:** Lightweight popover used by blend mode picker and source dropdown. Anchored to trigger element, click outside to dismiss. No external library.

**Step 1: Create Popover component**

```tsx
// src/components/controls/Popover.tsx
import { useState, useRef, useEffect, useCallback } from "react";

interface PopoverProps {
  trigger: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function Popover({ trigger, children, className = "" }: PopoverProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open, handleClickOutside]);

  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen(!open)}>{trigger}</div>
      {open && (
        <div className={`absolute z-50 mt-1 bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl ${className}`}>
          {children}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/controls/Popover.tsx
git commit -m "feat(ui): add lightweight Popover component"
```

---

### Task 4: BlendModePicker Component

**Files:**
- Create: `src/components/controls/BlendModePicker.tsx`
- Test: `src/components/controls/BlendModePicker.test.tsx`
- Read first: `src/types/index.ts` for `BlendMode` type

**Context:** 2-column tile grid in a popover. Color-coded by category. Replaces raw `<select>` for blend modes.

**Step 1: Create component**

```tsx
// src/components/controls/BlendModePicker.tsx
import { Popover } from "./Popover";
import type { BlendMode } from "../../types";

interface BlendModeGroup {
  label: string;
  color: string;        // Tailwind ring/bg class
  modes: BlendMode[];
}

const GROUPS: BlendModeGroup[] = [
  { label: "Normal", color: "indigo", modes: ["normal"] },
  { label: "Darken", color: "orange", modes: ["multiply", "darken", "colorBurn"] },
  { label: "Lighten", color: "sky", modes: ["screen", "lighten", "colorDodge"] },
  { label: "Contrast", color: "zinc", modes: ["overlay", "softLight", "hardLight"] },
  { label: "Math", color: "violet", modes: ["difference", "exclusion", "additive"] },
];

const MODE_LABELS: Record<string, string> = {
  normal: "Normal", multiply: "Multiply", screen: "Screen", overlay: "Overlay",
  darken: "Darken", lighten: "Lighten", colorDodge: "Dodge", colorBurn: "Burn",
  softLight: "Soft Light", hardLight: "Hard Light", difference: "Difference",
  exclusion: "Exclusion", additive: "Additive",
};

interface BlendModePickerProps {
  value: BlendMode | null;
  mixed?: boolean;
  onChange: (mode: BlendMode) => void;
}

export function BlendModePicker({ value, mixed, onChange }: BlendModePickerProps) {
  const label = mixed ? "Mixed" : (value ? MODE_LABELS[value] || value : "Normal");

  return (
    <Popover
      trigger={
        <button className="text-[11px] bg-zinc-800/50 text-zinc-300 rounded px-2 h-6 hover:bg-zinc-700 w-full text-left truncate">
          {label}
        </button>
      }
      className="w-52 p-2"
    >
      {GROUPS.map((group) => (
        <div key={group.label} className="mb-1.5 last:mb-0">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider px-1 mb-0.5">{group.label}</div>
          <div className="grid grid-cols-2 gap-0.5">
            {group.modes.map((mode) => (
              <button
                key={mode}
                onClick={() => onChange(mode)}
                className={`text-[11px] px-2 py-1 rounded text-left truncate ${
                  mode === value
                    ? `ring-1 ring-indigo-400 bg-indigo-500/20 text-indigo-200`
                    : `text-zinc-300 hover:bg-zinc-700`
                }`}
              >
                {MODE_LABELS[mode] || mode}
              </button>
            ))}
          </div>
        </div>
      ))}
    </Popover>
  );
}
```

**Step 2: Write test**

```tsx
// src/components/controls/BlendModePicker.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BlendModePicker } from "./BlendModePicker";

describe("BlendModePicker", () => {
  it("shows current blend mode label", () => {
    render(<BlendModePicker value="multiply" onChange={() => {}} />);
    expect(screen.getByText("Multiply")).toBeTruthy();
  });

  it("shows Mixed when mixed", () => {
    render(<BlendModePicker value={null} mixed onChange={() => {}} />);
    expect(screen.getByText("Mixed")).toBeTruthy();
  });

  it("opens popover on click and selects mode", () => {
    const onChange = vi.fn();
    render(<BlendModePicker value="normal" onChange={onChange} />);
    fireEvent.click(screen.getByText("Normal"));
    fireEvent.click(screen.getByText("Screen"));
    expect(onChange).toHaveBeenCalledWith("screen");
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run src/components/controls/BlendModePicker.test.tsx`
Expected: PASS

**Step 4: Commit**

```bash
git add src/components/controls/BlendModePicker.tsx src/components/controls/BlendModePicker.test.tsx
git commit -m "feat(ui): add BlendModePicker with categorized tile grid"
```

---

### Task 5: SourcePicker Component

**Files:**
- Create: `src/components/controls/SourcePicker.tsx`
- Read first: `src/types/index.ts` for source-related types, `src/components/properties/panes/AssignmentPane.tsx` for current source dropdown

**Context:** Compact pill showing protocol icon + source name. Opens popover with sources grouped by protocol.

**Step 1: Create component**

```tsx
// src/components/controls/SourcePicker.tsx
import { Popover } from "./Popover";

interface SourceOption {
  id: string;
  protocol: string;
  display_name: string;
  resolution?: { width: number; height: number } | null;
}

interface SourcePickerProps {
  value: string | null;
  sources: SourceOption[];
  mixed?: boolean;
  onChange: (sourceId: string) => void;
}

const PROTOCOL_ICONS: Record<string, string> = {
  syphon: "◉", spout: "◈", ndi: "◎", shader: "✦", file: "▶", test: "▣",
};

export function SourcePicker({ value, sources, mixed, onChange }: SourcePickerProps) {
  const selected = sources.find((s) => s.id === value);
  const label = mixed ? "Mixed" : selected ? selected.display_name : "None";
  const icon = selected ? (PROTOCOL_ICONS[selected.protocol.toLowerCase()] || "●") : "○";

  // Group sources by protocol
  const grouped = sources.reduce<Record<string, SourceOption[]>>((acc, s) => {
    (acc[s.protocol] ??= []).push(s);
    return acc;
  }, {});

  return (
    <Popover
      trigger={
        <button className="text-[11px] bg-zinc-800/50 text-zinc-300 rounded px-2 h-6 hover:bg-zinc-700 w-full text-left truncate flex items-center gap-1.5">
          <span className="text-indigo-400">{icon}</span>
          <span className="truncate">{label}</span>
        </button>
      }
      className="w-56 p-1.5"
    >
      <button
        onClick={() => onChange("")}
        className={`w-full text-left text-[11px] px-2 py-1 rounded ${
          !value ? "bg-indigo-500/20 text-indigo-200" : "text-zinc-400 hover:bg-zinc-700"
        }`}
      >
        None
      </button>
      <div className="border-t border-zinc-700 my-1" />
      {Object.entries(grouped).map(([protocol, srcs]) => (
        <div key={protocol} className="mb-1 last:mb-0">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider px-2 mb-0.5">{protocol}</div>
          {srcs.map((s) => (
            <button
              key={s.id}
              onClick={() => onChange(s.id)}
              className={`w-full text-left text-[11px] px-2 py-1 rounded flex items-center justify-between ${
                s.id === value
                  ? "bg-indigo-500/20 text-indigo-200 ring-1 ring-indigo-400"
                  : "text-zinc-300 hover:bg-zinc-700"
              }`}
            >
              <span className="truncate">{s.display_name}</span>
              {s.resolution && (
                <span className="text-[10px] text-zinc-500 ml-2 shrink-0">
                  {s.resolution.width}x{s.resolution.height}
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
    </Popover>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/controls/SourcePicker.tsx
git commit -m "feat(ui): add SourcePicker with protocol-grouped popover"
```

---

### Task 6: Point Selection Store State

**Files:**
- Modify: `src/store/useAppStore.ts`
- Modify: `src/store/useAppStore.test.ts`

**Context:** Add `selectedPointIndex` to store with actions to select/clear. Point selection clears when layer selection changes.

**Step 1: Add state and actions to store**

In `src/store/useAppStore.ts`:

1. Add to the state interface (near line ~198, alongside `selectedFaceIndices`):
```typescript
selectedPointIndex: number | null;
```

2. Add initial value (near line ~360):
```typescript
selectedPointIndex: null,
```

3. Add actions (near the selection actions ~line 631):
```typescript
selectPoint: (index: number | null) => set({ selectedPointIndex: index }),
clearPointSelection: () => set({ selectedPointIndex: null }),
```

4. In the existing `selectLayer` action, add `selectedPointIndex: null` to clear point selection when layer changes.

5. In the existing `clearLayerSelection` action, add `selectedPointIndex: null`.

6. In the existing `removeLayer` / `removeSelectedLayers` action, add `selectedPointIndex: null`.

**Step 2: Add to test reset**

In `src/store/useAppStore.test.ts`, add to `beforeEach` setState (line ~18):
```typescript
selectedPointIndex: null,
```

**Step 3: Write test**

Add to `src/store/useAppStore.test.ts`:
```typescript
describe("point selection", () => {
  it("selects and clears a point", () => {
    getState().selectPoint(2);
    expect(getState().selectedPointIndex).toBe(2);
    getState().clearPointSelection();
    expect(getState().selectedPointIndex).toBeNull();
  });

  it("clears point selection when layer selection changes", async () => {
    await act(async () => { await getState().addLayer("A", "quad"); });
    await tick();
    getState().selectPoint(1);
    expect(getState().selectedPointIndex).toBe(1);
    getState().clearLayerSelection();
    expect(getState().selectedPointIndex).toBeNull();
  });
});
```

**Step 4: Run tests**

Run: `npx vitest run src/store/useAppStore.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/store/useAppStore.ts src/store/useAppStore.test.ts
git commit -m "feat(store): add selectedPointIndex state with auto-clear on layer change"
```

---

### Task 7: Point Selection on Canvas

**Files:**
- Modify: `src/components/editor/EditorCanvas.tsx`

**Context:** Click a point to select it. Selected point renders with white fill + indigo ring. Escape or background click clears selection. Read the file first — it's large.

**Step 1: Read EditorCanvas.tsx fully**

Read: `src/components/editor/EditorCanvas.tsx`

**Step 2: Add point selection to mouse handlers**

In `handleMouseDown` (~line 821):
- When `hitTest` finds a point, call `selectPoint(pointIndex)` from store before starting drag.
- When clicking canvas background (no hit), call `clearPointSelection()`.

In `handleKeyDown` (~line 1033):
- On `Escape`: if `selectedPointIndex !== null`, call `clearPointSelection()` and return (before existing Escape handling for faces).

**Step 3: Update point drawing**

In the point rendering section (~line 1595), modify the point drawing logic:
- If `pointIndex === selectedPointIndex && layerId === selectedLayerId`:
  - Draw outer ring: `arc` with radius `POINT_RADIUS + 3`, 1.5px stroke, `#818cf8` (indigo-400)
  - Draw filled circle: `arc` with `POINT_RADIUS`, fill `#ffffff`, no stroke
  - Add subtle shadow: `ctx.shadowColor = "rgba(129, 140, 248, 0.5)"; ctx.shadowBlur = 6;`
- Else: keep existing drawing logic

**Step 4: Verify visually**

Run: `npm run dev`
Test: Click a corner point on a quad layer. It should show white fill + indigo ring. Click background to deselect. Escape to deselect.

**Step 5: Commit**

```bash
git add src/components/editor/EditorCanvas.tsx
git commit -m "feat(canvas): add point selection with visual highlight"
```

---

### Task 8: Arrow Key Nudge for Selected Point

**Files:**
- Modify: `src/components/editor/EditorCanvas.tsx`

**Context:** When a point is selected, arrow keys nudge that single point instead of the whole layer. Uses existing `updateLayerPoint` action.

**Step 1: Modify handleKeyDown arrow key section**

In `handleKeyDown` (~line 1033), modify the arrow key handling:

```typescript
// After calculating dx, dy from arrow keys:
const { selectedPointIndex, selectedLayerId } = useAppStore.getState();

if (selectedPointIndex !== null && selectedLayerId) {
  // Nudge single point
  const layer = layers.find(l => l.id === selectedLayerId);
  if (layer && !layer.locked) {
    if (!nudgeUndoPushed.current) {
      nudgeUndoPushed.current = true;
      beginInteraction();
    }
    // Get current point, apply delta, clamp to [0,1]
    const points = getLayerPoints(layer);
    if (selectedPointIndex < points.length) {
      const pt = points[selectedPointIndex];
      const newPt = {
        x: Math.max(0, Math.min(1, pt.x + dx)),
        y: Math.max(0, Math.min(1, pt.y + dy)),
      };
      updateLayerPoint(layer.id, selectedPointIndex, newPt);
    }
  }
} else {
  // Existing whole-layer nudge logic
  ...
}
```

**Step 2: Verify**

Run: `npm run dev`
Test: Select a quad layer, click corner 0, press Arrow Right. Only that corner should move. Other corners stay put.

**Step 3: Commit**

```bash
git add src/components/editor/EditorCanvas.tsx
git commit -m "feat(canvas): arrow keys nudge selected point instead of whole layer"
```

---

### Task 9: Coordinate HUD

**Files:**
- Create: `src/components/editor/CoordinateHUD.tsx`
- Modify: `src/components/editor/EditorCanvas.tsx`

**Context:** Floating tooltip near cursor showing coordinates during drag/nudge. Dark pill, monospace text, fades out after interaction ends.

**Step 1: Create CoordinateHUD component**

```tsx
// src/components/editor/CoordinateHUD.tsx
import { useEffect, useState } from "react";

interface CoordinateHUDProps {
  x: number;
  y: number;
  cursorX: number;
  cursorY: number;
  mode: "point" | "layer-delta";
  visible: boolean;
}

export function CoordinateHUD({ x, y, cursorX, cursorY, mode, visible }: CoordinateHUDProps) {
  const [show, setShow] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    if (visible) {
      setShow(true);
      setFadeOut(false);
    } else if (show) {
      setFadeOut(true);
      const timer = setTimeout(() => { setShow(false); setFadeOut(false); }, 500);
      return () => clearTimeout(timer);
    }
  }, [visible, show]);

  if (!show) return null;

  const label = mode === "point"
    ? `x: ${x.toFixed(3)}  y: ${y.toFixed(3)}`
    : `dx: ${x >= 0 ? "+" : ""}${x.toFixed(0)}px  dy: ${y >= 0 ? "+" : ""}${y.toFixed(0)}px`;

  return (
    <div
      className={`absolute pointer-events-none z-40 transition-opacity duration-500 ${fadeOut ? "opacity-0" : "opacity-100"}`}
      style={{ left: cursorX + 16, top: cursorY - 28 }}
    >
      <div className="bg-black/80 text-zinc-200 text-[11px] font-mono px-2 py-0.5 rounded-full whitespace-nowrap">
        {label}
      </div>
    </div>
  );
}
```

**Step 2: Integrate into EditorCanvas**

In `EditorCanvas.tsx`:
1. Add state for HUD: `hudData` ref with `{ x, y, cursorX, cursorY, mode, visible }`.
2. During point drag (`handleMouseMove` when dragging a point): update HUD with point's normalized x/y.
3. During layer drag: update HUD with pixel delta from drag start.
4. During arrow nudge of a point: briefly show HUD at the point's canvas position.
5. On `handleMouseUp`: set `visible = false` (triggers fade-out).
6. Render `<CoordinateHUD>` as overlay inside the canvas container div.

**Step 3: Verify**

Run: `npm run dev`
Test: Drag a corner point — tooltip should appear showing `x: 0.xxx  y: 0.xxx`. Release — fades out in 500ms.

**Step 4: Commit**

```bash
git add src/components/editor/CoordinateHUD.tsx src/components/editor/EditorCanvas.tsx
git commit -m "feat(canvas): add coordinate HUD tooltip during drag and nudge"
```

---

### Task 10: Alignment Guides

**Files:**
- Modify: `src/components/editor/EditorCanvas.tsx`

**Context:** Thin dashed cyan lines when a point aligns (within 5% threshold) with another layer's point/edge. Drawn on canvas during render.

**Step 1: Add alignment guide calculation**

Add a helper function in `EditorCanvas.tsx`:

```typescript
interface AlignmentGuide {
  axis: "h" | "v";
  position: number; // normalized 0-1
}

function findAlignmentGuides(
  dragPoint: Point2D,
  currentLayerId: string,
  layers: Layer[],
  threshold: number = 0.02
): AlignmentGuide[] {
  const guides: AlignmentGuide[] = [];
  for (const layer of layers) {
    if (layer.id === currentLayerId || layer.locked || !layer.visible) continue;
    const points = getLayerPoints(layer);
    for (const pt of points) {
      if (Math.abs(pt.x - dragPoint.x) < threshold) {
        guides.push({ axis: "v", position: pt.x });
      }
      if (Math.abs(pt.y - dragPoint.y) < threshold) {
        guides.push({ axis: "h", position: pt.y });
      }
    }
  }
  // Deduplicate
  const seen = new Set<string>();
  return guides.filter(g => {
    const key = `${g.axis}-${g.position.toFixed(4)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

**Step 2: Draw guides on canvas**

In the canvas render function, after drawing layers but before drawing points:

```typescript
if (activeGuides.length > 0) {
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(34, 211, 238, 0.5)"; // cyan-400
  ctx.lineWidth = 1;
  for (const guide of activeGuides) {
    ctx.beginPath();
    if (guide.axis === "v") {
      const x = guide.position * canvasWidth;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvasHeight);
    } else {
      const y = guide.position * canvasHeight;
      ctx.moveTo(0, y);
      ctx.lineTo(canvasWidth, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}
```

**Step 3: Wire into drag handlers**

- During point drag: call `findAlignmentGuides()` with the dragged point's position, store result in a ref.
- During layer drag: call with layer center position.
- On drag end: clear guides.

**Step 4: Verify**

Run: `npm run dev`
Test: Create two quads. Drag a corner of one near a corner of the other — cyan dashed lines should appear when they align horizontally or vertically.

**Step 5: Commit**

```bash
git add src/components/editor/EditorCanvas.tsx
git commit -m "feat(canvas): add alignment guides during point and layer drag"
```

---

### Task 11: Magnifier Mode

**Files:**
- Create: `src/components/editor/Magnifier.tsx`
- Modify: `src/components/editor/EditorCanvas.tsx`
- Modify: `src/store/useAppStore.ts`
- Modify: `src/hooks/useKeyboardShortcuts.ts`
- Modify: `src/components/common/KeyboardOverlay.tsx`
- Modify: `src/components/common/StatusBar.tsx`

**Step 1: Add magnifier state to store**

In `src/store/useAppStore.ts`:
```typescript
// State
magnifierEnabled: boolean;
// Initial
magnifierEnabled: false,
// Action
toggleMagnifier: () => set(s => ({ magnifierEnabled: !s.magnifierEnabled })),
```

**Step 2: Add `Z` keyboard shortcut**

In `src/hooks/useKeyboardShortcuts.ts`, add in the handler:
```typescript
if (key === "z" && !meta && !e.ctrlKey) {
  e.preventDefault();
  get().toggleMagnifier();
  return;
}
```

**Step 3: Add to KeyboardOverlay.tsx SHORTCUTS array**

```typescript
{ keys: ["z"], label: "Magnifier", description: "Toggle magnifier lens (3x zoom)", category: "view" },
```

**Step 4: Add MAGNIFIER badge to StatusBar.tsx**

After the SNAP badge (~line 379):
```tsx
{magnifierEnabled && (
  <span className="px-1.5 py-0.5 bg-violet-500/20 text-violet-300 rounded text-[10px] font-medium">
    MAGNIFIER
  </span>
)}
```

**Step 5: Create Magnifier component**

```tsx
// src/components/editor/Magnifier.tsx
import { useRef, useEffect } from "react";

interface MagnifierProps {
  sourceCanvas: HTMLCanvasElement | null;
  cursorX: number;
  cursorY: number;
  enabled: boolean;
}

const SIZE = 150;
const ZOOM = 3;

export function Magnifier({ sourceCanvas, cursorX, cursorY, enabled }: MagnifierProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!enabled || !sourceCanvas || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;

    const sourceSize = SIZE / ZOOM;
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Clip to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
    ctx.clip();

    // Draw zoomed portion of source canvas
    ctx.drawImage(
      sourceCanvas,
      cursorX - sourceSize / 2, cursorY - sourceSize / 2,
      sourceSize, sourceSize,
      0, 0, SIZE, SIZE
    );
    ctx.restore();

    // Draw crosshair
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(SIZE / 2 - 8, SIZE / 2);
    ctx.lineTo(SIZE / 2 + 8, SIZE / 2);
    ctx.moveTo(SIZE / 2, SIZE / 2 - 8);
    ctx.lineTo(SIZE / 2, SIZE / 2 + 8);
    ctx.stroke();

    // Draw border
    ctx.strokeStyle = "#818cf8";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
  });

  if (!enabled) return null;

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      className="absolute pointer-events-none z-30 rounded-full"
      style={{
        left: cursorX - SIZE / 2,
        top: cursorY - SIZE / 2,
        filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.5))",
      }}
    />
  );
}
```

**Step 6: Integrate into EditorCanvas**

- Pass `canvasRef.current` and mouse position to `<Magnifier>`.
- Render inside the canvas container div (same parent as CoordinateHUD).
- Magnifier renders after the main canvas draw, sampling from the canvas element.

**Step 7: Verify**

Run: `npm run dev`
Test: Press `Z` — magnifier lens appears. Move mouse — shows zoomed canvas content. Click/drag points through it. Press `Z` again — disappears. Status bar shows "MAGNIFIER" badge.

**Step 8: Commit**

```bash
git add src/components/editor/Magnifier.tsx src/components/editor/EditorCanvas.tsx src/store/useAppStore.ts src/hooks/useKeyboardShortcuts.ts src/components/common/KeyboardOverlay.tsx src/components/common/StatusBar.tsx
git commit -m "feat(canvas): add magnifier mode with Z toggle, 3x zoom lens"
```

---

### Task 12: Rework Properties Panel — Layer Section

**Files:**
- Create: `src/components/properties/sections/LayerSection.tsx`
- Modify: `src/components/properties/PropertiesPanel.tsx`

**Context:** Replace the top part of the properties panel with a consolidated "Layer" section: source picker, blend mode picker, opacity slider, visibility/lock toggles, and a collapsed "Advanced Look" accordion.

**Step 1: Read current PropertiesPanel.tsx and all panes**

Read the full files to understand current prop threading.

**Step 2: Create LayerSection**

```tsx
// src/components/properties/sections/LayerSection.tsx
import { useState } from "react";
import { Slider } from "../../controls/Slider";
import { BlendModePicker } from "../../controls/BlendModePicker";
import { SourcePicker } from "../../controls/SourcePicker";
import type { BlendMode } from "../../../types";

interface LayerSectionProps {
  // Source
  sourceId: string | null;
  sources: Array<{ id: string; protocol: string; display_name: string; resolution?: { width: number; height: number } | null }>;
  sourceMixed: boolean;
  onSourceChange: (id: string) => void;
  // Blend
  blendMode: BlendMode | null;
  blendMixed: boolean;
  onBlendChange: (mode: BlendMode) => void;
  // Opacity
  opacity: number;
  opacityMixed: boolean;
  onOpacityChange: (v: number) => void;
  // Visibility/Lock
  visible: boolean;
  locked: boolean;
  visibleMixed: boolean;
  lockedMixed: boolean;
  onToggleVisible: () => void;
  onToggleLock: () => void;
  // Advanced look
  brightness: number;
  contrast: number;
  gamma: number;
  feather: number;
  beatReactive: boolean;
  beatAmount: number;
  beatEligible: boolean;
  lookMixed: boolean;
  onLookChange: (key: string, value: number) => void;
  onBeatToggle: () => void;
  onBeatAmountChange: (v: number) => void;
  // Undo
  onSliderDown: () => void;
  onSliderUp: () => void;
  onLookReset: (key: string) => void;
}

export function LayerSection(props: LayerSectionProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  return (
    <div className="px-2 py-2 space-y-2">
      {/* Source + Blend row */}
      <div className="grid grid-cols-2 gap-1.5">
        <div>
          <div className="text-[10px] text-zinc-500 mb-0.5">Source</div>
          <SourcePicker
            value={props.sourceId}
            sources={props.sources}
            mixed={props.sourceMixed}
            onChange={props.onSourceChange}
          />
        </div>
        <div>
          <div className="text-[10px] text-zinc-500 mb-0.5">Blend</div>
          <BlendModePicker
            value={props.blendMode}
            mixed={props.blendMixed}
            onChange={props.onBlendChange}
          />
        </div>
      </div>

      {/* Opacity */}
      <Slider
        label="Opacity"
        value={props.opacity}
        min={0} max={1} step={0.01}
        mixed={props.opacityMixed}
        onChange={props.onOpacityChange}
        onPointerDown={props.onSliderDown}
        onPointerUp={props.onSliderUp}
        onReset={() => props.onLookReset("opacity")}
      />

      {/* Visibility + Lock */}
      <div className="flex gap-1">
        <button
          onClick={props.onToggleVisible}
          className={`flex-1 text-[11px] py-0.5 rounded ${
            props.visible ? "bg-zinc-700 text-zinc-200" : "bg-zinc-800 text-zinc-500"
          }`}
        >
          {props.visibleMixed ? "Mixed" : props.visible ? "Visible" : "Hidden"}
        </button>
        <button
          onClick={props.onToggleLock}
          className={`flex-1 text-[11px] py-0.5 rounded ${
            props.locked ? "bg-amber-500/20 text-amber-300" : "bg-zinc-800 text-zinc-500"
          }`}
        >
          {props.lockedMixed ? "Mixed" : props.locked ? "Locked" : "Unlocked"}
        </button>
      </div>

      {/* Advanced Look accordion */}
      <button
        onClick={() => setAdvancedOpen(!advancedOpen)}
        className="w-full text-left text-[10px] text-zinc-500 hover:text-zinc-400 flex items-center gap-1"
      >
        <span className={`transition-transform ${advancedOpen ? "rotate-90" : ""}`}>▸</span>
        Advanced Look
      </button>
      {advancedOpen && (
        <div className="space-y-1 pl-2">
          {(["brightness", "contrast", "gamma", "feather"] as const).map((key) => (
            <Slider
              key={key}
              label={key.charAt(0).toUpperCase() + key.slice(1)}
              value={props[key]}
              min={key === "gamma" ? 0.2 : 0}
              max={key === "gamma" ? 3 : 2}
              step={0.01}
              mixed={props.lookMixed}
              onChange={(v) => props.onLookChange(key, v)}
              onPointerDown={props.onSliderDown}
              onPointerUp={props.onSliderUp}
              onReset={() => props.onLookReset(key)}
            />
          ))}
          {props.beatEligible && (
            <div className="flex items-center gap-2">
              <button
                onClick={props.onBeatToggle}
                className={`text-[11px] px-2 py-0.5 rounded ${
                  props.beatReactive ? "bg-indigo-500/20 text-indigo-300" : "bg-zinc-800 text-zinc-500"
                }`}
              >
                Beat {props.beatReactive ? "On" : "Off"}
              </button>
              {props.beatReactive && (
                <div className="flex-1">
                  <Slider
                    label="Amount"
                    value={props.beatAmount}
                    min={0} max={1} step={0.01}
                    onChange={props.onBeatAmountChange}
                    onPointerDown={props.onSliderDown}
                    onPointerUp={props.onSliderUp}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

**Step 3: Commit**

```bash
git add src/components/properties/sections/LayerSection.tsx
git commit -m "feat(properties): create LayerSection with consolidated source/blend/opacity/look"
```

---

### Task 13: Rework Properties Panel — Edit Section

**Files:**
- Create: `src/components/properties/sections/EditSection.tsx`

**Context:** Context-dependent edit section. Shows different controls based on mode and point selection state. Uses NumericField for position/rotation/scale.

**Step 1: Create EditSection**

```tsx
// src/components/properties/sections/EditSection.tsx
import { NumericField } from "../../controls/NumericField";
import { Slider } from "../../controls/Slider";
import type { Layer, EditorSelectionMode, Point2D } from "../../../types";

interface EditSectionProps {
  layer: Layer | null;
  mode: EditorSelectionMode;
  selectedPointIndex: number | null;
  snapEnabled: boolean;
  onToggleSnap: () => void;
  // Shape mode, no point
  centerX: number;
  centerY: number;
  onCenterChange: (x: number, y: number) => void;
  onSubdivide: () => void;
  // Shape mode, point selected
  pointPosition: Point2D | null;
  pointCount: number;
  onPointChange: (pt: Point2D) => void;
  // UV/Input mode
  inputTransform: { offsetX: number; offsetY: number; rotation: number; scaleX: number; scaleY: number };
  onInputTransformChange: (key: string, value: number) => void;
  onInputTransformReset: () => void;
  // Per-face UV (mesh + faces selected)
  facesSelected: number;
  faceUv: { offsetX: number; offsetY: number; rotation: number; scaleX: number; scaleY: number } | null;
  onFaceUvChange: (key: string, value: number) => void;
  onFaceUvReset: () => void;
  // Undo
  onSliderDown: () => void;
  onSliderUp: () => void;
}

function geometryLabel(layer: Layer): string {
  const g = layer.geometry;
  switch (g.type) {
    case "Quad": return "Quad (4 pts)";
    case "Triangle": return "Triangle (3 pts)";
    case "Circle": return "Circle";
    case "Mesh": return `Mesh ${g.data.cols}x${g.data.rows} (${g.data.points.length} pts)`;
  }
}

export function EditSection(props: EditSectionProps) {
  const { layer, mode, selectedPointIndex } = props;
  if (!layer) return null;

  // UV/Input mode
  if (mode === "uv") {
    const t = props.inputTransform;
    return (
      <div className="px-2 py-2 space-y-1.5">
        <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Input Transform</div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <NumericField label="X" value={t.offsetX} min={-1} max={1} step={0.001} decimals={3} onChange={(v) => props.onInputTransformChange("offsetX", v)} onPointerDown={props.onSliderDown} onPointerUp={props.onSliderUp} />
          <NumericField label="Y" value={t.offsetY} min={-1} max={1} step={0.001} decimals={3} onChange={(v) => props.onInputTransformChange("offsetY", v)} onPointerDown={props.onSliderDown} onPointerUp={props.onSliderUp} />
          <NumericField label="R" value={t.rotation} min={-180} max={180} step={1} decimals={0} suffix="°" onChange={(v) => props.onInputTransformChange("rotation", v)} onPointerDown={props.onSliderDown} onPointerUp={props.onSliderUp} />
          <NumericField label="S" value={t.scaleX} min={0.1} max={3} step={0.01} onChange={(v) => props.onInputTransformChange("scaleX", v)} onPointerDown={props.onSliderDown} onPointerUp={props.onSliderUp} />
        </div>
        <button onClick={props.onInputTransformReset} className="text-[10px] text-zinc-500 hover:text-zinc-300">Reset</button>

        {props.facesSelected > 0 && props.faceUv && (
          <>
            <div className="border-t border-zinc-700 my-2" />
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{props.facesSelected} Face{props.facesSelected > 1 ? "s" : ""} UV</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1">
              <NumericField label="X" value={props.faceUv.offsetX} min={-1} max={1} step={0.01} onChange={(v) => props.onFaceUvChange("offsetX", v)} onPointerDown={props.onSliderDown} onPointerUp={props.onSliderUp} />
              <NumericField label="Y" value={props.faceUv.offsetY} min={-1} max={1} step={0.01} onChange={(v) => props.onFaceUvChange("offsetY", v)} onPointerDown={props.onSliderDown} onPointerUp={props.onSliderUp} />
              <NumericField label="R" value={props.faceUv.rotation} min={0} max={360} step={1} decimals={0} suffix="°" onChange={(v) => props.onFaceUvChange("rotation", v)} onPointerDown={props.onSliderDown} onPointerUp={props.onSliderUp} />
              <NumericField label="S" value={props.faceUv.scaleX} min={0.1} max={3} step={0.01} onChange={(v) => props.onFaceUvChange("scaleX", v)} onPointerDown={props.onSliderDown} onPointerUp={props.onSliderUp} />
            </div>
            <button onClick={props.onFaceUvReset} className="text-[10px] text-zinc-500 hover:text-zinc-300">Reset</button>
          </>
        )}
      </div>
    );
  }

  // Shape mode, point selected
  if (selectedPointIndex !== null && props.pointPosition) {
    return (
      <div className="px-2 py-2 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider">
            Point {selectedPointIndex + 1} of {props.pointCount}
          </span>
          <button
            onClick={props.onToggleSnap}
            className={`text-[10px] px-1.5 py-0.5 rounded ${
              props.snapEnabled ? "bg-cyan-500/20 text-cyan-300" : "bg-zinc-800 text-zinc-500"
            }`}
          >
            Snap
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <NumericField
            label="X"
            value={props.pointPosition.x}
            min={0} max={1} step={0.001} decimals={3}
            onChange={(v) => props.onPointChange({ x: v, y: props.pointPosition!.y })}
            onPointerDown={props.onSliderDown}
            onPointerUp={props.onSliderUp}
          />
          <NumericField
            label="Y"
            value={props.pointPosition.y}
            min={0} max={1} step={0.001} decimals={3}
            onChange={(v) => props.onPointChange({ x: props.pointPosition!.x, y: v })}
            onPointerDown={props.onSliderDown}
            onPointerUp={props.onSliderUp}
          />
        </div>
      </div>
    );
  }

  // Shape mode, no point selected
  return (
    <div className="px-2 py-2 space-y-1.5">
      <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{geometryLabel(layer)}</div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        <NumericField
          label="X"
          value={props.centerX}
          min={0} max={4000} step={1} decimals={0} suffix="px"
          onChange={(v) => props.onCenterChange(v, props.centerY)}
          onPointerDown={props.onSliderDown}
          onPointerUp={props.onSliderUp}
        />
        <NumericField
          label="Y"
          value={props.centerY}
          min={0} max={4000} step={1} decimals={0} suffix="px"
          onChange={(v) => props.onCenterChange(props.centerX, v)}
          onPointerDown={props.onSliderDown}
          onPointerUp={props.onSliderUp}
        />
      </div>
      {layer.geometry.type === "Mesh" && (
        <button
          onClick={props.onSubdivide}
          className="text-[11px] bg-zinc-800 text-zinc-300 hover:bg-zinc-700 px-2 py-1 rounded w-full"
        >
          Subdivide
        </button>
      )}
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/components/properties/sections/EditSection.tsx
git commit -m "feat(properties): create context-aware EditSection component"
```

---

### Task 14: Wire New Sections into PropertiesPanel

**Files:**
- Modify: `src/components/properties/PropertiesPanel.tsx`

**Context:** Replace the 4-pane resizable layout with 2 sections (LayerSection + EditSection). Remove old pane imports and rendering. Keep all the data derivation and callback logic, just rewire to new components.

**Step 1: Read PropertiesPanel.tsx fully**

**Step 2: Replace pane rendering**

1. Remove imports for `AssignmentPane`, `TransformPane`, `LookPane`, `GeometryUvPane`.
2. Import `LayerSection` and `EditSection`.
3. Replace the 4-panel `<Group>` with a simple scrollable div containing the two sections separated by a border.
4. Remove `react-resizable-panels` usage from properties (the main app layout still uses it for left/center/right).
5. Thread existing derived props to the new section components.

**Step 3: Verify**

Run: `npm run dev`
Test: Select a layer — properties panel shows Layer section (source, blend, opacity, vis/lock, advanced look accordion) and Edit section (geometry info, center position). Click a point — Edit section switches to point view. Tab to UV mode — Edit section shows input transform.

**Step 4: Commit**

```bash
git add src/components/properties/PropertiesPanel.tsx
git commit -m "feat(properties): wire LayerSection and EditSection, replace 4-pane layout"
```

---

### Task 15: Clean Up Old Pane Files

**Files:**
- Delete: `src/components/properties/panes/AssignmentPane.tsx`
- Delete: `src/components/properties/panes/TransformPane.tsx`
- Delete: `src/components/properties/panes/LookPane.tsx`
- Delete: `src/components/properties/panes/GeometryUvPane.tsx`

**Step 1: Verify no other imports reference these files**

Run: `grep -r "AssignmentPane\|TransformPane\|LookPane\|GeometryUvPane" src/ --include="*.tsx" --include="*.ts"`

Should only show the pane files themselves (no other importers after Task 14).

**Step 2: Delete files**

**Step 3: Verify build**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Commit**

```bash
git rm src/components/properties/panes/AssignmentPane.tsx src/components/properties/panes/TransformPane.tsx src/components/properties/panes/LookPane.tsx src/components/properties/panes/GeometryUvPane.tsx
git commit -m "refactor(properties): remove old 4-pane property files"
```

---

### Task 16: Update Keyboard Overlay for Point Nudge

**Files:**
- Modify: `src/components/common/KeyboardOverlay.tsx`

**Context:** Update arrow key shortcut descriptions to mention point nudge behavior.

**Step 1: Update SHORTCUTS entries**

Change the arrow key entries (~line 36) descriptions:
```typescript
{ keys: ["arrowleft"], label: "Nudge ←", description: "Move selected point or layer left (0.5%, Shift: 0.1%)", category: "edit" },
{ keys: ["arrowright"], label: "Nudge →", description: "Move selected point or layer right (0.5%, Shift: 0.1%)", category: "edit" },
{ keys: ["arrowup"], label: "Nudge ↑", description: "Move selected point or layer up (0.5%, Shift: 0.1%)", category: "edit" },
{ keys: ["arrowdown"], label: "Nudge ↓", description: "Move selected point or layer down (0.5%, Shift: 0.1%)", category: "edit" },
```

Also update category from `"layer"` to `"edit"` since it now applies to both layers and points.

**Step 2: Commit**

```bash
git add src/components/common/KeyboardOverlay.tsx
git commit -m "docs(keyboard): update arrow key descriptions for point nudge"
```

---

### Task 17: Final Integration Test & Polish

**Files:**
- All modified files

**Step 1: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 2: Run all tests**

Run: `npx vitest run`
Expected: All pass

**Step 3: Visual test in browser**

Run: `npm run dev`

Test checklist:
- [ ] Click corner point → white fill + indigo ring
- [ ] Arrow keys nudge selected point only
- [ ] No point selected → arrow keys nudge whole layer
- [ ] Escape clears point selection
- [ ] Properties panel: Layer section shows source, blend, opacity
- [ ] Properties panel: Advanced Look accordion opens/closes
- [ ] Properties panel: Edit section changes based on mode + point selection
- [ ] Blend mode picker: opens popover with categorized tiles
- [ ] Source picker: opens popover grouped by protocol
- [ ] Sliders: filled track, click value to edit, drag anywhere
- [ ] Coordinate HUD appears during drag, fades out
- [ ] Alignment guides show when points align
- [ ] `Z` toggles magnifier, lens follows cursor
- [ ] Status bar shows MAGNIFIER badge
- [ ] Keyboard overlay shows `Z` and updated arrow descriptions

**Step 4: Commit any polish fixes**

```bash
git add -A
git commit -m "fix(ui): polish and integration fixes for UX rework"
```
