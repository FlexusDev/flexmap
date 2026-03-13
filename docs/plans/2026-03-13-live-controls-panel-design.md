# Live Controls Panel + Master Speed Slider — Design

## Goal

Replace the discrete BPM multiplier buttons with a master speed slider inside a new toggleable Live Controls panel. The panel sits below the canvas in the center column and will host future live performance controls (faders, scene triggers).

## Layout

```
┌──────┬─────────────┬──────────┐
│ Left │   Canvas    │ Props    │
│      │             │          │
│      ├─────────────┤          │
│      │ Live Ctrls  │          │
│      └─────────────┘          │
├──────┴──────────────┴─────────┤
│          Status Bar           │
└───────────────────────────────┘
```

- Panel spans **center column only** (same width as canvas)
- Toggleable drawer, ~140px tall, collapses to 0px
- Toggle button in the toolbar (near BPM widget)
- Section-based layout — each section is a bordered card
- First section: **Tempo**. Future sections added as new cards.

## Toolbar Changes

**Remove from toolbar:**
- Multiplier buttons (÷4, ÷2, 1x, ×2, ×4)
- Auto/Manual toggle
- Tap tempo button

**Keep in toolbar:**
- Compact BPM readout + metronome dot (read-only indicator)
- Toggle button for Live Controls panel

## Tempo Card

**Row 1 — BPM display + controls:**
- Large BPM readout (e.g. `120.0`)
- Metronome dot (phase-based pulse)
- Auto/Manual toggle
- Tap tempo button

**Row 2 — Master Speed slider:**
- Horizontal slider, full card width
- Stepped mode (default): snaps to musical divisions in 4/4

| Value  | Label  | Meaning                    |
|--------|--------|----------------------------|
| 0.0625 | 4 Bar  | Cycle spans 4 bars         |
| 0.125  | 2 Bar  | Cycle spans 2 bars         |
| 0.25   | 1 Bar  | One cycle per bar          |
| 0.5    | 1/2    | Half bar                   |
| 1.0    | Beat   | One per beat               |
| 2.0    | 1/8    | Eighth note                |
| 4.0    | 1/16   | Sixteenth note             |

- Shift+drag: free roam continuous (0.0625–4.0), label shows raw value like `1.3×`
- Current step label displayed next to slider
- Affects: metronome dot rate + all pixel map pattern animation

## Data Flow

```
Slider → store.setBpmMultiplier(value)
  → IPC set_bpm_multiplier
  → BpmEngine.set_multiplier(value)  // clamp to [0.0625, 4.0]
  → state.multiplier
  → BpmRuntimeSnapshot.multiplier
  → RenderState.bpm_multiplier
  → LayerUniforms.pxmap_anim[0] = (phase * multiplier * speed).fract()
  → WGSL shader animation
```

Metronome dot in toolbar: reads `phase * multiplier` so it pulses at effective speed.

## Rust Changes

- `set_multiplier()`: remove `VALID` whitelist, accept any f32 clamped to `[0.0625, 4.0]`
- No new Tauri commands needed

## Persistence

- `multiplier` saved to localStorage with BPM config
- `liveControlsOpen: boolean` in Zustand store, persisted to localStorage

## Future

The Live Controls panel is designed to grow:
- Additional fader cards (intensity, color temperature)
- Scene trigger buttons
- Each as a new card section in the panel
