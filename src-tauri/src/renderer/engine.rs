//! RenderEngine — owns GPU state, runs the render loop, composites layers & calibration patterns.
//!
//! The engine is designed to be driven by Tauri events:
//! - Scene changes trigger a re-render
//! - Calibration mode swaps the pipeline
//! - The projector window surface is managed here

use parking_lot::RwLock;
use wgpu::util::DeviceExt;

use super::gpu::GpuContext;
use super::pipeline::{
    CalibrationUniforms, LayerUniforms, RenderPipeline, generate_layer_mesh,
};
use super::texture_manager::TextureManager;
use crate::scene::layer::Layer;
use crate::scene::project::{CalibrationConfig, CalibrationPattern};

/// Shared render state that the Tauri commands can push updates into
pub struct RenderState {
    pub layers: RwLock<Vec<Layer>>,
    pub calibration: RwLock<CalibrationConfig>,
    pub needs_redraw: RwLock<bool>,
    pub output_width: RwLock<u32>,
    pub output_height: RwLock<u32>,
}

impl RenderState {
    pub fn new() -> Self {
        Self {
            layers: RwLock::new(Vec::new()),
            calibration: RwLock::new(CalibrationConfig::default()),
            needs_redraw: RwLock::new(true),
            output_width: RwLock::new(1920),
            output_height: RwLock::new(1080),
        }
    }

    pub fn update_layers(&self, layers: Vec<Layer>) {
        *self.layers.write() = layers;
        *self.needs_redraw.write() = true;
    }

    pub fn update_calibration(&self, config: CalibrationConfig) {
        *self.calibration.write() = config;
        *self.needs_redraw.write() = true;
    }

    pub fn request_redraw(&self) {
        *self.needs_redraw.write() = true;
    }

    pub fn take_redraw(&self) -> bool {
        let mut flag = self.needs_redraw.write();
        let val = *flag;
        *flag = false;
        val
    }
}

impl Default for RenderState {
    fn default() -> Self {
        Self::new()
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
}

impl RenderEngine {
    pub fn new(gpu: GpuContext, width: u32, height: u32) -> Self {
        // We need a surface format for the pipeline — use Bgra8UnormSrgb (Metal default)
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
                | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = tex.create_view(&wgpu::TextureViewDescriptor::default());
        (tex, view)
    }

    /// Resize the offscreen target
    pub fn resize_offscreen(&mut self, width: u32, height: u32) {
        if width == self.offscreen_width && height == self.offscreen_height {
            return;
        }
        let format = wgpu::TextureFormat::Bgra8UnormSrgb;
        let (tex, view) = Self::create_offscreen_target(&self.gpu.device, width, height, format);
        self.offscreen_texture = tex;
        self.offscreen_view = view;
        self.offscreen_width = width;
        self.offscreen_height = height;
    }

    /// Render the full scene to the offscreen texture.
    /// Returns the command buffer ready for submission.
    pub fn render_scene(
        &self,
        layers: &[Layer],
        calibration: &CalibrationConfig,
    ) -> wgpu::CommandBuffer {
        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Scene Render Encoder"),
            });

        {
            // Clear to black
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Clear Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.offscreen_view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if calibration.enabled {
                // Draw calibration pattern
                self.render_calibration_pass(&mut pass, calibration);
            } else {
                // Draw layers bottom-to-top
                self.render_layers_pass(&mut pass, layers);
            }
        }

        encoder.finish()
    }

    /// Draw all visible layers in z-order
    pub fn render_layers_pass<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
        layers: &[Layer],
    ) {
        let mut sorted: Vec<&Layer> = layers.iter().filter(|l| l.visible).collect();
        sorted.sort_by_key(|l| l.z_index);

        pass.set_pipeline(&self.pipeline.layer_pipeline);

        for layer in sorted {
            let (vertices, indices) = generate_layer_mesh(&layer.geometry);
            if vertices.is_empty() || indices.is_empty() {
                continue;
            }

            // Get texture view — use source texture if available, otherwise white fallback
            let texture_view = self
                .texture_manager
                .get_texture_view(&layer.id)
                .unwrap_or(&self.white_texture_view);

            // Create per-layer uniform buffer
            let uniforms = LayerUniforms::from(&layer.properties);
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
            let vertex_buffer =
                self.gpu
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Layer Vertex Buffer"),
                        contents: bytemuck::cast_slice(&vertices),
                        usage: wgpu::BufferUsages::VERTEX,
                    });

            let index_buffer =
                self.gpu
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

    /// Render scene and present to a surface
    pub fn render_to_surface(
        &self,
        surface: &wgpu::Surface,
        layers: &[Layer],
        calibration: &CalibrationConfig,
    ) -> Result<(), String> {
        let output = surface
            .get_current_texture()
            .map_err(|e| format!("Failed to acquire surface texture: {}", e))?;
        let view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Surface Render Encoder"),
            });

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Surface Render Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            if calibration.enabled {
                self.render_calibration_pass(&mut pass, calibration);
            } else {
                self.render_layers_pass(&mut pass, layers);
            }
        }

        self.gpu.queue.submit(std::iter::once(encoder.finish()));
        output.present();
        Ok(())
    }

    /// Render scene to the offscreen texture and read pixels back (for preview/screenshot)
    pub fn render_to_pixels(
        &self,
        layers: &[Layer],
        calibration: &CalibrationConfig,
    ) -> Vec<u8> {
        let cmd = self.render_scene(layers, calibration);
        self.gpu.queue.submit(std::iter::once(cmd));

        // For now return empty — full readback would need a staging buffer
        // This is a future optimization for editor preview thumbnails
        Vec::new()
    }
}
