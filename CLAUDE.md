# FlexMap — Claude Development Rules

## Project Overview

FlexMap is a lightweight projection mapping desktop app for live visual artists.
Stack: Tauri v2 (Rust backend + React/TypeScript/Tailwind frontend), wgpu v23 (Metal on macOS, D3D12 on Windows).

## Required Reading

**Before touching code in any of these areas, you MUST read the corresponding doc file first.**

| Area | Read first | Trigger |
|------|-----------|---------|
| GPU / rendering / shaders / wgpu | `docs/wgpu.md` | Any file in `src-tauri/src/renderer/` |
| Tauri commands / IPC / state sync | `docs/tauri-ipc.md` | Any file in `commands.rs`, `lib.rs`, `tauri-bridge.ts` |
| React / Zustand / store / hooks | `docs/react-zustand.md` | Any file in `src/store/`, `src/hooks/`, `src/components/` |
| Tailwind / Vite / build tooling | `docs/tailwind-vite.md` | Any config file, build script, or CSS |
| Input backends / Syphon / Spout | `docs/input-backends.md` | Any file in `src-tauri/src/input/` |
| Windows / D3D11 / Spout internals | `docs/spout-windows.md` | Any `cfg(windows)` or Spout code |

## Pinned Versions — DO NOT UPGRADE

All major deps are pinned. Upgrades have breaking changes. Do not bump:

| Dep | Pinned | Latest (breaking) | Why not |
|-----|--------|-------------------|---------|
| wgpu | 23 | 26 | Surface, pipeline, shader API rewrites |
| React | 18.3 | 19.x | New compiler, hooks changes |
| Zustand | 4.5 | 5.x | `useShallow` required, stricter types |
| Tailwind | 3.4 | 4.x | Full rewrite, CSS-first config |
| Vite | 5.4 | 7.x | Node 18 dropped, env API changes |
| Tauri | 2.10 | 2.10 | Already latest |

## Architecture

- **Rust backend** is source of truth for scene state (layers, geometry, calibration, output config).
- **React frontend** communicates via Tauri IPC commands defined in `commands.rs`.
- **Browser mock mode**: `tauri-bridge.ts` provides mocks so UI works with `npm run dev`.
- **GPU rendering**: `RenderEngine` → offscreen texture → projector surface. `RenderState` bridges IPC and renderer.
- **Input pipeline**: `InputBackend` trait with feature-gated backends (Syphon, Spout). `InputManager` aggregates.

## Key Rules

### Undo/Redo
- Snapshot-based: clones entire `Vec<Layer>`.
- Call `begin_interaction()` ONCE before a drag/nudge burst starts.
- `update_layer_geometry()` does NOT push undo — snapshot was taken at interaction start.
- High-frequency updates (sliders, geometry drag) must NOT push undo per-frame.
- Discrete actions (add/remove/duplicate/reorder/set_source) push undo internally.

### Keyboard Shortcuts
- When adding a shortcut to `useKeyboardShortcuts.ts` or `EditorCanvas.tsx`, you MUST also add a matching entry to `SHORTCUTS` in `components/common/KeyboardOverlay.tsx`.
- Include: `keys`, `label`, `description`, `category`.

### Windows
- Main window: full editor UI. KeyboardOverlay lives HERE only.
- Projector window: fullscreen output only. No UI overlays.

### File Organization
- Rust: `scene/`, `renderer/`, `input/`, `persistence/`
- React: `components/`, `store/`, `hooks/`, `lib/`, `types/`

### Testing
- `cargo tauri dev` — full-stack testing
- `npm run dev` — frontend-only with mock backend
- Always verify `cargo build` passes before asking user to test

### Logging
- Noisy modules default to `warn`; high-frequency lines use `debug!`.
- `RUST_LOG=debug` for full verbosity.
- Frontend: `tauri-plugin-log` with `attachConsole()` pipes to terminal.

### Git
- `.claude/` directory is in `.gitignore`.

## PRD Milestones Status

- **A: Core Shell** — Done
- **B: 2D Editor** — Done
- **C: GPU Renderer** — Done
- **D: Input Routing** — Done
- **E: Persistence** — Done
