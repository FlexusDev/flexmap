use super::shaders;
use crate::scene::layer::LayerGeometry;
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
    pub brightness: f32,
    pub contrast: f32,
    pub gamma: f32,
    pub opacity: f32,
    pub feather: f32,
    pub _pad0: f32,
    pub _pad1: f32,
    pub _pad2: f32,
}

impl From<&crate::scene::layer::LayerProperties> for LayerUniforms {
    fn from(props: &crate::scene::layer::LayerProperties) -> Self {
        Self {
            brightness: props.brightness as f32,
            contrast: props.contrast as f32,
            gamma: props.gamma as f32,
            opacity: props.opacity as f32,
            feather: props.feather as f32,
            _pad0: 0.0,
            _pad1: 0.0,
            _pad2: 0.0,
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

/// The render pipeline for projector output
pub struct RenderPipeline {
    pub layer_pipeline: wgpu::RenderPipeline,
    pub calibration_pipeline: wgpu::RenderPipeline,
    pub layer_bind_group_layout: wgpu::BindGroupLayout,
    pub calibration_bind_group_layout: wgpu::BindGroupLayout,
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
            calibration_pipeline,
            layer_bind_group_layout,
            calibration_bind_group_layout,
            sampler,
        }
    }
}

/// Generate vertices and indices for a layer's geometry
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
        LayerGeometry::Mesh { cols, rows, points } => {
            let cols = *cols as usize;
            let rows = *rows as usize;
            let mut vertices = Vec::with_capacity((rows + 1) * (cols + 1));
            let mut indices = Vec::new();

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
                    let tl = (r * (cols + 1) + c) as u16;
                    let tr = tl + 1;
                    let bl = ((r + 1) * (cols + 1) + c) as u16;
                    let br = bl + 1;
                    // Two triangles per cell
                    indices.extend_from_slice(&[tl, tr, br, tl, br, bl]);
                }
            }

            (vertices, indices)
        }
        LayerGeometry::Circle {
            center: _,
            radius: _,
            bounds,
        } => {
            // Render as a quad with circle masking done in the shader
            // The feather/mask will handle the circular shape
            let vertices = vec![
                LayerVertex {
                    position: [bounds[0].x as f32, bounds[0].y as f32],
                    tex_coord: [0.0, 0.0],
                },
                LayerVertex {
                    position: [bounds[1].x as f32, bounds[1].y as f32],
                    tex_coord: [1.0, 0.0],
                },
                LayerVertex {
                    position: [bounds[2].x as f32, bounds[2].y as f32],
                    tex_coord: [1.0, 1.0],
                },
                LayerVertex {
                    position: [bounds[3].x as f32, bounds[3].y as f32],
                    tex_coord: [0.0, 1.0],
                },
            ];
            let indices = vec![0, 1, 2, 0, 2, 3];
            (vertices, indices)
        }
    }
}
