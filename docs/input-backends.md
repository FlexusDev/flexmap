# Input Backend Reference

## Architecture

`InputBackend` trait with feature-gated backends. `InputManager` aggregates all backends.

## Backends

### Syphon (macOS only)
- Feature flag: `input-syphon`
- Metal client via ObjC bridge
- Files: `src-tauri/src/input/syphon/`

### Spout (Windows only)
- Feature flag: `input-spout`
- D3D11 shared texture capture
- Files: `src-tauri/src/input/spout/`

### Test Pattern Generator
- Always available, no feature flag
- Generates procedural test patterns for development
- Files: `src-tauri/src/input/test_pattern.rs`

### Media File Backend
- Loads static images and video files as input sources
- Files: `src-tauri/src/input/media.rs`

## Key Files
- `src-tauri/src/input/mod.rs` — `InputBackend` trait, `InputManager`
- `src-tauri/src/input/adapter.rs` — adapter discovery and routing

## Logging
- Noisier modules (adapter, syphon, test_pattern) default to `warn`
- High-frequency lines (frame pump, check_syphon_status) use `debug!`
- Use `RUST_LOG=debug` for full verbosity when debugging
