# wgpu Reference (v26)

> Upgraded from v23 to v26. Key API changes: `TexelCopyTextureInfo` (was `ImageCopyTexture`),
> `TexelCopyBufferLayout` (was `ImageDataLayout`), `depth_slice: None` on `RenderPassColorAttachment`,
> `Instance::new(&desc)` takes reference, `request_adapter` returns `Result`.

## Project Usage

- `RenderEngine` composites layers onto an offscreen texture, then blits to the projector surface.
- `RenderState` is the thread-safe intermediary between IPC commands and the renderer.
- Metal backend on macOS, D3D12/Vulkan on Windows.

## Key Files

- `src-tauri/src/renderer/engine.rs` — main render loop, surface management
- `src-tauri/src/renderer/pipeline.rs` — render pipeline setup
- `src-tauri/src/renderer/gpu.rs` — device/adapter init
- `src-tauri/src/renderer/shaders/` — WGSL shaders
- `src-tauri/src/renderer/texture_manager.rs` — texture atlas and lifecycle
- `src-tauri/src/renderer/buffer_cache.rs` — vertex/index buffer pooling
- `src-tauri/src/renderer/projector.rs` — projector surface rendering

## Patterns

### Surface Creation
```rust
// wgpu 23 pattern — surface is created from raw window handle
let surface = instance.create_surface(window)?;
let config = surface.get_default_config(&adapter, width, height)
    .expect("Surface not supported");
device.configure_surface(&surface, &config);
```

### Pipeline Creation
```rust
let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
    layout: Some(&pipeline_layout),
    vertex: wgpu::VertexState { module: &shader, entry_point: Some("vs_main"), buffers: &[vertex_layout] },
    fragment: Some(wgpu::FragmentState { module: &shader, entry_point: Some("fs_main"), targets: &[Some(color_target)] }),
    primitive: wgpu::PrimitiveState::default(),
    depth_stencil: None,
    multisample: wgpu::MultisampleState::default(),
    multiview: None,
    cache: None,
});
```

### Texture Upload
```rust
queue.write_texture(
    wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
    &rgba_data,
    wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4 * width), rows_per_image: Some(height) },
    size,
);
```

## Environment Variables (for debugging)
- `WGPU_BACKEND=vulkan|metal|dx12|gl` — force backend
- `WGPU_ADAPTER_NAME=substring` — pick specific GPU
- `WGPU_POWER_PREF=high|low` — power preference

## Breaking Changes in Newer Versions (DO NOT APPLY)
- v24: `SurfaceConfiguration` API changes, `entry_point` becomes required `Option<&str>`
- v25: `TexelCopyBufferLayout`/`TexelCopyTextureInfo` renamed from `ImageCopyBuffer`/`ImageCopyTexture`
- v26: Environment-based rendering, further surface API rework
