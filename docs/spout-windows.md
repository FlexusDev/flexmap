# Spout / Windows-Specific Reference

> **windows crate pinned at 0.61.x.** Multiple older versions exist in the dependency tree (0.54, 0.57, 0.58) via transitive deps — this is normal.

## Windows Crate Features Used
```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.61", features = [
    "Win32_Foundation",
    "Win32_System_Memory",
    "Win32_System_Com",
    "Win32_Graphics_Direct3D",
    "Win32_Graphics_Direct3D11",
    "Win32_Graphics_Dxgi_Common",
] }
windows-core = "0.61"
webview2-com = "0.38"
```

## Spout Integration
- D3D11 device creation for shared texture access
- Shared texture handle opened via `OpenSharedResource`
- Texture copied to wgpu-compatible format for compositing

## Key Files
- `src-tauri/src/input/spout/` — Spout client implementation
- `src-tauri/src/renderer/` — GPU rendering (wgpu interop with D3D11 textures on Windows)
