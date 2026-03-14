//! RenderEngine — owns GPU state, runs the render loop, composites layers & calibration patterns.
//!
//! The engine is designed to be driven by Tauri events:
//! - Scene changes trigger a re-render
//! - Calibration mode swaps the pipeline
//! - The projector window surface is managed here

use parking_lot::RwLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use wgpu::util::DeviceExt;

use super::buffer_cache::BufferCache;
use super::gpu::{FramePacingMode, GpuContext};
use super::pipeline::{
    blend_mode_to_u32, generate_layer_calibration_mesh, generate_layer_mesh, BlendUniforms,
    BpmRenderSnapshot, CalibrationUniforms, LayerUniforms, LayerVertex, RenderPipeline,
};
use super::texture_manager::TextureManager;
use crate::scene::group::LayerGroup;
use crate::scene::layer::{BlendMode, Layer};
use crate::scene::project::{CalibrationConfig, CalibrationPattern};

/// Shared render state that the Tauri commands can push updates into
pub struct RenderState {
    pub layers: RwLock<Vec<Layer>>,
    pub groups: RwLock<Vec<LayerGroup>>,
    pub calibration: RwLock<CalibrationConfig>,
    pub needs_redraw: RwLock<bool>,
    pub output_width: RwLock<u32>,
    pub output_height: RwLock<u32>,
    pub frame_pacing: RwLock<FramePacingMode>,
    /// Monotonically increasing counter, bumped by update_layers().
    /// The projector uses this to skip prepare_all_buffers when layers haven't changed.
    pub layer_generation: AtomicU64,
    /// Current BPM snapshot, updated by the frame pump each tick.
    pub bpm: RwLock<BpmRenderSnapshot>,
    /// Preview quality as fraction of output resolution (0.25, 0.5, 0.75, 1.0)
    pub preview_quality: RwLock<f32>,
}

impl RenderState {
    pub fn new() -> Self {
        Self {
            layers: RwLock::new(Vec::new()),
            groups: RwLock::new(Vec::new()),
            calibration: RwLock::new(CalibrationConfig::default()),
            needs_redraw: RwLock::new(true),
            output_width: RwLock::new(1920),
            output_height: RwLock::new(1080),
            frame_pacing: RwLock::new(FramePacingMode::default()),
            layer_generation: AtomicU64::new(0),
            bpm: RwLock::new(BpmRenderSnapshot::default()),
            preview_quality: RwLock::new(0.5),
        }
    }

    pub fn update_scene(&self, layers: Vec<Layer>, groups: Vec<LayerGroup>) {
        *self.layers.write() = layers;
        *self.groups.write() = groups;
        self.layer_generation.fetch_add(1, Ordering::Release);
        *self.needs_redraw.write() = true;
    }

    /// Current layer generation (monotonically increasing on each update_layers call).
    pub fn layer_generation(&self) -> u64 {
        self.layer_generation.load(Ordering::Acquire)
    }

    pub fn update_calibration(&self, config: CalibrationConfig) {
        *self.calibration.write() = config;
        *self.needs_redraw.write() = true;
    }

    pub fn request_redraw(&self) {
        self.layer_generation.fetch_add(1, Ordering::Release);
        *self.needs_redraw.write() = true;
    }

    pub fn take_redraw(&self) -> bool {
        let mut flag = self.needs_redraw.write();
        let val = *flag;
        *flag = false;
        val
    }

    pub fn update_bpm(&self, bpm: BpmRenderSnapshot) {
        *self.bpm.write() = bpm;
    }

    pub fn set_preview_quality(&self, quality: f32) {
        *self.preview_quality.write() = quality.clamp(0.1, 1.0);
        *self.needs_redraw.write() = true;
    }
}

impl Default for RenderState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::layer::Layer;
    use crate::scene::project::CalibrationConfig;

    #[test]
    fn new_defaults() {
        let rs = RenderState::new();
        assert_eq!(rs.layer_generation(), 0);
        // needs_redraw starts true (initial render needed)
        assert!(*rs.needs_redraw.read());
    }

    #[test]
    fn update_layers_increments_generation() {
        let rs = RenderState::new();
        assert_eq!(rs.layer_generation(), 0);

        rs.update_scene(vec![Layer::new_quad("L1", 0)], Vec::new());
        assert_eq!(rs.layer_generation(), 1);

        rs.update_scene(vec![], Vec::new());
        assert_eq!(rs.layer_generation(), 2);
    }

    #[test]
    fn request_redraw_and_take_redraw() {
        let rs = RenderState::new();
        // Consume initial redraw
        assert!(rs.take_redraw());
        assert!(!rs.take_redraw());

        rs.request_redraw();
        assert!(rs.take_redraw());
        assert!(!rs.take_redraw());
    }

    #[test]
    fn preview_quality_defaults_and_clamps() {
        let rs = RenderState::new();
        assert_eq!(*rs.preview_quality.read(), 0.5);

        rs.set_preview_quality(0.75);
        assert_eq!(*rs.preview_quality.read(), 0.75);
        assert!(*rs.needs_redraw.read());

        // Clamp to [0.1, 1.0]
        rs.set_preview_quality(0.0);
        assert_eq!(*rs.preview_quality.read(), 0.1);
        rs.set_preview_quality(2.0);
        assert_eq!(*rs.preview_quality.read(), 1.0);
    }

    #[test]
    fn update_calibration_does_not_panic() {
        let rs = RenderState::new();
        let config = CalibrationConfig::default();
        rs.update_calibration(config);
        assert!(*rs.needs_redraw.read());
    }
}

/// The main render engine — composites layers onto an offscreen texture,
/// then blits to the projector surface.
pub struct RenderEngine {
    pub gpu: GpuContext,
    pub pipeline: RenderPipeline,
    pub texture_manager: TextureManager,
    /// Offscreen render target (composited scene)
    pub offscreen_texture: wgpu::Texture,
    pub offscreen_view: wgpu::TextureView,
    pub offscreen_width: u32,
    pub offscreen_height: u32,
    /// 1x1 white texture used as fallback when no source is assigned
    pub white_texture: wgpu::Texture,
    pub white_texture_view: wgpu::TextureView,
    /// Ping-pong texture for multi-pass blend compositing
    pub ping_pong_texture: wgpu::Texture,
    pub ping_pong_view: wgpu::TextureView,
    /// Temporary texture for rendering a single layer before blend-compositing
    pub layer_temp_texture: wgpu::Texture,
    pub layer_temp_view: wgpu::TextureView,
    /// Buffer cache for dirty tracking (avoids rebuilding buffers every frame)
    pub buffer_cache: BufferCache,
    /// Cached blit bind groups + uniform buffer (rebuilt only on offscreen resize)
    blit_cache: Option<BlitCache>,
    /// Preview offscreen (smaller resolution for editor)
    pub preview_texture: wgpu::Texture,
    pub preview_view: wgpu::TextureView,
    pub preview_ping_pong: wgpu::Texture,
    pub preview_ping_pong_view: wgpu::TextureView,
    pub preview_layer_temp: wgpu::Texture,
    pub preview_layer_temp_view: wgpu::TextureView,
    pub preview_width: u32,
    pub preview_height: u32,
    /// Staging buffer for GPU->CPU readback
    pub preview_staging_buffer: wgpu::Buffer,
    pub preview_staging_size: u64,
    preview_blit_cache: Option<BlitCache>,
}

/// Cached GPU objects for the blit pass (offscreen → surface).
/// Content is constant (blend_mode=0, opacity=1.0), only the offscreen
/// texture view reference changes on resize.
struct BlitCache {
    source_bg: wgpu::BindGroup,
    dest_bg: wgpu::BindGroup,
    uniform_bg: wgpu::BindGroup,
}

pub struct PreviewReadback {
    device: Arc<wgpu::Device>,
    staging_buffer: wgpu::Buffer,
    width: u32,
    height: u32,
    bytes_per_row: u32,
}

impl RenderEngine {
    pub fn new(gpu: GpuContext, width: u32, height: u32) -> Self {
        // Surface/offscreen format: Bgra8UnormSrgb on macOS (Metal default);
        // Bgra8Unorm on Windows (DX12 default, and avoids sRGB COPY_DST issues).
        #[cfg(windows)]
        let surface_format = wgpu::TextureFormat::Bgra8Unorm;
        #[cfg(not(windows))]
        let surface_format = wgpu::TextureFormat::Bgra8UnormSrgb;
        let pipeline = RenderPipeline::new(&gpu.device, surface_format);
        let texture_manager = TextureManager::new();

        let (offscreen_texture, offscreen_view) =
            Self::create_offscreen_target(&gpu.device, width, height, surface_format);

        // Create a 1x1 white texture as fallback
        let white_texture = gpu.device.create_texture_with_data(
            &gpu.queue,
            &wgpu::TextureDescriptor {
                label: Some("White Fallback"),
                size: wgpu::Extent3d {
                    width: 1,
                    height: 1,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            },
            wgpu::util::TextureDataOrder::LayerMajor,
            &[255u8, 255, 255, 255],
        );
        let white_texture_view = white_texture.create_view(&wgpu::TextureViewDescriptor::default());

        let (ping_pong_texture, ping_pong_view) =
            Self::create_offscreen_target(&gpu.device, width, height, surface_format);
        let (layer_temp_texture, layer_temp_view) =
            Self::create_offscreen_target(&gpu.device, width, height, surface_format);

        let blit_cache =
            Self::build_blit_cache(&gpu.device, &pipeline, &offscreen_view, &white_texture_view);

        // Create preview offscreen at 50% default (960x540 for 1920x1080)
        let preview_width = (width / 2).max(64);
        let preview_height = (height / 2).max(64);
        let (preview_texture, preview_view) = Self::create_offscreen_target(
            &gpu.device,
            preview_width,
            preview_height,
            surface_format,
        );
        let (preview_ping_pong, preview_ping_pong_view) = Self::create_offscreen_target(
            &gpu.device,
            preview_width,
            preview_height,
            surface_format,
        );
        let (preview_layer_temp, preview_layer_temp_view) = Self::create_offscreen_target(
            &gpu.device,
            preview_width,
            preview_height,
            surface_format,
        );

        let preview_bytes_per_row = (preview_width * 4).next_multiple_of(256);
        let preview_staging_size = (preview_bytes_per_row * preview_height) as u64;
        let preview_staging_buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Preview Staging"),
            size: preview_staging_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        let preview_blit_cache =
            Self::build_blit_cache(&gpu.device, &pipeline, &preview_view, &white_texture_view);

        Self {
            gpu,
            pipeline,
            texture_manager,
            offscreen_texture,
            offscreen_view,
            offscreen_width: width,
            offscreen_height: height,
            white_texture,
            white_texture_view,
            ping_pong_texture,
            ping_pong_view,
            layer_temp_texture,
            layer_temp_view,
            buffer_cache: BufferCache::new(),
            blit_cache: Some(blit_cache),
            preview_texture,
            preview_view,
            preview_ping_pong,
            preview_ping_pong_view,
            preview_layer_temp,
            preview_layer_temp_view,
            preview_width,
            preview_height,
            preview_staging_buffer,
            preview_staging_size,
            preview_blit_cache: Some(preview_blit_cache),
        }
    }

    fn create_offscreen_target(
        device: &wgpu::Device,
        width: u32,
        height: u32,
        format: wgpu::TextureFormat,
    ) -> (wgpu::Texture, wgpu::TextureView) {
        let tex = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("Offscreen Render Target"),
            size: wgpu::Extent3d {
                width: width.max(1),
                height: height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
        (tex, view)
    }

    /// Resize the offscreen target (and associated ping-pong / temp textures)
    pub fn resize_offscreen(&mut self, width: u32, height: u32) {
        if width == self.offscreen_width && height == self.offscreen_height {
            return;
        }
        #[cfg(windows)]
        let format = wgpu::TextureFormat::Bgra8Unorm;
        #[cfg(not(windows))]
        let format = wgpu::TextureFormat::Bgra8UnormSrgb;
        let (tex, view) = Self::create_offscreen_target(&self.gpu.device, width, height, format);
        self.offscreen_texture = tex;
        self.offscreen_view = view;
        let (pp_tex, pp_view) =
            Self::create_offscreen_target(&self.gpu.device, width, height, format);
        self.ping_pong_texture = pp_tex;
        self.ping_pong_view = pp_view;
        let (lt_tex, lt_view) =
            Self::create_offscreen_target(&self.gpu.device, width, height, format);
        self.layer_temp_texture = lt_tex;
        self.layer_temp_view = lt_view;
        self.offscreen_width = width;
        self.offscreen_height = height;
        self.blit_cache = Some(Self::build_blit_cache(
            &self.gpu.device,
            &self.pipeline,
            &self.offscreen_view,
            &self.white_texture_view,
        ));
    }

    /// Resize the preview offscreen target and staging buffer.
    pub fn resize_preview(&mut self, width: u32, height: u32) {
        if width == self.preview_width && height == self.preview_height {
            return;
        }
        #[cfg(windows)]
        let format = wgpu::TextureFormat::Bgra8Unorm;
        #[cfg(not(windows))]
        let format = wgpu::TextureFormat::Bgra8UnormSrgb;

        let (tex, view) = Self::create_offscreen_target(&self.gpu.device, width, height, format);
        self.preview_texture = tex;
        self.preview_view = view;
        let (pp_tex, pp_view) =
            Self::create_offscreen_target(&self.gpu.device, width, height, format);
        self.preview_ping_pong = pp_tex;
        self.preview_ping_pong_view = pp_view;
        let (lt_tex, lt_view) =
            Self::create_offscreen_target(&self.gpu.device, width, height, format);
        self.preview_layer_temp = lt_tex;
        self.preview_layer_temp_view = lt_view;
        self.preview_width = width;
        self.preview_height = height;

        let bytes_per_row = (width * 4).next_multiple_of(256);
        self.preview_staging_size = (bytes_per_row * height) as u64;
        self.preview_staging_buffer = self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Preview Staging"),
            size: self.preview_staging_size,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        self.preview_blit_cache = Some(Self::build_blit_cache(
            &self.gpu.device,
            &self.pipeline,
            &self.preview_view,
            &self.white_texture_view,
        ));
    }

    /// Render the full scene at preview resolution to the preview offscreen texture,
    /// then copy to the staging buffer for CPU readback.
    /// Returns the bytes_per_row for the staging buffer layout.
    pub fn render_preview(
        &self,
        layers: &[Layer],
        groups: &[LayerGroup],
        calibration: &CalibrationConfig,
        bpm: BpmRenderSnapshot,
    ) -> u32 {
        let bytes_per_row = (self.preview_width * 4).next_multiple_of(256);

        // Render the scene into the preview offscreen using the preview-sized textures.
        // We temporarily use preview_texture/preview_ping_pong/preview_layer_temp as
        // the render targets by calling a dedicated preview scene render method.
        let scene_cmd = self.render_scene_to_preview(layers, groups, calibration, bpm);

        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Preview Readback"),
            });

        // Copy preview texture -> staging buffer
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.preview_texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &self.preview_staging_buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(self.preview_height),
                },
            },
            wgpu::Extent3d {
                width: self.preview_width,
                height: self.preview_height,
                depth_or_array_layers: 1,
            },
        );

        self.gpu.queue.submit([scene_cmd, encoder.finish()]);
        bytes_per_row
    }

    /// Render the full scene directly into the preview-sized textures.
    /// This mirrors render_scene but targets preview_texture instead of offscreen_texture.
    fn render_scene_to_preview(
        &self,
        layers: &[Layer],
        groups: &[LayerGroup],
        calibration: &CalibrationConfig,
        bpm: BpmRenderSnapshot,
    ) -> wgpu::CommandBuffer {
        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Preview Scene Render Encoder"),
            });

        if calibration.enabled {
            if let Some(ref target) = calibration.target_layer {
                self.render_layers_multipass_to(
                    &mut encoder,
                    layers,
                    groups,
                    bpm,
                    &self.preview_texture,
                    &self.preview_view,
                    &self.preview_ping_pong,
                    &self.preview_ping_pong_view,
                    &self.preview_layer_temp_view,
                    self.preview_width,
                    self.preview_height,
                );
                if let Some(target_layer) =
                    layers.iter().find(|l| l.id == target.layer_id && l.visible)
                {
                    let (verts, idxs) = generate_layer_calibration_mesh(&target_layer.geometry);
                    if !verts.is_empty() {
                        self.render_face_calibration_pass_to(
                            &mut encoder,
                            calibration,
                            &verts,
                            &idxs,
                            &self.preview_view,
                        );
                    }
                }
            } else {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Preview Calibration Pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &self.preview_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                self.render_calibration_pass(&mut pass, calibration);
            }
        } else {
            self.render_layers_multipass_to(
                &mut encoder,
                layers,
                groups,
                bpm,
                &self.preview_texture,
                &self.preview_view,
                &self.preview_ping_pong,
                &self.preview_ping_pong_view,
                &self.preview_layer_temp_view,
                self.preview_width,
                self.preview_height,
            );
        }

        encoder.finish()
    }

    /// Read back the preview staging buffer. Call after render_preview + queue.submit.
    /// Returns RGBA pixels ready for the frontend.
    pub fn read_preview_pixels(&self, bytes_per_row: u32) -> Vec<u8> {
        match Self::read_preview_pixels_from_snapshot(self.snapshot_preview_readback(bytes_per_row))
        {
            Ok(pixels) => pixels,
            Err(error) => {
                log::warn!("Preview readback failed: {}", error);
                Vec::new()
            }
        }
    }

    pub fn snapshot_preview_readback(&self, bytes_per_row: u32) -> PreviewReadback {
        PreviewReadback {
            device: self.gpu.device.clone(),
            staging_buffer: self.preview_staging_buffer.clone(),
            width: self.preview_width,
            height: self.preview_height,
            bytes_per_row,
        }
    }

    pub fn read_preview_pixels_from_snapshot(snapshot: PreviewReadback) -> Result<Vec<u8>, String> {
        let buffer_slice = snapshot.staging_buffer.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        buffer_slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
        let _ = snapshot.device.poll(wgpu::PollType::Wait);
        rx.recv()
            .map_err(|_| "preview readback channel dropped".to_string())?
            .map_err(|error| format!("preview staging map failed: {error}"))?;

        let data = buffer_slice.get_mapped_range();
        let w = snapshot.width as usize;
        let h = snapshot.height as usize;
        let bpr = snapshot.bytes_per_row as usize;
        let mut pixels = Vec::with_capacity(w * h * 4);

        for row in 0..h {
            let start = row * bpr;
            let end = start + w * 4;
            pixels.extend_from_slice(&data[start..end]);
        }
        drop(data);
        snapshot.staging_buffer.unmap();

        // BGRA -> RGBA swizzle
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }

        Ok(pixels)
    }

    /// Pre-populate the buffer cache for all visible layers.
    /// Must be called before render_scene (needs &mut self, which render_scene doesn't).
    pub fn prepare_all_buffers(
        &mut self,
        layers: &[Layer],
        groups: &[LayerGroup],
        bpm: BpmRenderSnapshot,
    ) {
        let dimmer_now_ms = super::pipeline::current_dimmer_time_millis();
        let layer_ids: Vec<String> = layers.iter().map(|l| l.id.clone()).collect();
        self.buffer_cache.retain_layers(&layer_ids);

        for layer in layers.iter().filter(|l| l.visible) {
            let texture_view = self
                .texture_manager
                .get_texture_view(&layer.id)
                .unwrap_or(&self.white_texture_view);

            self.buffer_cache.prepare_layer(
                &self.gpu.device,
                &self.gpu.queue,
                &self.pipeline.layer_bind_group_layout,
                &self.pipeline.sampler,
                texture_view,
                &self.texture_manager,
                layers,
                layer,
                groups,
                bpm,
                dimmer_now_ms,
            );
        }
    }

    pub fn refresh_dynamic_uniforms(
        &mut self,
        layers: &[Layer],
        groups: &[LayerGroup],
        bpm: BpmRenderSnapshot,
    ) {
        let dimmer_now_ms = super::pipeline::current_dimmer_time_millis();
        self.buffer_cache.refresh_dynamic_uniforms(
            &self.gpu.queue,
            layers,
            groups,
            bpm,
            dimmer_now_ms,
        );
    }

    /// Render the full scene to the offscreen texture.
    /// Uses multi-pass ping-pong compositing for complex blend modes.
    /// Returns the command buffer ready for submission.
    /// Call prepare_all_buffers() first if you want cache benefits.
    /// The BPM snapshot drives pixel mapping animation and synced dimmer timing.
    pub fn render_scene(
        &self,
        layers: &[Layer],
        groups: &[LayerGroup],
        calibration: &CalibrationConfig,
        bpm: BpmRenderSnapshot,
    ) -> wgpu::CommandBuffer {
        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Scene Render Encoder"),
            });

        if calibration.enabled {
            if let Some(ref target) = calibration.target_layer {
                // Layer-level calibration: render scene normally then overlay pattern on target layer
                self.render_layers_multipass(&mut encoder, layers, groups, bpm);
                if let Some(target_layer) =
                    layers.iter().find(|l| l.id == target.layer_id && l.visible)
                {
                    let (verts, idxs) = generate_layer_calibration_mesh(&target_layer.geometry);
                    if !verts.is_empty() {
                        self.render_face_calibration_pass(&mut encoder, calibration, &verts, &idxs);
                    }
                }
            } else {
                // Global calibration: single fullscreen pass
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Calibration Pass"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &self.offscreen_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });
                self.render_calibration_pass(&mut pass, calibration);
            }
        } else {
            // Layer compositing with blend modes
            self.render_layers_multipass(&mut encoder, layers, groups, bpm);
        }

        encoder.finish()
    }

    /// Check whether a blend mode can use hardware blending (single-pass)
    fn is_hw_blend(mode: &BlendMode) -> bool {
        matches!(mode, BlendMode::Normal | BlendMode::Additive)
    }

    /// Render all visible layers with proper blend mode support.
    /// Normal/Additive: hardware blend directly onto the composite.
    /// All others: render layer to temp texture, then shader-composite onto result.
    fn render_layers_multipass(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        layers: &[Layer],
        groups: &[LayerGroup],
        bpm: BpmRenderSnapshot,
    ) {
        let dimmer_now_ms = super::pipeline::current_dimmer_time_millis();
        let mut sorted: Vec<&Layer> = layers.iter().filter(|l| l.visible).collect();
        sorted.sort_by_key(|l| l.z_index);

        // Check if any layer needs shader blending
        let needs_shader_blend = sorted.iter().any(|l| !Self::is_hw_blend(&l.blend_mode));

        if !needs_shader_blend {
            // Fast path: all layers use Normal or Additive — single render pass
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Layer Pass (HW blend only)"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.offscreen_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            for layer in &sorted {
                self.render_single_layer_hw(&mut pass, layers, layer, groups, bpm, dimmer_now_ms);
            }
            return;
        }

        // Slow path: ping-pong compositing for shader blend modes.
        // We composite into offscreen_view. When a shader-blend layer appears,
        // we render the layer to layer_temp, then composite layer_temp + offscreen → ping_pong,
        // then copy ping_pong back to offscreen.

        // Clear the offscreen to black
        {
            encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Clear Offscreen"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.offscreen_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            // Drop pass immediately — just clearing
        }

        // Group consecutive HW-blend layers into runs for efficiency
        let mut i = 0;
        while i < sorted.len() {
            let layer = sorted[i];

            if Self::is_hw_blend(&layer.blend_mode) {
                // Batch consecutive HW-blend layers into a single pass
                let mut hw_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("HW Blend Batch"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: &self.offscreen_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

                while i < sorted.len() && Self::is_hw_blend(&sorted[i].blend_mode) {
                    self.render_single_layer_hw(
                        &mut hw_pass,
                        layers,
                        sorted[i],
                        groups,
                        bpm,
                        dimmer_now_ms,
                    );
                    i += 1;
                }
                // Pass is dropped here (submitted)
            } else {
                // Shader-blend layer: render to temp, then composite
                // Step 1: Render layer to layer_temp_texture (clear first)
                {
                    let mut temp_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("Layer Temp Pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &self.layer_temp_view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                                store: wgpu::StoreOp::Store,
                            },
                            depth_slice: None,
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });
                    // Render layer with Normal alpha blending to temp
                    self.render_single_layer_to_pass(
                        &mut temp_pass,
                        layers,
                        layer,
                        groups,
                        true,
                        bpm,
                        dimmer_now_ms,
                    );
                }

                // Step 2: Blend composite — read layer_temp + offscreen → ping_pong
                {
                    let blend_uniforms = BlendUniforms {
                        blend_mode: blend_mode_to_u32(&layer.blend_mode),
                        opacity: 1.0, // Opacity already applied in layer shader
                        _pad0: 0.0,
                        _pad1: 0.0,
                    };
                    let uniform_buffer =
                        self.gpu
                            .device
                            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                label: Some("Blend Uniform Buffer"),
                                contents: bytemuck::cast_slice(&[blend_uniforms]),
                                usage: wgpu::BufferUsages::UNIFORM,
                            });

                    // Source bind group (layer_temp)
                    let source_bg = self
                        .gpu
                        .device
                        .create_bind_group(&wgpu::BindGroupDescriptor {
                            label: Some("Blend Source BG"),
                            layout: &self.pipeline.blend_source_bind_group_layout,
                            entries: &[
                                wgpu::BindGroupEntry {
                                    binding: 0,
                                    resource: wgpu::BindingResource::TextureView(
                                        &self.layer_temp_view,
                                    ),
                                },
                                wgpu::BindGroupEntry {
                                    binding: 1,
                                    resource: wgpu::BindingResource::Sampler(
                                        &self.pipeline.sampler,
                                    ),
                                },
                            ],
                        });

                    // Dest bind group (current offscreen)
                    let dest_bg = self
                        .gpu
                        .device
                        .create_bind_group(&wgpu::BindGroupDescriptor {
                            label: Some("Blend Dest BG"),
                            layout: &self.pipeline.blend_dest_bind_group_layout,
                            entries: &[
                                wgpu::BindGroupEntry {
                                    binding: 0,
                                    resource: wgpu::BindingResource::TextureView(
                                        &self.offscreen_view,
                                    ),
                                },
                                wgpu::BindGroupEntry {
                                    binding: 1,
                                    resource: wgpu::BindingResource::Sampler(
                                        &self.pipeline.sampler,
                                    ),
                                },
                            ],
                        });

                    // Uniform bind group
                    let uniform_bg =
                        self.gpu
                            .device
                            .create_bind_group(&wgpu::BindGroupDescriptor {
                                label: Some("Blend Uniform BG"),
                                layout: &self.pipeline.blend_uniform_bind_group_layout,
                                entries: &[wgpu::BindGroupEntry {
                                    binding: 0,
                                    resource: uniform_buffer.as_entire_binding(),
                                }],
                            });

                    let mut blend_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("Blend Composite Pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &self.ping_pong_view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                                store: wgpu::StoreOp::Store,
                            },
                            depth_slice: None,
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });

                    blend_pass.set_pipeline(&self.pipeline.blend_composite_pipeline);
                    blend_pass.set_bind_group(0, &source_bg, &[]);
                    blend_pass.set_bind_group(1, &dest_bg, &[]);
                    blend_pass.set_bind_group(2, &uniform_bg, &[]);
                    blend_pass.draw(0..3, 0..1); // Fullscreen triangle
                }

                // Step 3: Copy ping_pong → offscreen
                encoder.copy_texture_to_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: &self.ping_pong_texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::TexelCopyTextureInfo {
                        texture: &self.offscreen_texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::Extent3d {
                        width: self.offscreen_width,
                        height: self.offscreen_height,
                        depth_or_array_layers: 1,
                    },
                );

                i += 1;
            }
        }
    }

    /// Render a single layer using hardware blending (Normal or Additive).
    fn render_single_layer_hw<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
        layers: &[Layer],
        layer: &Layer,
        groups: &[LayerGroup],
        bpm: BpmRenderSnapshot,
        dimmer_now_ms: u64,
    ) {
        match layer.blend_mode {
            BlendMode::Additive => pass.set_pipeline(&self.pipeline.additive_pipeline),
            _ => pass.set_pipeline(&self.pipeline.layer_pipeline),
        }
        self.render_single_layer_to_pass(pass, layers, layer, groups, false, bpm, dimmer_now_ms);
    }

    /// Render a single layer's geometry into the current render pass.
    /// If `force_normal` is true, uses the normal pipeline regardless of layer's blend mode.
    /// Uses cached buffers when available (populated by prepare_all_buffers).
    fn render_single_layer_to_pass<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
        layers: &[Layer],
        layer: &Layer,
        groups: &[LayerGroup],
        force_normal: bool,
        bpm: BpmRenderSnapshot,
        dimmer_now_ms: u64,
    ) {
        if force_normal {
            pass.set_pipeline(&self.pipeline.layer_pipeline);
        }

        // Try to use cached buffers first
        if let Some(cached) = self.buffer_cache.entries.get(&layer.id) {
            pass.set_bind_group(0, &cached.bind_group, &[]);
            pass.set_vertex_buffer(0, cached.vertex_buffer.slice(..));
            pass.set_index_buffer(cached.index_buffer.slice(..), wgpu::IndexFormat::Uint16);
            pass.draw_indexed(0..cached.index_count, 0, 0..1);
            return;
        }

        // Fallback: create buffers inline (no cache prepared)
        let (vertices, indices) = generate_layer_mesh(&layer.geometry);
        if vertices.is_empty() || indices.is_empty() {
            return;
        }

        // Get texture view — use source texture if available, otherwise white fallback
        let texture_view = self
            .texture_manager
            .get_texture_view(&layer.id)
            .unwrap_or(&self.white_texture_view);

        // Create per-layer uniform buffer
        let shared_input = super::pipeline::resolve_shared_input_for_layer(layer, groups);
        let opacity = super::pipeline::compute_effective_opacity_at_time(
            layer,
            layers,
            groups,
            bpm,
            dimmer_now_ms,
        );
        let uniforms = LayerUniforms::from_layer(layer, shared_input, opacity, bpm);
        let uniform_buffer =
            self.gpu
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Layer Uniform Buffer"),
                    contents: bytemuck::cast_slice(&[uniforms]),
                    usage: wgpu::BufferUsages::UNIFORM,
                });

        // Create bind group
        let bind_group = self
            .gpu
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Layer Bind Group"),
                layout: &self.pipeline.layer_bind_group_layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: wgpu::BindingResource::TextureView(texture_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::Sampler(&self.pipeline.sampler),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: uniform_buffer.as_entire_binding(),
                    },
                ],
            });

        // Create vertex and index buffers
        let vertex_buffer = self
            .gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Layer Vertex Buffer"),
                contents: bytemuck::cast_slice(&vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });

        let index_buffer = self
            .gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Layer Index Buffer"),
                contents: bytemuck::cast_slice(&indices),
                usage: wgpu::BufferUsages::INDEX,
            });

        pass.set_bind_group(0, &bind_group, &[]);
        pass.set_vertex_buffer(0, vertex_buffer.slice(..));
        pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint16);
        pass.draw_indexed(0..indices.len() as u32, 0, 0..1);
    }

    /// Legacy: Draw all visible layers in z-order with hardware blending only.
    /// Used by render_to_surface for direct surface rendering.
    pub fn render_layers_pass<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
        layers: &[Layer],
        groups: &[LayerGroup],
        bpm: BpmRenderSnapshot,
    ) {
        let dimmer_now_ms = super::pipeline::current_dimmer_time_millis();
        let mut sorted: Vec<&Layer> = layers.iter().filter(|l| l.visible).collect();
        sorted.sort_by_key(|l| l.z_index);

        for layer in sorted {
            self.render_single_layer_hw(pass, layers, layer, groups, bpm, dimmer_now_ms);
        }
    }

    /// Draw calibration pattern (fullscreen triangle)
    pub fn render_calibration_pass<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
        calibration: &CalibrationConfig,
    ) {
        let pattern_id: u32 = match calibration.pattern {
            CalibrationPattern::Grid => 0,
            CalibrationPattern::Crosshair => 1,
            CalibrationPattern::Checkerboard => 2,
            CalibrationPattern::FullWhite => 3,
            CalibrationPattern::ColorBars => 4,
            CalibrationPattern::Black => 5,
        };

        let uniforms = CalibrationUniforms {
            pattern: pattern_id,
            line_width: 0.005,
            grid_divisions: 10.0,
            brightness: 1.0,
        };

        let uniform_buffer =
            self.gpu
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Calibration Uniform Buffer"),
                    contents: bytemuck::cast_slice(&[uniforms]),
                    usage: wgpu::BufferUsages::UNIFORM,
                });

        let bind_group = self
            .gpu
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Calibration Bind Group"),
                layout: &self.pipeline.calibration_bind_group_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                }],
            });

        pass.set_pipeline(&self.pipeline.calibration_pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.draw(0..3, 0..1); // Fullscreen triangle
    }

    /// Render all visible layers to an arbitrary set of render targets (parameterized).
    /// Used by the preview render to target preview-sized textures.
    fn render_layers_multipass_to(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        layers: &[Layer],
        groups: &[LayerGroup],
        bpm: BpmRenderSnapshot,
        target_texture: &wgpu::Texture,
        target_view: &wgpu::TextureView,
        ping_pong_texture: &wgpu::Texture,
        ping_pong_view: &wgpu::TextureView,
        layer_temp_view: &wgpu::TextureView,
        target_width: u32,
        target_height: u32,
    ) {
        let dimmer_now_ms = super::pipeline::current_dimmer_time_millis();
        let mut sorted: Vec<&Layer> = layers.iter().filter(|l| l.visible).collect();
        sorted.sort_by_key(|l| l.z_index);

        let needs_shader_blend = sorted.iter().any(|l| !Self::is_hw_blend(&l.blend_mode));

        if !needs_shader_blend {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Layer Pass (HW blend only)"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            for layer in &sorted {
                self.render_single_layer_hw(&mut pass, layers, layer, groups, bpm, dimmer_now_ms);
            }
            return;
        }

        // Clear the target to black
        {
            encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Clear Target"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
        }

        let mut i = 0;
        while i < sorted.len() {
            let layer = sorted[i];

            if Self::is_hw_blend(&layer.blend_mode) {
                let mut hw_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("HW Blend Batch"),
                    color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                        view: target_view,
                        resolve_target: None,
                        ops: wgpu::Operations {
                            load: wgpu::LoadOp::Load,
                            store: wgpu::StoreOp::Store,
                        },
                        depth_slice: None,
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

                while i < sorted.len() && Self::is_hw_blend(&sorted[i].blend_mode) {
                    self.render_single_layer_hw(
                        &mut hw_pass,
                        layers,
                        sorted[i],
                        groups,
                        bpm,
                        dimmer_now_ms,
                    );
                    i += 1;
                }
            } else {
                {
                    let mut temp_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("Layer Temp Pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: layer_temp_view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                                store: wgpu::StoreOp::Store,
                            },
                            depth_slice: None,
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });
                    self.render_single_layer_to_pass(
                        &mut temp_pass,
                        layers,
                        layer,
                        groups,
                        true,
                        bpm,
                        dimmer_now_ms,
                    );
                }

                {
                    let blend_uniforms = BlendUniforms {
                        blend_mode: blend_mode_to_u32(&layer.blend_mode),
                        opacity: 1.0,
                        _pad0: 0.0,
                        _pad1: 0.0,
                    };
                    let uniform_buffer =
                        self.gpu
                            .device
                            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                                label: Some("Blend Uniform Buffer"),
                                contents: bytemuck::cast_slice(&[blend_uniforms]),
                                usage: wgpu::BufferUsages::UNIFORM,
                            });

                    let source_bg = self
                        .gpu
                        .device
                        .create_bind_group(&wgpu::BindGroupDescriptor {
                            label: Some("Blend Source BG"),
                            layout: &self.pipeline.blend_source_bind_group_layout,
                            entries: &[
                                wgpu::BindGroupEntry {
                                    binding: 0,
                                    resource: wgpu::BindingResource::TextureView(layer_temp_view),
                                },
                                wgpu::BindGroupEntry {
                                    binding: 1,
                                    resource: wgpu::BindingResource::Sampler(
                                        &self.pipeline.sampler,
                                    ),
                                },
                            ],
                        });

                    let dest_bg = self
                        .gpu
                        .device
                        .create_bind_group(&wgpu::BindGroupDescriptor {
                            label: Some("Blend Dest BG"),
                            layout: &self.pipeline.blend_dest_bind_group_layout,
                            entries: &[
                                wgpu::BindGroupEntry {
                                    binding: 0,
                                    resource: wgpu::BindingResource::TextureView(target_view),
                                },
                                wgpu::BindGroupEntry {
                                    binding: 1,
                                    resource: wgpu::BindingResource::Sampler(
                                        &self.pipeline.sampler,
                                    ),
                                },
                            ],
                        });

                    let uniform_bg =
                        self.gpu
                            .device
                            .create_bind_group(&wgpu::BindGroupDescriptor {
                                label: Some("Blend Uniform BG"),
                                layout: &self.pipeline.blend_uniform_bind_group_layout,
                                entries: &[wgpu::BindGroupEntry {
                                    binding: 0,
                                    resource: uniform_buffer.as_entire_binding(),
                                }],
                            });

                    let mut blend_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("Blend Composite Pass"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: ping_pong_view,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                                store: wgpu::StoreOp::Store,
                            },
                            depth_slice: None,
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });

                    blend_pass.set_pipeline(&self.pipeline.blend_composite_pipeline);
                    blend_pass.set_bind_group(0, &source_bg, &[]);
                    blend_pass.set_bind_group(1, &dest_bg, &[]);
                    blend_pass.set_bind_group(2, &uniform_bg, &[]);
                    blend_pass.draw(0..3, 0..1);
                }

                // Copy ping_pong -> target
                encoder.copy_texture_to_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: ping_pong_texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::TexelCopyTextureInfo {
                        texture: target_texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::Extent3d {
                        width: target_width,
                        height: target_height,
                        depth_or_array_layers: 1,
                    },
                );

                i += 1;
            }
        }
    }

    /// Render face calibration overlay to an arbitrary target view.
    fn render_face_calibration_pass_to(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        calibration: &CalibrationConfig,
        vertices: &[LayerVertex],
        indices: &[u16],
        target_view: &wgpu::TextureView,
    ) {
        let pattern_id: u32 = match calibration.pattern {
            CalibrationPattern::Grid => 0,
            CalibrationPattern::Crosshair => 1,
            CalibrationPattern::Checkerboard => 2,
            CalibrationPattern::FullWhite => 3,
            CalibrationPattern::ColorBars => 4,
            CalibrationPattern::Black => 5,
        };

        let uniforms = CalibrationUniforms {
            pattern: pattern_id,
            line_width: 0.005,
            grid_divisions: 10.0,
            brightness: 1.0,
        };

        let uniform_buffer =
            self.gpu
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Face Calibration Uniform Buffer"),
                    contents: bytemuck::cast_slice(&[uniforms]),
                    usage: wgpu::BufferUsages::UNIFORM,
                });

        let bind_group = self
            .gpu
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Face Calibration Bind Group"),
                layout: &self.pipeline.calibration_bind_group_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                }],
            });

        let vertex_buffer = self
            .gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Face Calib Vertex Buffer"),
                contents: bytemuck::cast_slice(vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });

        let index_buffer = self
            .gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Face Calib Index Buffer"),
                contents: bytemuck::cast_slice(indices),
                usage: wgpu::BufferUsages::INDEX,
            });

        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Face Calibration Pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target_view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load,
                    store: wgpu::StoreOp::Store,
                },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });

        pass.set_pipeline(&self.pipeline.face_calibration_pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.set_vertex_buffer(0, vertex_buffer.slice(..));
        pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint16);
        pass.draw_indexed(0..indices.len() as u32, 0, 0..1);
    }

    /// Render scene and present to a surface.
    /// Uses the multi-pass compositor for proper blend modes, then blits
    /// the offscreen result to the surface.
    pub fn render_to_surface(
        &self,
        surface: &wgpu::Surface,
        layers: &[Layer],
        groups: &[LayerGroup],
        calibration: &CalibrationConfig,
        bpm: BpmRenderSnapshot,
    ) -> Result<(), String> {
        let output = surface
            .get_current_texture()
            .map_err(|e| format!("Failed to acquire surface texture: {}", e))?;
        let surface_view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        // First, render the scene to the offscreen texture using multi-pass compositing
        let scene_cmd = self.render_scene(layers, groups, calibration, bpm);

        // Then blit the offscreen result to the surface
        let mut blit_encoder =
            self.gpu
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("Surface Blit Encoder"),
                });

        self.blit_to_view(&mut blit_encoder, &surface_view);

        self.gpu.queue.submit([scene_cmd, blit_encoder.finish()]);
        output.present();
        Ok(())
    }

    /// Build cached bind groups for the blit pass.
    fn build_blit_cache(
        device: &wgpu::Device,
        pipeline: &RenderPipeline,
        offscreen_view: &wgpu::TextureView,
        white_texture_view: &wgpu::TextureView,
    ) -> BlitCache {
        let source_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Blit Source BG (cached)"),
            layout: &pipeline.blend_source_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(offscreen_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&pipeline.sampler),
                },
            ],
        });

        let dest_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Blit Dummy Dest BG (cached)"),
            layout: &pipeline.blend_dest_bind_group_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(white_texture_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&pipeline.sampler),
                },
            ],
        });

        let blit_uniforms = BlendUniforms {
            blend_mode: 0, // Normal = passthrough
            opacity: 1.0,
            _pad0: 0.0,
            _pad1: 0.0,
        };
        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Blit Uniform Buffer (cached)"),
            contents: bytemuck::cast_slice(&[blit_uniforms]),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let uniform_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Blit Uniform BG (cached)"),
            layout: &pipeline.blend_uniform_bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
        });

        BlitCache {
            source_bg,
            dest_bg,
            uniform_bg,
        }
    }

    /// Blit the offscreen render target to an arbitrary target view.
    /// Used by the projector to copy the composited scene to the surface.
    /// Uses cached bind groups when available (rebuilt only on offscreen resize).
    pub fn blit_to_view(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        target_view: &wgpu::TextureView,
    ) {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Blit Pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target_view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });

        pass.set_pipeline(&self.pipeline.blend_composite_pipeline);

        if let Some(cache) = &self.blit_cache {
            pass.set_bind_group(0, &cache.source_bg, &[]);
            pass.set_bind_group(1, &cache.dest_bg, &[]);
            pass.set_bind_group(2, &cache.uniform_bg, &[]);
        } else {
            // Fallback: create inline (should not happen in normal operation)
            let fallback = Self::build_blit_cache(
                &self.gpu.device,
                &self.pipeline,
                &self.offscreen_view,
                &self.white_texture_view,
            );
            pass.set_bind_group(0, &fallback.source_bg, &[]);
            pass.set_bind_group(1, &fallback.dest_bg, &[]);
            pass.set_bind_group(2, &fallback.uniform_bg, &[]);
        }

        pass.draw(0..3, 0..1);
    }

    /// Render face-level calibration pattern overlay onto the offscreen texture.
    /// Does NOT clear — overlays on top of the already-rendered scene.
    fn render_face_calibration_pass(
        &self,
        encoder: &mut wgpu::CommandEncoder,
        calibration: &CalibrationConfig,
        vertices: &[LayerVertex],
        indices: &[u16],
    ) {
        let pattern_id: u32 = match calibration.pattern {
            CalibrationPattern::Grid => 0,
            CalibrationPattern::Crosshair => 1,
            CalibrationPattern::Checkerboard => 2,
            CalibrationPattern::FullWhite => 3,
            CalibrationPattern::ColorBars => 4,
            CalibrationPattern::Black => 5,
        };

        let uniforms = CalibrationUniforms {
            pattern: pattern_id,
            line_width: 0.005,
            grid_divisions: 10.0,
            brightness: 1.0,
        };

        let uniform_buffer =
            self.gpu
                .device
                .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                    label: Some("Face Calibration Uniform Buffer"),
                    contents: bytemuck::cast_slice(&[uniforms]),
                    usage: wgpu::BufferUsages::UNIFORM,
                });

        let bind_group = self
            .gpu
            .device
            .create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("Face Calibration Bind Group"),
                layout: &self.pipeline.calibration_bind_group_layout,
                entries: &[wgpu::BindGroupEntry {
                    binding: 0,
                    resource: uniform_buffer.as_entire_binding(),
                }],
            });

        let vertex_buffer = self
            .gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Face Calib Vertex Buffer"),
                contents: bytemuck::cast_slice(vertices),
                usage: wgpu::BufferUsages::VERTEX,
            });

        let index_buffer = self
            .gpu
            .device
            .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                label: Some("Face Calib Index Buffer"),
                contents: bytemuck::cast_slice(indices),
                usage: wgpu::BufferUsages::INDEX,
            });

        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("Face Calibration Pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.offscreen_view,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Load, // Overlay on top of existing scene
                    store: wgpu::StoreOp::Store,
                },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });

        pass.set_pipeline(&self.pipeline.face_calibration_pipeline);
        pass.set_bind_group(0, &bind_group, &[]);
        pass.set_vertex_buffer(0, vertex_buffer.slice(..));
        pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint16);
        pass.draw_indexed(0..indices.len() as u32, 0, 0..1);
    }

    /// Render scene at preview resolution and read pixels back as RGBA.
    pub fn render_to_pixels(
        &self,
        layers: &[Layer],
        groups: &[LayerGroup],
        calibration: &CalibrationConfig,
        bpm: BpmRenderSnapshot,
    ) -> Vec<u8> {
        let bpr = self.render_preview(layers, groups, calibration, bpm);
        self.read_preview_pixels(bpr)
    }
}
