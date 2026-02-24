# Changelog

All notable changes to FlexMap are documented here.

## [0.2.0] - 2026-02-24

### Added

- **Shader input & library**
  - Installed shader sources: add/remove custom shader directories, list and connect as layer sources.
  - Shader library modal with browse, preview thumbnails, and add-to-scene.
  - Shader preview canvas for thumbnails and selection.
  - Backend: `input/shader.rs`, `InstalledShaderSource`, `set_installed_shader_sources`, `list_sources` extended for shaders.
- **Audio & BPM**
  - Audio input device selection and BPM config (beats per minute, tap tempo).
  - Backend: `audio/` module with `BpmEngine`, `BpmState`; commands `list_audio_input_devices`, `set_audio_input_device`, `set_bpm_config`, `get_bpm_state`, `tap_tempo`.
- **Inspector & properties**
  - Inspector pane with tabbed panes: Look, Transform, Geometry/UV, Assignment.
  - Dedicated panes: `LookPane`, `TransformPane`, `GeometryUvPane`, `AssignmentPane` under `components/properties/panes/`.
  - Properties panel refactor for clearer layout and pane switching.
- **Projector & output**
  - Projector view improvements: aspect sync, fullscreen handling, and native GPU projector state.
  - Frame polling: `poll_layer_frame`, `poll_all_frames`, `poll_all_frames_delta`, `set_preview_consumers`, `set_frame_pacing`, `get_projector_stats`.
- **Settings & Syphon**
  - Settings modal (app/preferences entry point).
  - Syphon status check and framework install: `check_syphon_status`, `install_syphon_framework`.
- **Distribution & release**
  - `DISTRIBUTION.md`: distribution build instructions (macOS/Windows, portable, cross-compile).
  - GitHub Actions: `.github/workflows/release-build.yml` for release builds and artifacts.
  - Scripts: `scripts/release-mac.sh` and npm scripts `release:mac`, `build:portable:win`, `build:portable:mac`, etc.
  - App icons: 64×64, Store logo, Square variants, android/ios asset sets.
- **UI & store**
  - Left panel layout (`components/left/`), toolbar and source panel updates.
  - Status bar and editor canvas tweaks.
  - Extended `useAppStore` and `tauri-bridge` mocks for new commands and state.
  - Global styles and types updates in `styles/globals.css`, `types/index.ts`.

### Changed

- **Backend**
  - `commands.rs`: many new commands (audio, BPM, shader, Syphon, frame polling, projector stats).
  - `lib.rs`: plugin and state setup for audio/BPM, projector window and GPU state.
  - Input adapter and Syphon module adjustments for shader sources and source info.
  - Scene layer and state: support for new layer/source options.
  - `build.rs`: icon and bundle configuration updates.
- **Frontend**
  - `App.tsx`, `main.tsx`: routing, modals (Settings, Shader Library), and layout.
  - `ProjectorView.tsx`: improved projector window handling and preview consumers.
  - `PropertiesPanel.tsx` refactored into inspector + panes.
- **Config**
  - `tauri.conf.json` and `capabilities/default.json` updated for new features.
  - `CLAUDE.md`: PRD milestones and rules refreshed.

### Fixed

- Projector window state (native vs webview) and fullscreen handling.
- Source listing and connection flow with shader and media sources.

---

## [0.1.0] - Initial release

- Core shell: Tauri scaffolding, dual windows, persistence, autosave.
- 2D editor: layer CRUD, geometry editing, drag/nudge, undo/redo, shortcuts.
- GPU renderer: RenderEngine, pipelines, texture manager, projector render loop.
- Input routing: InputBackend trait, test pattern, media file, Spout, Syphon.
- Persistence: save/load .flexmap JSON, autosave, crash recovery.

[0.2.0]: https://github.com/FlexusDev/flexmap/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/FlexusDev/flexmap/releases/tag/v0.1.0
