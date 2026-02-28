# Changelog

All notable changes to FlexMap are documented here.

## [0.2.4] - 2026-02-28

### Fixed

- **Projector black screen on Windows**: the engine's blit pipeline is compiled for `Bgra8Unorm`, but `get_default_config` on DX12 returns `Bgra8UnormSrgb` as the swapchain format. The format mismatch caused wgpu to silently discard every blit, leaving the projector window black regardless of source. Forced the surface to `Bgra8Unorm` on Windows so pipeline and surface formats match. The selected format is now logged at startup (`[projector] surface format`).
- **Spout capture stale data on Windows**: `CopyResource` is asynchronous — mapping the staging texture immediately after could read garbage or stale pixels on some drivers. Added `context.Flush()` between the copy and the map, matching the reference Spout2 implementation.
- **Spout capture failing on multi-GPU systems**: `D3D11CreateDevice` was called with the default adapter (`None`), which on laptops with iGPU + dGPU picks adapter 0 (often the iGPU). If the Spout sender runs on the dGPU, `OpenSharedResource` fails because legacy D3D11 shared handles are not cross-adapter. The D3D11 receiver now enumerates DXGI adapters explicitly (0 → 3) and creates a device on the first available hardware adapter. Adapter name is logged at startup (`[spout] D3D11 device on adapter N 'GPU name'`).
- **Spout adapter auto-retry**: if `OpenSharedResource` still fails (sender on a different adapter than the one FlexMap opened), the backend automatically retries on the next adapter within ~66ms without blocking the render thread.

---

## [0.2.3] - 2026-02-28

### Fixed

- **Windows white screen (shader effects)**: source textures were created as `Rgba8UnormSrgb` / `Bgra8UnormSrgb`, which some DX12 drivers don't support for simultaneous `TEXTURE_BINDING + COPY_DST`. Switched to the non-sRGB `Rgba8Unorm` / `Bgra8Unorm` variants, which are universally supported. Shader effects and Spout sources now render correctly instead of showing solid white.
- **Windows offscreen format mismatch**: the engine's offscreen, ping-pong, and layer-temp textures were hardcoded to `Bgra8UnormSrgb` even on Windows where DX12's `get_default_config` returns `Bgra8Unorm`. Added a `#[cfg(windows)]` guard so each platform uses the correct format.
- **Spout errors silent in release builds**: D3D11 capture failures (`OpenSharedResource`, staging create, `Map`) were logged at `debug!` level — invisible in release `.zip` runs. All per-step failures now emit named `warn!` messages identifying exactly which D3D11 call failed and for which sender.
- **Frame pump silent on no-frames**: if sources are bound but `poll_frame` returns nothing (e.g. sender gone, D3D11 error), the frame pump now logs an `info!` message once per tick — visible in `cmd.exe` without needing `RUST_LOG=debug`.

---

## [0.2.2] - 2026-02-28

### Fixed

- **Spout on Windows**: Spout backend was never compiled into Windows builds because `input-spout` was missing from the default Cargo features. Windows users now get Spout source discovery out of the box with no manual flags required.
- **Spout D3D11 API compatibility**: updated `spout/mod.rs` for the `windows` crate 0.61 API — `CreateTexture2D`, `OpenSharedResource`, and `Map` all switched to out-pointer patterns; `HANDLE`, `DXGI_FORMAT`, and texture descriptor flag fields updated to match the new type signatures.
- **Spout source refresh**: `SpoutBackend` now implements `fn refresh()` so clicking Refresh in the Sources panel correctly rescans for new Spout senders instead of silently no-opping.
- **Syphon banner on Windows**: the "Syphon not available" warning no longer appears on Windows — the banner now only shows when Syphon is compiled in but fails to load at runtime (a genuine macOS error), not simply because Syphon isn't applicable to the platform.

---

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

[0.2.4]: https://github.com/FlexusDev/flexmap/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/FlexusDev/flexmap/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/FlexusDev/flexmap/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/FlexusDev/flexmap/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/FlexusDev/flexmap/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/FlexusDev/flexmap/releases/tag/v0.1.0
