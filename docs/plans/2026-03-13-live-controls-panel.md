# Live Controls Panel + Master Speed Slider — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the multiplier buttons with a master speed slider inside a new toggleable Live Controls panel below the canvas, with musical step labels for 4/4 time.

**Architecture:** New `LiveControlsPanel` component renders inside the center panel of App.tsx, below EditorCanvas. A `TempoCard` component inside it holds the BPM controls (moved from toolbar) and the master speed slider. The toolbar keeps only a compact BPM readout + metronome dot + panel toggle button. Rust-side change is minimal: loosen the multiplier validation from a whitelist to a range clamp.

**Tech Stack:** React 19, Zustand 5, Tailwind 4, Rust/Tauri IPC

**Docs to read first:** `docs/react-zustand.md`, `docs/tauri-ipc.md`

---

### Task 1: Loosen Rust multiplier validation

**Files:**
- Modify: `src-tauri/src/audio/mod.rs:384-389`

**Step 1: Replace whitelist with range clamp**

```rust
// OLD (line 384-389):
fn set_multiplier(&mut self, multiplier: f32) -> BpmState {
    const VALID: [f32; 5] = [0.25, 0.5, 1.0, 2.0, 4.0];
    if VALID.iter().any(|v| (v - multiplier).abs() < f32::EPSILON) {
        self.state.multiplier = multiplier;
    }
    self.get_bpm_state()
}
```

```rust
// NEW:
fn set_multiplier(&mut self, multiplier: f32) -> BpmState {
    self.state.multiplier = multiplier.clamp(0.0625, 4.0);
    self.get_bpm_state()
}
```

**Step 2: Verify**

Run: `cd src-tauri && cargo build && cargo test --lib`

**Step 3: Commit**

```
feat(audio): accept continuous multiplier range 0.0625–4.0
```

---

### Task 2: Add store state for live controls panel + persist multiplier

**Files:**
- Modify: `src/store/useAppStore.ts`

**Step 1: Add `liveControlsOpen` state and persistence**

Near the other localStorage constants (line ~42), add:

```typescript
const LIVE_CONTROLS_KEY = "flexmap:live_controls_open";

function readLiveControlsOpen(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(LIVE_CONTROLS_KEY) === "true";
}

function persistLiveControlsOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(LIVE_CONTROLS_KEY, String(open));
}
```

In the AppState interface (near line ~228), add:

```typescript
liveControlsOpen: boolean;
toggleLiveControls: () => void;
```

In the initial state (near line ~395), add:

```typescript
liveControlsOpen: readLiveControlsOpen(),
toggleLiveControls: () => {
  const next = !get().liveControlsOpen;
  set({ liveControlsOpen: next });
  persistLiveControlsOpen(next);
},
```

**Step 2: Persist multiplier to localStorage**

Update `setBpmMultiplier` (line ~1422) to persist:

```typescript
setBpmMultiplier: async (multiplier) => {
  try {
    await tauriInvoke("set_bpm_multiplier", { multiplier });
    set({ bpmMultiplier: multiplier });
    // Persist multiplier alongside BPM config
    const config = get().bpmConfig;
    persistBpmConfig(config);
    window.localStorage.setItem("flexmap:bpm_multiplier", String(multiplier));
  } catch (e) {
    console.error("Failed to set BPM multiplier:", e);
    get().addToast("Failed to set BPM multiplier", "error");
  }
},
```

Initialize `bpmMultiplier` from localStorage (in initial state, line ~395):

```typescript
bpmMultiplier: (() => {
  if (typeof window === "undefined") return 1;
  const stored = window.localStorage.getItem("flexmap:bpm_multiplier");
  return stored ? parseFloat(stored) || 1 : 1;
})(),
```

**Step 3: Verify**

Run: `npx tsc --noEmit`

**Step 4: Commit**

```
feat(store): add liveControlsOpen state and persist multiplier
```

---

### Task 3: Create LiveControlsPanel component

**Files:**
- Create: `src/components/live/LiveControlsPanel.tsx`

**Step 1: Create the panel shell**

```tsx
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../store/useAppStore";
import { TempoCard } from "./TempoCard";

export function LiveControlsPanel() {
  const liveControlsOpen = useAppStore((s) => s.liveControlsOpen);

  if (!liveControlsOpen) return null;

  return (
    <div className="border-t border-aura-border bg-aura-bg p-2 overflow-x-auto">
      <div className="flex gap-2">
        <TempoCard />
      </div>
    </div>
  );
}
```

**Step 2: Verify**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```
feat(ui): create LiveControlsPanel shell component
```

---

### Task 4: Create TempoCard with master speed slider

**Files:**
- Create: `src/components/live/TempoCard.tsx`

This is the main implementation task. The TempoCard has two rows:
- Row 1: BPM readout, metronome dot, auto/manual toggle, tap tempo
- Row 2: Master speed slider with musical step labels

**Step 1: Create the TempoCard**

```tsx
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

// Map 0-1 slider position to logarithmic value range
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
    const down = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(true); };
    const up = (e: KeyboardEvent) => { if (e.key === "Shift") setShiftHeld(false); };
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
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [refreshBpmState]);

  const beat = bpmState?.beat ?? 0;
  const phase = bpmState?.phase ?? 0;
  const bpm = bpmState?.bpm ?? 120;
  const metronomePulse = Math.max(0, 1 - phase / 0.15);
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
```

**Step 2: Verify**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```
feat(ui): create TempoCard with master speed slider
```

---

### Task 5: Wire LiveControlsPanel into App.tsx center panel

**Files:**
- Modify: `src/App.tsx:148-153`

**Step 1: Import and add LiveControlsPanel**

Add import at top of App.tsx:

```typescript
import { LiveControlsPanel } from "./components/live/LiveControlsPanel";
```

Replace the center panel (lines 148-153):

```tsx
{/* OLD: */}
<Panel id="center" minSize={200}>
  <div className="relative h-full w-full">
    <EditorCanvas />
  </div>
</Panel>
```

```tsx
{/* NEW: */}
<Panel id="center" minSize={200}>
  <div className="relative h-full w-full flex flex-col">
    <div className="flex-1 min-h-0 relative">
      <EditorCanvas />
    </div>
    <LiveControlsPanel />
  </div>
</Panel>
```

**Step 2: Verify**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```
feat(ui): wire LiveControlsPanel below canvas in center panel
```

---

### Task 6: Slim down toolbar BpmWidget

**Files:**
- Modify: `src/components/common/BpmWidget.tsx`

Strip the widget down to: compact BPM readout + metronome dot + panel toggle button. Remove multiplier buttons, tap, auto/manual toggle.

**Step 1: Rewrite BpmWidget**

```tsx
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../store/useAppStore";

export function BpmWidget() {
  const {
    bpmState,
    bpmMultiplier,
    liveControlsOpen,
    refreshBpmState,
    toggleLiveControls,
  } = useAppStore(
    useShallow((s) => ({
      bpmState: s.bpmState,
      bpmMultiplier: s.bpmMultiplier,
      liveControlsOpen: s.liveControlsOpen,
      refreshBpmState: s.refreshBpmState,
      toggleLiveControls: s.toggleLiveControls,
    })),
  );

  // Poll BPM state at ~20Hz for smooth metronome animation
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    intervalRef.current = setInterval(() => refreshBpmState(), 50);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
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

      {/* Live controls toggle */}
      <button
        onClick={toggleLiveControls}
        className={`ml-1 px-1.5 py-0.5 text-[10px] rounded transition-colors ${
          liveControlsOpen
            ? "bg-aura-hover text-aura-text"
            : "text-aura-text-dim hover:text-aura-text"
        }`}
        title="Toggle Live Controls"
      >
        LIVE
      </button>
    </div>
  );
}
```

**Step 2: Verify**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```
feat(ui): slim BpmWidget to compact readout + panel toggle
```

---

### Task 7: Apply multiplier to metronome in TempoCard too

**Files:**
- Modify: `src/components/live/TempoCard.tsx`

In the TempoCard, the metronome dot should also reflect the multiplier:

**Step 1: Update phase calculation**

Replace the metronomePulse line:

```typescript
// OLD:
const metronomePulse = Math.max(0, 1 - phase / 0.15);
```

```typescript
// NEW: apply multiplier so metronome matches effective speed
const effectivePhase = (phase * bpmMultiplier) % 1;
const metronomePulse = Math.max(0, 1 - effectivePhase / 0.15);
```

**Step 2: Verify**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```
fix(ui): apply speed multiplier to TempoCard metronome dot
```

---

### Task 8: Update mock bridge

**Files:**
- Modify: `src/lib/tauri-bridge.ts:963`

**Step 1: Update set_bpm_multiplier mock**

Replace the no-op mock:

```typescript
// OLD:
set_bpm_multiplier: (_args: { multiplier: number }) => null,
```

```typescript
// NEW:
set_bpm_multiplier: (args: { multiplier: number }) => {
  mockBpmState.multiplier = Math.max(0.0625, Math.min(4, args.multiplier));
  return null;
},
```

**Step 2: Verify**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```
fix(mock): apply multiplier in mock bridge
```

---

### Task 9: Update CLAUDE.md and docs

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Add Live Controls section to CLAUDE.md Key Rules**

Add after the "Windows" section:

```markdown
### Live Controls Panel
- Toggleable panel below the canvas (center column only).
- Contains section cards: Tempo card first, future cards for faders/scenes.
- Toggle state persisted to localStorage.
- Master speed slider uses logarithmic scale (0.0625–4.0).
- Stepped mode snaps to musical divisions (4 Bar → 1/16).
- Shift+drag for free roam continuous values.
```

**Step 2: Commit**

```
docs: add Live Controls panel rules to CLAUDE.md
```

---

### Task 10: Final integration verification

**Step 1: Full Rust build**

Run: `cd src-tauri && cargo build`

**Step 2: Rust tests**

Run: `cargo test --lib`

**Step 3: TypeScript check**

Run: `npx tsc --noEmit`

**Step 4: Manual smoke test**

1. `npm run dev` — app launches, toolbar has compact BPM + LIVE button
2. Click LIVE — panel slides open below canvas
3. Tempo card shows BPM readout, metronome dot, auto/manual, tap
4. Drag speed slider — snaps to musical steps (labels update)
5. Hold Shift + drag — free roam, shows raw value like `1.3×`
6. Click step labels below slider — jumps to that step
7. Metronome dot in both toolbar and panel pulses at effective speed
8. Click LIVE again — panel closes, canvas reclaims space
9. Refresh page — panel open/closed state and speed are remembered
