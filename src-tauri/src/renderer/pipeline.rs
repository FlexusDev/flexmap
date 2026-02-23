use super::shaders;
use crate::scene::layer::{BlendMode, Layer, LayerGeometry};
use bytemuck::{Pod, Zeroable};

/// Vertex format for layer rendering
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct LayerVertex {
    pub position: [f32; 2],
    pub tex_coord: [f32; 2],
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
                    format: wgpu::VertexFormat::Float32x2,
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
        let shape_kind = if matches!(layer.geometry, LayerGeometry::Circle { .. }) {
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

/// Generate vertices and indices for a layer's geometry.
/// Handles masked faces (skip), UV overrides (duplicate vertices with transformed UVs).
pub fn generate_layer_mesh(geometry: &LayerGeometry) -> (Vec<LayerVertex>, Vec<u16>) {
    match geometry {
        LayerGeometry::Quad { corners } => {
            // Two triangles forming the quad
            let vertices = vec![
                LayerVertex {
                    position: [corners[0].x as f32, corners[0].y as f32],
                    tex_coord: [0.0, 0.0],
                },
                LayerVertex {
                    position: [corners[1].x as f32, corners[1].y as f32],
                    tex_coord: [1.0, 0.0],
                },
                LayerVertex {
                    position: [corners[2].x as f32, corners[2].y as f32],
                    tex_coord: [1.0, 1.0],
                },
                LayerVertex {
                    position: [corners[3].x as f32, corners[3].y as f32],
                    tex_coord: [0.0, 1.0],
                },
            ];
            let indices = vec![0, 1, 2, 0, 2, 3];
            (vertices, indices)
        }
        LayerGeometry::Triangle { vertices: verts } => {
            let vertices = vec![
                LayerVertex {
                    position: [verts[0].x as f32, verts[0].y as f32],
                    tex_coord: [0.5, 0.0],
                },
                LayerVertex {
                    position: [verts[1].x as f32, verts[1].y as f32],
                    tex_coord: [1.0, 1.0],
                },
                LayerVertex {
                    position: [verts[2].x as f32, verts[2].y as f32],
                    tex_coord: [0.0, 1.0],
                },
            ];
            let indices = vec![0, 1, 2];
            (vertices, indices)
        }
        LayerGeometry::Mesh { cols, rows, points, masked_faces, uv_overrides, .. } => {
            let cols = *cols as usize;
            let rows = *rows as usize;

            // O(1) lookup for masked faces
            let mask_set: std::collections::HashSet<usize> = masked_faces.iter().copied().collect();

            let mut vertices = Vec::with_capacity((rows + 1) * (cols + 1));
            let mut indices: Vec<u16> = Vec::new();

            // Build base vertex grid
            for r in 0..=rows {
                for c in 0..=cols {
                    let idx = r * (cols + 1) + c;
                    let pt = &points[idx];
                    vertices.push(LayerVertex {
                        position: [pt.x as f32, pt.y as f32],
                        tex_coord: [c as f32 / cols as f32, r as f32 / rows as f32],
                    });
                }
            }

            // Generate triangle indices for the grid
            for r in 0..rows {
                for c in 0..cols {
                    let face_idx = r * cols + c;

                    // Skip masked faces
                    if mask_set.contains(&face_idx) {
                        continue;
                    }

                    if let Some(adj) = uv_overrides.get(&face_idx) {
                        // UV override: duplicate this face's 4 vertices with transformed UVs
                        let center_u = (c as f32 + 0.5) / cols as f32;
                        let center_v = (r as f32 + 0.5) / rows as f32;
                        let cos_r = (adj.rotation as f32).cos();
                        let sin_r = (adj.rotation as f32).sin();
                        let sx = adj.scale[0] as f32;
                        let sy = adj.scale[1] as f32;
                        let ox = adj.offset[0] as f32;
                        let oy = adj.offset[1] as f32;

                        let corner_positions = [
                            vertices[r * (cols + 1) + c].position,
                            vertices[r * (cols + 1) + c + 1].position,
                            vertices[(r + 1) * (cols + 1) + c + 1].position,
                            vertices[(r + 1) * (cols + 1) + c].position,
                        ];
                        let base_uvs: [[f32; 2]; 4] = [
                            [c as f32 / cols as f32, r as f32 / rows as f32],
                            [(c + 1) as f32 / cols as f32, r as f32 / rows as f32],
                            [(c + 1) as f32 / cols as f32, (r + 1) as f32 / rows as f32],
                            [c as f32 / cols as f32, (r + 1) as f32 / rows as f32],
                        ];

                        let new_base = vertices.len() as u16;
                        for i in 0..4 {
                            let bu = base_uvs[i][0];
                            let bv = base_uvs[i][1];
                            let su = (bu - center_u) * sx;
                            let sv = (bv - center_v) * sy;
                            let new_u = su * cos_r - sv * sin_r + center_u + ox;
                            let new_v = su * sin_r + sv * cos_r + center_v + oy;
                            vertices.push(LayerVertex {
                                position: corner_positions[i],
                                tex_coord: [new_u, new_v],
                            });
                        }
                        // TL=0, TR=1, BR=2, BL=3
                        indices.extend_from_slice(&[
                            new_base, new_base + 1, new_base + 2,
                            new_base, new_base + 2, new_base + 3,
                        ]);
                    } else {
                        // Standard shared-vertex indices
                        let tl = (r * (cols + 1) + c) as u16;
                        let tr = tl + 1;
                        let bl = ((r + 1) * (cols + 1) + c) as u16;
                        let br = bl + 1;
                        indices.extend_from_slice(&[tl, tr, br, tl, br, bl]);
                    }
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
            let corner_world = corner_local.map(|(lx, ly)| {
                let x = cx + lx * c - ly * s;
                let y = cy + lx * s + ly * c;
                [x, y]
            });

            // Oriented quad + analytic ellipse mask in shader.
            let vertices = vec![
                LayerVertex {
                    position: corner_world[0],
                    tex_coord: [0.0, 0.0],
                },
                LayerVertex {
                    position: corner_world[1],
                    tex_coord: [1.0, 0.0],
                },
                LayerVertex {
                    position: corner_world[2],
                    tex_coord: [1.0, 1.0],
                },
                LayerVertex {
                    position: corner_world[3],
                    tex_coord: [0.0, 1.0],
                },
            ];
            let indices = vec![0, 1, 2, 0, 2, 3];
            (vertices, indices)
        }
    }
}

/// Generate vertices and indices for a layer-level calibration overlay.
/// Covers the whole layer shape regardless of geometry type.
/// UV [0,0]→[1,1] so the calibration pattern fills the layer independently.
pub fn generate_layer_calibration_mesh(geometry: &LayerGeometry) -> (Vec<LayerVertex>, Vec<u16>) {
    match geometry {
        LayerGeometry::Quad { corners } => {
            let vertices = vec![
                LayerVertex { position: [corners[0].x as f32, corners[0].y as f32], tex_coord: [0.0, 0.0] },
                LayerVertex { position: [corners[1].x as f32, corners[1].y as f32], tex_coord: [1.0, 0.0] },
                LayerVertex { position: [corners[2].x as f32, corners[2].y as f32], tex_coord: [1.0, 1.0] },
                LayerVertex { position: [corners[3].x as f32, corners[3].y as f32], tex_coord: [0.0, 1.0] },
            ];
            let indices = vec![0, 1, 2, 0, 2, 3];
            (vertices, indices)
        }
        LayerGeometry::Triangle { vertices: verts } => {
            let vertices = vec![
                LayerVertex { position: [verts[0].x as f32, verts[0].y as f32], tex_coord: [0.5, 0.0] },
                LayerVertex { position: [verts[1].x as f32, verts[1].y as f32], tex_coord: [1.0, 1.0] },
                LayerVertex { position: [verts[2].x as f32, verts[2].y as f32], tex_coord: [0.0, 1.0] },
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

            // Same oriented quad used in the regular render path.
            let vertices = vec![
                LayerVertex { position: corner_world[0], tex_coord: [0.0, 0.0] },
                LayerVertex { position: corner_world[1], tex_coord: [1.0, 0.0] },
                LayerVertex { position: corner_world[2], tex_coord: [1.0, 1.0] },
                LayerVertex { position: corner_world[3], tex_coord: [0.0, 1.0] },
            ];
            let indices = vec![0, 1, 2, 0, 2, 3];
            (vertices, indices)
        }
        LayerGeometry::Mesh { cols, rows, points, .. } => {
            // Shared-vertex topology (one vertex per grid point) — avoids cracks at shared edges
            let cols = *cols as usize;
            let rows = *rows as usize;
            let mut vertices = Vec::with_capacity((rows + 1) * (cols + 1));
            let mut indices: Vec<u16> = Vec::with_capacity(rows * cols * 6);

            for r in 0..=rows {
                for c in 0..=cols {
                    let pt = &points[r * (cols + 1) + c];
                    vertices.push(LayerVertex {
                        position: [pt.x as f32, pt.y as f32],
                        tex_coord: [c as f32 / cols as f32, r as f32 / rows as f32],
                    });
                }
            }

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
