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
    BlendUniforms, CalibrationUniforms, LayerUniforms, RenderPipeline, blend_mode_to_u32,
    generate_layer_mesh,
};
use super::texture_manager::TextureManager;
use crate::scene::layer::{BlendMode, Layer};
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
    /// Ping-pong texture for multi-pass blend compositing
    pub ping_pong_texture: wgpu::Texture,
    pub ping_pong_view: wgpu::TextureView,
    /// Temporary texture for rendering a single layer before blend-compositing
    pub layer_temp_texture: wgpu::Texture,
    pub layer_temp_view: wgpu::TextureView,
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

        let (ping_pong_texture, ping_pong_view) =
            Self::create_offscreen_target(&gpu.device, width, height, surface_format);
        let (layer_temp_texture, layer_temp_view) =
            Self::create_offscreen_target(&gpu.device, width, height, surface_format);

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

    /// Resize the offscreen target (and associated ping-pong / temp textures)
    pub fn resize_offscreen(&mut self, width: u32, height: u32) {
        if width == self.offscreen_width && height == self.offscreen_height {
            return;
        }
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
    }

    /// Render the full scene to the offscreen texture.
    /// Uses multi-pass ping-pong compositing for complex blend modes.
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

        if calibration.enabled {
            // Calibration: simple single pass
            {
                let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                    label: Some("Calibration Pass"),
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
                self.render_calibration_pass(&mut pass, calibration);
            }
        } else {
            // Layer compositing with blend modes
            self.render_layers_multipass(&mut encoder, layers);
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
    ) {
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
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            for layer in &sorted {
                self.render_single_layer_hw(&mut pass, layer);
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
                    })],
                    depth_stencil_attachment: None,
                    timestamp_writes: None,
                    occlusion_query_set: None,
                });

                while i < sorted.len() && Self::is_hw_blend(&sorted[i].blend_mode) {
                    self.render_single_layer_hw(&mut hw_pass, sorted[i]);
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
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                    });
                    // Render layer with Normal alpha blending to temp
                    self.render_single_layer_to_pass(&mut temp_pass, layer, true);
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
                    let source_bg =
                        self.gpu
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
                    let dest_bg =
                        self.gpu
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
                    wgpu::ImageCopyTexture {
                        texture: &self.ping_pong_texture,
                        mip_level: 0,
                        origin: wgpu::Origin3d::ZERO,
                        aspect: wgpu::TextureAspect::All,
                    },
                    wgpu::ImageCopyTexture {
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
        layer: &Layer,
    ) {
        match layer.blend_mode {
            BlendMode::Additive => pass.set_pipeline(&self.pipeline.additive_pipeline),
            _ => pass.set_pipeline(&self.pipeline.layer_pipeline),
        }
        self.render_single_layer_to_pass(pass, layer, false);
    }

    /// Render a single layer's geometry into the current render pass.
    /// If `force_normal` is true, uses the normal pipeline regardless of layer's blend mode.
    fn render_single_layer_to_pass<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
        layer: &Layer,
        force_normal: bool,
    ) {
        let (vertices, indices) = generate_layer_mesh(&layer.geometry);
        if vertices.is_empty() || indices.is_empty() {
            return;
        }

        if force_normal {
            pass.set_pipeline(&self.pipeline.layer_pipeline);
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

    /// Legacy: Draw all visible layers in z-order with hardware blending only.
    /// Used by render_to_surface for direct surface rendering.
    pub fn render_layers_pass<'a>(
        &'a self,
        pass: &mut wgpu::RenderPass<'a>,
        layers: &[Layer],
    ) {
        let mut sorted: Vec<&Layer> = layers.iter().filter(|l| l.visible).collect();
        sorted.sort_by_key(|l| l.z_index);

        for layer in sorted {
            self.render_single_layer_hw(pass, layer);
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

    /// Render scene and present to a surface.
    /// Uses the multi-pass compositor for proper blend modes, then blits
    /// the offscreen result to the surface.
    pub fn render_to_surface(
        &self,
        surface: &wgpu::Surface,
        layers: &[Layer],
        calibration: &CalibrationConfig,
    ) -> Result<(), String> {
        let output = surface
            .get_current_texture()
            .map_err(|e| format!("Failed to acquire surface texture: {}", e))?;
        let surface_view = output
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());

        // First, render the scene to the offscreen texture using multi-pass compositing
        let scene_cmd = self.render_scene(layers, calibration);

        // Then blit the offscreen result to the surface
        let mut blit_encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("Surface Blit Encoder"),
            });

        // Copy offscreen → surface via a simple textured fullscreen pass
        {
            let blit_bg =
                self.gpu
                    .device
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("Surface Blit BG"),
                        layout: &self.pipeline.blend_source_bind_group_layout,
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(&self.offscreen_view),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::Sampler(&self.pipeline.sampler),
                            },
                        ],
                    });

            // Use a dummy dest and blend uniform with Normal mode for passthrough
            let dummy_dest_bg =
                self.gpu
                    .device
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("Dummy Dest BG"),
                        layout: &self.pipeline.blend_dest_bind_group_layout,
                        entries: &[
                            wgpu::BindGroupEntry {
                                binding: 0,
                                resource: wgpu::BindingResource::TextureView(
                                    &self.white_texture_view,
                                ),
                            },
                            wgpu::BindGroupEntry {
                                binding: 1,
                                resource: wgpu::BindingResource::Sampler(&self.pipeline.sampler),
                            },
                        ],
                    });

            let blit_uniforms = BlendUniforms {
                blend_mode: 0, // Normal = passthrough
                opacity: 1.0,
                _pad0: 0.0,
                _pad1: 0.0,
            };
            let uniform_buffer =
                self.gpu
                    .device
                    .create_buffer_init(&wgpu::util::BufferInitDescriptor {
                        label: Some("Blit Uniform Buffer"),
                        contents: bytemuck::cast_slice(&[blit_uniforms]),
                        usage: wgpu::BufferUsages::UNIFORM,
                    });
            let uniform_bg =
                self.gpu
                    .device
                    .create_bind_group(&wgpu::BindGroupDescriptor {
                        label: Some("Blit Uniform BG"),
                        layout: &self.pipeline.blend_uniform_bind_group_layout,
                        entries: &[wgpu::BindGroupEntry {
                            binding: 0,
                            resource: uniform_buffer.as_entire_binding(),
                        }],
                    });

            let mut pass = blit_encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("Surface Blit Pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &surface_view,
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

            pass.set_pipeline(&self.pipeline.blend_composite_pipeline);
            pass.set_bind_group(0, &blit_bg, &[]);
            pass.set_bind_group(1, &dummy_dest_bg, &[]);
            pass.set_bind_group(2, &uniform_bg, &[]);
            pass.draw(0..3, 0..1);
        }

        self.gpu
            .queue
            .submit([scene_cmd, blit_encoder.finish()]);
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
