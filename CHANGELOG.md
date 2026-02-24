# Changelog

All notable changes to FlexMap are documented here.

## [0.2.1] - 2026-02-24

### Fixed

- **Windows CI build**: gate Syphon build.rs code with `target_family = "unix"` so `std::os::unix` symlink calls don't compile on Windows hosts.
- **ISF catalog fetch loop**: replace React state guard (`isFetching`) with a `useRef` guard in ShaderLibraryModal to prevent 40+ rapid re-fetches burning GitHub API rate limit.
- **ISF preview compile errors**: add missing `IMG_THIS_PIXEL`, `IMG_THIS_NORM_PIXEL` function stubs and `lastFrame` uniform to ShaderPreviewCanvas so more ISF shaders compile in preview.
- **Diagnostic log interpolation**: replace all `console.info/warn` calls using `%d`/`%s` format strings with template literals so values render correctly under `tauri-plugin-log`.

### Added

- **GitHub token for ISF catalog**: Settings modal section to save a GitHub personal access token (raises rate limit from 60 to 5,000 req/hr). Token is used for catalog fetch, source download, and install requests.
- **Rate limit detection**: `RateLimitError` class with reset-time display; user-facing toast when GitHub API limit is hit.
- **ISF pipeline diagnostics**: detailed `[ISF-diag]` logging across shader backend (`commands.rs`, `shader.rs`), store (`useAppStore`), and library (`shader-library.ts`) for tracing source sync, compile, and connect flows.
- **Build scripts**: `npm run clean` and `npm run clean:all` for removing build artifacts; release artifact note in `DISTRIBUTION.md`.
- **Shader grid hover preview**: hovering a shader card in the library grid shows a live animated preview instead of a static thumbnail.
- **Preview FPS counter**: live shader preview displays a real-time frame rate indicator.

### Changed

- **Shared WebGL context**: thumbnail renderer reuses a single WebGL context across all shader cards instead of creating/destroying one per render, reducing GPU resource churn.
- **ISF multi-pass support**: shader previews and thumbnails now handle ISF shaders with `PASSES` definitions, `lastFrame`, and buffer target samplers.
- **ISF varying support**: previews dynamically generate matching vertex shaders for ISF fragments that declare custom `varying` variables (neighborhood coords, arrays).
- **Preview error UI**: compile failures show an inline warning icon instead of a fallback thumbnail; loading state shows a spinner.

---

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

## [0.1.0] - 2026-02-10

- Core shell: Tauri scaffolding, dual windows, persistence, autosave.
- 2D editor: layer CRUD, geometry editing, drag/nudge, undo/redo, shortcuts.
- GPU renderer: RenderEngine, pipelines, texture manager, projector render loop.
- Input routing: InputBackend trait, test pattern, media file, Spout, Syphon.
- Persistence: save/load .flexmap JSON, autosave, crash recovery.

[0.2.1]: https://github.com/FlexusDev/flexmap/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/FlexusDev/flexmap/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/FlexusDev/flexmap/releases/tag/v0.1.0
