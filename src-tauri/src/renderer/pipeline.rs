use super::shaders;
use crate::scene::layer::{BlendMode, Layer, LayerGeometry};
use bytemuck::{Pod, Zeroable};

/// Vertex format for layer rendering
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct LayerVertex {
    pub position: [f32; 2],
    pub tex_coord: [f32; 3],  // stores u*q, v*q, q for perspective-correct interpolation
}

impl LayerVertex {
    pub fn desc() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: std::mem::size_of::<LayerVertex>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &[
                wgpu::VertexAttribute {
                    offset: 0,
                    shader_location: 0,
                    format: wgpu::VertexFormat::Float32x2,
                },
                wgpu::VertexAttribute {
                    offset: std::mem::size_of::<[f32; 2]>() as wgpu::BufferAddress,
                    shader_location: 1,
                    format: wgpu::VertexFormat::Float32x3,  // was Float32x2
                },
            ],
        }
    }
}

/// Per-layer uniform data matching the WGSL struct
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct LayerUniforms {
    /// brightness, contrast, gamma, opacity
    pub color_adjust: [f32; 4],
    /// feather, shape_kind (0=regular, 1=ellipse mask), pad, pad
    pub feather_and_shape: [f32; 4],
    /// input offset x/y, pad, pad
    pub input_offset: [f32; 4],
    /// input scale x/y, pad, pad
    pub input_scale: [f32; 4],
    /// input rotation cos/sin, pad, pad
    pub input_rot: [f32; 4],
}

impl LayerUniforms {
    pub fn from_layer(layer: &Layer) -> Self {
        let props = &layer.properties;
        let input = &layer.input_transform;
        let shape_kind = if layer.layer_type == "circle" {
            1.0
        } else {
            0.0
        };
        let rot = input.rotation as f32;
        Self {
            color_adjust: [
                props.brightness as f32,
                props.contrast as f32,
                props.gamma as f32,
                props.opacity as f32,
            ],
            feather_and_shape: [props.feather as f32, shape_kind, 0.0, 0.0],
            input_offset: [input.offset[0] as f32, input.offset[1] as f32, 0.0, 0.0],
            input_scale: [input.scale[0] as f32, input.scale[1] as f32, 0.0, 0.0],
            input_rot: [rot.cos(), rot.sin(), 0.0, 0.0],
        }
    }
}

/// Calibration pattern uniform data
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct CalibrationUniforms {
    pub pattern: u32,
    pub line_width: f32,
    pub grid_divisions: f32,
    pub brightness: f32,
}

/// Uniform data for the blend composite shader
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct BlendUniforms {
    pub blend_mode: u32,
    pub opacity: f32,
    pub _pad0: f32,
    pub _pad1: f32,
}

/// Convert a BlendMode enum to its shader u32 index
pub fn blend_mode_to_u32(mode: &BlendMode) -> u32 {
    match mode {
        BlendMode::Normal => 0,
        BlendMode::Multiply => 1,
        BlendMode::Screen => 2,
        BlendMode::Overlay => 3,
        BlendMode::Darken => 4,
        BlendMode::Lighten => 5,
        BlendMode::ColorDodge => 6,
        BlendMode::ColorBurn => 7,
        BlendMode::SoftLight => 8,
        BlendMode::HardLight => 9,
        BlendMode::Difference => 10,
        BlendMode::Exclusion => 11,
        BlendMode::Additive => 12,
    }
}

/// The render pipeline for projector output
pub struct RenderPipeline {
    pub layer_pipeline: wgpu::RenderPipeline,
    /// Pipeline for Additive blend mode (hardware SrcAlpha + One)
    pub additive_pipeline: wgpu::RenderPipeline,
    pub calibration_pipeline: wgpu::RenderPipeline,
    /// Pipeline for face-level calibration overlay (uses LayerVertex, alpha blending)
    pub face_calibration_pipeline: wgpu::RenderPipeline,
    /// Pipeline for shader-based blend compositing (ping-pong)
    pub blend_composite_pipeline: wgpu::RenderPipeline,
    pub layer_bind_group_layout: wgpu::BindGroupLayout,
    pub calibration_bind_group_layout: wgpu::BindGroupLayout,
    /// Bind group layouts for blend composite shader
    pub blend_source_bind_group_layout: wgpu::BindGroupLayout,
    pub blend_dest_bind_group_layout: wgpu::BindGroupLayout,
    pub blend_uniform_bind_group_layout: wgpu::BindGroupLayout,
    pub sampler: wgpu::Sampler,
}

impl RenderPipeline {
    pub fn new(device: &wgpu::Device, surface_format: wgpu::TextureFormat) -> Self {
        // --- Layer pipeline ---
        let layer_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Layer Shader"),
            source: wgpu::ShaderSource::Wgsl(shaders::LAYER_SHADER.into()),
        });

        let layer_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Layer Bind Group Layout"),
                entries: &[
                    // Texture
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            multisampled: false,
                            view_dimension: wgpu::TextureViewDimension::D2,
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        },
                        count: None,
                    },
                    // Sampler
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                    // Uniforms
                    wgpu::BindGroupLayoutEntry {
                        binding: 2,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Buffer {
                            ty: wgpu::BufferBindingType::Uniform,
                            has_dynamic_offset: false,
                            min_binding_size: None,
                        },
                        count: None,
                    },
                ],
            });

        let layer_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Layer Pipeline Layout"),
                bind_group_layouts: &[&layer_bind_group_layout],
                push_constant_ranges: &[],
            });

        let layer_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Layer Render Pipeline"),
            layout: Some(&layer_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &layer_shader,
                entry_point: Some("vs_main"),
                buffers: &[LayerVertex::desc()],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &layer_shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // --- Calibration pipeline ---
        let calibration_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Calibration Shader"),
            source: wgpu::ShaderSource::Wgsl(shaders::CALIBRATION_SHADER.into()),
        });

        let calibration_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Calibration Bind Group Layout"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });

        let calibration_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Calibration Pipeline Layout"),
                bind_group_layouts: &[&calibration_bind_group_layout],
                push_constant_ranges: &[],
            });

        let calibration_pipeline =
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Calibration Render Pipeline"),
                layout: Some(&calibration_pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &calibration_shader,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &calibration_shader,
                    entry_point: Some("fs_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: surface_format,
                        blend: None,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            });

        // --- Face calibration pipeline (vertex buffer + alpha blend overlay) ---
        let face_calib_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Face Calibration Shader"),
            source: wgpu::ShaderSource::Wgsl(shaders::FACE_CALIBRATION_SHADER.into()),
        });

        let face_calibration_pipeline =
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Face Calibration Pipeline"),
                layout: Some(&calibration_pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &face_calib_shader,
                    entry_point: Some("vs_main"),
                    buffers: &[LayerVertex::desc()],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &face_calib_shader,
                    entry_point: Some("fs_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: surface_format,
                        blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            });

        // --- Additive blend pipeline (hardware SrcAlpha + One) ---
        let additive_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Additive Render Pipeline"),
            layout: Some(&layer_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &layer_shader,
                entry_point: Some("vs_main"),
                buffers: &[LayerVertex::desc()],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &layer_shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: surface_format,
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::SrcAlpha,
                            dst_factor: wgpu::BlendFactor::One,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::One,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleList,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                polygon_mode: wgpu::PolygonMode::Fill,
                unclipped_depth: false,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        // --- Blend composite pipeline (shader-based blend modes) ---
        let blend_shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Blend Composite Shader"),
            source: wgpu::ShaderSource::Wgsl(shaders::BLEND_COMPOSITE_SHADER.into()),
        });

        // Group 0: source texture + sampler
        let blend_source_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Blend Source Bind Group Layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            multisampled: false,
                            view_dimension: wgpu::TextureViewDimension::D2,
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });

        // Group 1: destination texture + sampler
        let blend_dest_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Blend Dest Bind Group Layout"),
                entries: &[
                    wgpu::BindGroupLayoutEntry {
                        binding: 0,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Texture {
                            multisampled: false,
                            view_dimension: wgpu::TextureViewDimension::D2,
                            sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        },
                        count: None,
                    },
                    wgpu::BindGroupLayoutEntry {
                        binding: 1,
                        visibility: wgpu::ShaderStages::FRAGMENT,
                        ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                        count: None,
                    },
                ],
            });

        // Group 2: blend uniforms
        let blend_uniform_bind_group_layout =
            device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
                label: Some("Blend Uniform Bind Group Layout"),
                entries: &[wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                }],
            });

        let blend_pipeline_layout =
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("Blend Composite Pipeline Layout"),
                bind_group_layouts: &[
                    &blend_source_bind_group_layout,
                    &blend_dest_bind_group_layout,
                    &blend_uniform_bind_group_layout,
                ],
                push_constant_ranges: &[],
            });

        let blend_composite_pipeline =
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("Blend Composite Pipeline"),
                layout: Some(&blend_pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &blend_shader,
                    entry_point: Some("vs_main"),
                    buffers: &[],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &blend_shader,
                    entry_point: Some("fs_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format: surface_format,
                        blend: None, // Shader does all blending
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState {
                    topology: wgpu::PrimitiveTopology::TriangleList,
                    ..Default::default()
                },
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview: None,
                cache: None,
            });

        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("Layer Sampler"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });

        Self {
            layer_pipeline,
            additive_pipeline,
            calibration_pipeline,
            face_calibration_pipeline,
            blend_composite_pipeline,
            layer_bind_group_layout,
            calibration_bind_group_layout,
            blend_source_bind_group_layout,
            blend_dest_bind_group_layout,
            blend_uniform_bind_group_layout,
            sampler,
        }
    }
}

/// Compute perspective-correct homogeneous weights for 4 quad corners.
/// Uses the Heckbert diagonal-intersection method.
/// Returns [q0, q1, q2, q3] for corners [TL, TR, BR, BL].
/// Returns [1,1,1,1] for parallelograms (fast path) and degenerate cases.
fn compute_quad_q_weights(corners: &[[f32; 2]; 4]) -> [f32; 4] {
    // p0=TL, p1=TR, p2=BR, p3=BL
    let p0 = corners[0];
    let p1 = corners[1];
    let p2 = corners[2];
    let p3 = corners[3];

    // Diagonal vectors: d02 = p2-p0, d13 = p3-p1
    let d02x = p2[0] - p0[0];
    let d02y = p2[1] - p0[1];
    let d13x = p3[0] - p1[0];
    let d13y = p3[1] - p1[1];

    // Solve p0 + t*d02 = p1 + s*d13 for t, s
    // Cross product of direction vectors for denominator
    let denom = d02x * d13y - d02y * d13x;

    if denom.abs() < 1e-9 {
        // Parallel diagonals — parallelogram or degenerate, no correction needed
        return [1.0, 1.0, 1.0, 1.0];
    }

    let bx = p1[0] - p0[0];
    let by = p1[1] - p0[1];
    let t = (bx * d13y - by * d13x) / denom;
    let s = (bx * d02y - by * d02x) / denom;

    // Early-out: near-parallelogram (t and s both ~0.5)
    if (t - 0.5).abs() < 0.02 && (s - 0.5).abs() < 0.02 {
        return [1.0, 1.0, 1.0, 1.0];
    }

    // Clamp to avoid degenerate cases
    let t = t.clamp(0.001, 0.999);
    let s = s.clamp(0.001, 0.999);

    let q0 = 1.0 / (1.0 - t);
    let q1 = 1.0 / (1.0 - s);
    let q2 = 1.0 / t;
    let q3 = 1.0 / s;

    [q0, q1, q2, q3]
}

/// Generate vertices and indices for a layer's geometry.
/// tex_coord is stored as [u*q, v*q, q] for perspective-correct interpolation.
pub fn generate_layer_mesh(geometry: &LayerGeometry) -> (Vec<LayerVertex>, Vec<u16>) {
    match geometry {
        LayerGeometry::Quad { corners } => {
            let c = [
                [corners[0].x as f32, corners[0].y as f32],
                [corners[1].x as f32, corners[1].y as f32],
                [corners[2].x as f32, corners[2].y as f32],
                [corners[3].x as f32, corners[3].y as f32],
            ];
            let q = compute_quad_q_weights(&c);
            // TL=0.0,0.0  TR=1.0,0.0  BR=1.0,1.0  BL=0.0,1.0
            let base_uvs = [[0.0f32, 0.0f32], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
            let vertices = vec![
                LayerVertex { position: c[0], tex_coord: [base_uvs[0][0] * q[0], base_uvs[0][1] * q[0], q[0]] },
                LayerVertex { position: c[1], tex_coord: [base_uvs[1][0] * q[1], base_uvs[1][1] * q[1], q[1]] },
                LayerVertex { position: c[2], tex_coord: [base_uvs[2][0] * q[2], base_uvs[2][1] * q[2], q[2]] },
                LayerVertex { position: c[3], tex_coord: [base_uvs[3][0] * q[3], base_uvs[3][1] * q[3], q[3]] },
            ];
            let indices = vec![0, 1, 2, 0, 2, 3];
            (vertices, indices)
        }
        LayerGeometry::Triangle { vertices: verts } => {
            let vertices = vec![
                LayerVertex {
                    position: [verts[0].x as f32, verts[0].y as f32],
                    tex_coord: [0.5, 0.0, 1.0],
                },
                LayerVertex {
                    position: [verts[1].x as f32, verts[1].y as f32],
                    tex_coord: [1.0, 1.0, 1.0],
                },
                LayerVertex {
                    position: [verts[2].x as f32, verts[2].y as f32],
                    tex_coord: [0.0, 1.0, 1.0],
                },
            ];
            let indices = vec![0, 1, 2];
            (vertices, indices)
        }
        LayerGeometry::Mesh { cols, rows, points, .. } => {
            let cols = *cols as usize;
            let rows = *rows as usize;

            // Compute q weights per cell, accumulate at vertices (shared-vertex averaging)
            let n_verts = (rows + 1) * (cols + 1);
            let mut q_accum = vec![0.0f32; n_verts];
            let mut q_count = vec![0u32; n_verts];

            for r in 0..rows {
                for c in 0..cols {
                    let tl_idx = r * (cols + 1) + c;
                    let tr_idx = tl_idx + 1;
                    let bl_idx = (r + 1) * (cols + 1) + c;
                    let br_idx = bl_idx + 1;
                    let cell_corners = [
                        [points[tl_idx].x as f32, points[tl_idx].y as f32],
                        [points[tr_idx].x as f32, points[tr_idx].y as f32],
                        [points[br_idx].x as f32, points[br_idx].y as f32],
                        [points[bl_idx].x as f32, points[bl_idx].y as f32],
                    ];
                    let qs = compute_quad_q_weights(&cell_corners);
                    // qs order: TL, TR, BR, BL
                    q_accum[tl_idx] += qs[0]; q_count[tl_idx] += 1;
                    q_accum[tr_idx] += qs[1]; q_count[tr_idx] += 1;
                    q_accum[br_idx] += qs[2]; q_count[br_idx] += 1;
                    q_accum[bl_idx] += qs[3]; q_count[bl_idx] += 1;
                }
            }

            // Build base vertex grid with averaged q
            let mut vertices = Vec::with_capacity(n_verts);
            for r in 0..=rows {
                for c in 0..=cols {
                    let idx = r * (cols + 1) + c;
                    let pt = &points[idx];
                    let q = if q_count[idx] > 0 { q_accum[idx] / q_count[idx] as f32 } else { 1.0 };
                    let u = c as f32 / cols as f32;
                    let v = r as f32 / rows as f32;
                    vertices.push(LayerVertex {
                        position: [pt.x as f32, pt.y as f32],
                        tex_coord: [u * q, v * q, q],
                    });
                }
            }

            // Generate triangle indices for the grid
            let mut indices: Vec<u16> = Vec::with_capacity(rows * cols * 6);
            for r in 0..rows {
                for c in 0..cols {
                    let tl = (r * (cols + 1) + c) as u16;
                    let tr = tl + 1;
                    let bl = ((r + 1) * (cols + 1) + c) as u16;
                    let br = bl + 1;
                    indices.extend_from_slice(&[tl, tr, br, tl, br, bl]);
                }
            }

            (vertices, indices)
        }
        LayerGeometry::Circle {
            center,
            radius_x,
            radius_y,
            rotation,
        } => {
            let cx = center.x as f32;
            let cy = center.y as f32;
            let rx = *radius_x as f32;
            let ry = *radius_y as f32;
            let c = (*rotation as f32).cos();
            let s = (*rotation as f32).sin();

            let corner_local = [(-rx, -ry), (rx, -ry), (rx, ry), (-rx, ry)];
            let corner_world: [[f32; 2]; 4] = corner_local.map(|(lx, ly)| {
                let x = cx + lx * c - ly * s;
                let y = cy + lx * s + ly * c;
                [x, y]
            });

            let q = compute_quad_q_weights(&corner_world);
            let base_uvs = [[0.0f32, 0.0f32], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
            let vertices = vec![
                LayerVertex { position: corner_world[0], tex_coord: [base_uvs[0][0] * q[0], base_uvs[0][1] * q[0], q[0]] },
                LayerVertex { position: corner_world[1], tex_coord: [base_uvs[1][0] * q[1], base_uvs[1][1] * q[1], q[1]] },
                LayerVertex { position: corner_world[2], tex_coord: [base_uvs[2][0] * q[2], base_uvs[2][1] * q[2], q[2]] },
                LayerVertex { position: corner_world[3], tex_coord: [base_uvs[3][0] * q[3], base_uvs[3][1] * q[3], q[3]] },
            ];
            let indices = vec![0, 1, 2, 0, 2, 3];
            (vertices, indices)
        }
    }
}

/// Generate vertices and indices for a layer-level calibration overlay.
/// Covers the whole layer shape regardless of geometry type.
/// UV [0,0]→[1,1] so the calibration pattern fills the layer independently.
/// Uses q=1.0 everywhere (no perspective correction needed for test patterns).
pub fn generate_layer_calibration_mesh(geometry: &LayerGeometry) -> (Vec<LayerVertex>, Vec<u16>) {
    match geometry {
        LayerGeometry::Quad { corners } => {
            let c = [
                [corners[0].x as f32, corners[0].y as f32],
                [corners[1].x as f32, corners[1].y as f32],
                [corners[2].x as f32, corners[2].y as f32],
                [corners[3].x as f32, corners[3].y as f32],
            ];
            let q = compute_quad_q_weights(&c);
            let base_uvs = [[0.0f32, 0.0f32], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
            let vertices = vec![
                LayerVertex { position: c[0], tex_coord: [base_uvs[0][0] * q[0], base_uvs[0][1] * q[0], q[0]] },
                LayerVertex { position: c[1], tex_coord: [base_uvs[1][0] * q[1], base_uvs[1][1] * q[1], q[1]] },
                LayerVertex { position: c[2], tex_coord: [base_uvs[2][0] * q[2], base_uvs[2][1] * q[2], q[2]] },
                LayerVertex { position: c[3], tex_coord: [base_uvs[3][0] * q[3], base_uvs[3][1] * q[3], q[3]] },
            ];
            let indices = vec![0, 1, 2, 0, 2, 3];
            (vertices, indices)
        }
        LayerGeometry::Triangle { vertices: verts } => {
            // Triangles have no perspective distortion — keep q=1.0
            let vertices = vec![
                LayerVertex { position: [verts[0].x as f32, verts[0].y as f32], tex_coord: [0.5, 0.0, 1.0] },
                LayerVertex { position: [verts[1].x as f32, verts[1].y as f32], tex_coord: [1.0, 1.0, 1.0] },
                LayerVertex { position: [verts[2].x as f32, verts[2].y as f32], tex_coord: [0.0, 1.0, 1.0] },
            ];
            let indices = vec![0, 1, 2];
            (vertices, indices)
        }
        LayerGeometry::Circle {
            center,
            radius_x,
            radius_y,
            rotation,
        } => {
            let cx = center.x as f32;
            let cy = center.y as f32;
            let rx = *radius_x as f32;
            let ry = *radius_y as f32;
            let c = (*rotation as f32).cos();
            let s = (*rotation as f32).sin();

            let corner_local = [(-rx, -ry), (rx, -ry), (rx, ry), (-rx, ry)];
            let corner_world = corner_local.map(|(lx, ly)| {
                let x = cx + lx * c - ly * s;
                let y = cy + lx * s + ly * c;
                [x, y]
            });

            let q = compute_quad_q_weights(&corner_world);
            let base_uvs = [[0.0f32, 0.0f32], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
            let vertices = vec![
                LayerVertex { position: corner_world[0], tex_coord: [base_uvs[0][0] * q[0], base_uvs[0][1] * q[0], q[0]] },
                LayerVertex { position: corner_world[1], tex_coord: [base_uvs[1][0] * q[1], base_uvs[1][1] * q[1], q[1]] },
                LayerVertex { position: corner_world[2], tex_coord: [base_uvs[2][0] * q[2], base_uvs[2][1] * q[2], q[2]] },
                LayerVertex { position: corner_world[3], tex_coord: [base_uvs[3][0] * q[3], base_uvs[3][1] * q[3], q[3]] },
            ];
            let indices = vec![0, 1, 2, 0, 2, 3];
            (vertices, indices)
        }
        LayerGeometry::Mesh { cols, rows, points, .. } => {
            // Shared-vertex topology with averaged q weights — mirrors generate_layer_mesh
            let cols = *cols as usize;
            let rows = *rows as usize;
            let n_verts = (rows + 1) * (cols + 1);
            let mut q_accum = vec![0.0f32; n_verts];
            let mut q_count = vec![0u32; n_verts];

            for r in 0..rows {
                for c in 0..cols {
                    let tl_idx = r * (cols + 1) + c;
                    let tr_idx = tl_idx + 1;
                    let bl_idx = (r + 1) * (cols + 1) + c;
                    let br_idx = bl_idx + 1;
                    let cell_corners = [
                        [points[tl_idx].x as f32, points[tl_idx].y as f32],
                        [points[tr_idx].x as f32, points[tr_idx].y as f32],
                        [points[br_idx].x as f32, points[br_idx].y as f32],
                        [points[bl_idx].x as f32, points[bl_idx].y as f32],
                    ];
                    let qs = compute_quad_q_weights(&cell_corners);
                    q_accum[tl_idx] += qs[0]; q_count[tl_idx] += 1;
                    q_accum[tr_idx] += qs[1]; q_count[tr_idx] += 1;
                    q_accum[br_idx] += qs[2]; q_count[br_idx] += 1;
                    q_accum[bl_idx] += qs[3]; q_count[bl_idx] += 1;
                }
            }

            let mut vertices = Vec::with_capacity(n_verts);
            for r in 0..=rows {
                for c in 0..=cols {
                    let idx = r * (cols + 1) + c;
                    let pt = &points[idx];
                    let q = if q_count[idx] > 0 { q_accum[idx] / q_count[idx] as f32 } else { 1.0 };
                    let u = c as f32 / cols as f32;
                    let v = r as f32 / rows as f32;
                    vertices.push(LayerVertex {
                        position: [pt.x as f32, pt.y as f32],
                        tex_coord: [u * q, v * q, q],
                    });
                }
            }

            let mut indices: Vec<u16> = Vec::with_capacity(rows * cols * 6);
            for r in 0..rows {
                for c in 0..cols {
                    let tl = (r * (cols + 1) + c) as u16;
                    let tr = tl + 1;
                    let bl = ((r + 1) * (cols + 1) + c) as u16;
                    let br = bl + 1;
                    indices.extend_from_slice(&[tl, tr, br, tl, br, bl]);
                }
            }

            (vertices, indices)
        }
    }
}
