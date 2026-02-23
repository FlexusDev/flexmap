# AuraMap — Claude Development Rules

## Project Overview

AuraMap is a lightweight projection mapping desktop app for live visual artists.
Stack: Tauri v2 (Rust backend + React/TypeScript/Tailwind frontend), wgpu v23 (Metal on macOS).

## Architecture

- **Rust backend** is the source of truth for scene state (layers, geometry, calibration, output config).
- **React frontend** communicates via Tauri IPC commands defined in `commands.rs`.
- **Browser mock mode**: `tauri-bridge.ts` provides mock implementations for all commands so the UI works with `npm run dev` without Tauri.
- **GPU rendering**: `RenderEngine` composites layers onto an offscreen texture, then blits to the projector surface. `RenderState` is the thread-safe intermediary between IPC commands and the renderer.
- **Input pipeline**: `InputBackend` trait with feature-gated backends (Syphon, Spout, NDI). `InputManager` aggregates all backends.

## Key Patterns

### IPC Command Pattern
Every mutation command in `commands.rs` must:
1. Mutate `SceneState`
2. Call `sync_render_state(&state, &render)` to push changes to the GPU
3. Return the result to the frontend

### Undo/Redo
- Snapshot-based: clones the entire `Vec<Layer>` (fine for <100 layers).
- Call `begin_interaction()` ONCE before a drag/nudge burst starts.
- `update_layer_geometry()` does NOT push undo — the snapshot was taken at interaction start.
- High-frequency updates (property sliders, geometry during drag) must NOT push undo per-frame.
- Discrete actions (add/remove/duplicate/reorder/set_source) push undo internally.

### Borrow Checker
- When you need to clone + mutate on the same `RwLock<T>`, check existence with `.any()` first (immutable borrow ends), clone snapshot, then find with `.iter_mut().find()` (mutable borrow).
- Never hold a read guard and write guard on the same lock simultaneously.

### Frontend State
- Zustand store (`useAppStore`) mirrors backend state.
- All mutations are `async` — they invoke the Tauri command, then optimistically update local state.
- `tauri-bridge.ts` must have a mock for every command registered in `lib.rs`.

## Rules

### Keyboard Shortcuts
- When adding a new keyboard shortcut to `useKeyboardShortcuts.ts` or `EditorCanvas.tsx`, you MUST also add a matching entry to the `SHORTCUTS` array in `components/common/KeyboardOverlay.tsx` so it appears in the virtual keyboard widget.
- Include: `keys` (key IDs matching the virtual keyboard), `label`, `description`, and `category`.

### New Tauri Commands
- Add the command function in `commands.rs`
- Register it in `lib.rs` `invoke_handler`
- Add a mock in `tauri-bridge.ts`
- Add TypeScript types in `types/index.ts` if new data structures are involved

### File Organization
- Rust: `scene/` (state, layers, project, history), `renderer/` (gpu, pipeline, shaders, textures, engine), `input/` (adapter trait, protocol backends), `persistence/` (save/load/autosave)
- React: `components/` (editor, layers, properties, calibration, output, common), `store/`, `hooks/`, `lib/`, `types/`

### Windows
- Main window: full editor UI with all panels. KeyboardOverlay lives HERE only.
- Projector window: fullscreen output only. No UI overlays, no keyboard widget.

### Testing
- `cargo tauri dev` for full-stack testing
- `npm run dev` for frontend-only testing with mock backend
- Always verify `cargo build` passes before asking user to test

## PRD Milestones Status

- **A: Core Shell** — Done (Tauri scaffolding, dual windows, persistence, autosave)
- **B: 2D Editor** — Done (layer CRUD, geometry editing, drag/nudge, undo/redo, keyboard shortcuts)
- **C: GPU Renderer** — Done (RenderEngine, pipelines, shaders, texture manager, GPU projector render loop with direct wgpu surface rendering)
- **D: Input Routing** — In Progress (InputBackend trait, adapter, test pattern generator working; media file backend added; Spout backend implemented with D3D11 shared texture capture; Syphon/NDI remain stubs)
- **E: Persistence** — Done (save/load .auramap JSON, autosave, crash recovery)
