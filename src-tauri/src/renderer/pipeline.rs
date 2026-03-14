use super::shaders;
use crate::scene::group::LayerGroup;
use crate::scene::layer::{
    BlendMode, DimmerCurve, DimmerEffect, Layer, LayerGeometry, PatternCoordMode, PhaseDirection,
    PixelMapPattern, SharedInputMapping,
};
use bytemuck::{Pod, Zeroable};
use std::time::{SystemTime, UNIX_EPOCH};

/// Vertex format for layer rendering
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
pub struct LayerVertex {
    pub position: [f32; 2],
    pub tex_coord: [f32; 3], // stores u*q, v*q, q for perspective-correct interpolation
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
                    format: wgpu::VertexFormat::Float32x3, // was Float32x2
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
    // -- Pixel mapping uniforms --
    /// enabled, pattern_type (0-5), coord_mode (0-1), intensity
    pub pxmap_config: [f32; 4],
    /// phase (animated by BPM), speed, width, direction_radians
    pub pxmap_anim: [f32; 4],
    /// offset_x, offset_y, scale_x, scale_y (per-shape transform)
    pub pxmap_transform: [f32; 4],
    /// world_box: x, y, w, h
    pub pxmap_world: [f32; 4],
    /// invert, pad, pad, pad
    pub pxmap_flags: [f32; 4],
    /// shared input box x, y, w, h
    pub shared_input_box: [f32; 4],
    /// shared input offset x/y and scale x/y
    pub shared_input_transform: [f32; 4],
    /// cos, sin, enabled, pad
    pub shared_input_rot: [f32; 4],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BpmRenderSnapshot {
    pub bpm: f32,
    pub phase: f32,
    pub multiplier: f32,
    pub phase_origin_ms: u64,
}

impl Default for BpmRenderSnapshot {
    fn default() -> Self {
        Self {
            bpm: 120.0,
            phase: 0.0,
            multiplier: 1.0,
            phase_origin_ms: 0,
        }
    }
}

fn pattern_to_f32(p: PixelMapPattern) -> f32 {
    match p {
        PixelMapPattern::Chase => 0.0,
        PixelMapPattern::Stripes => 1.0,
        PixelMapPattern::Gradient => 2.0,
        PixelMapPattern::Wave => 3.0,
        PixelMapPattern::Strobe => 4.0,
        PixelMapPattern::Radial => 5.0,
    }
}

fn coord_mode_to_f32(m: PatternCoordMode) -> f32 {
    match m {
        PatternCoordMode::PerShape => 0.0,
        PatternCoordMode::WorldSpace => 1.0,
    }
}

pub fn resolve_shared_input_for_layer<'a>(
    layer: &Layer,
    groups: &'a [LayerGroup],
) -> Option<&'a SharedInputMapping> {
    let group_id = layer.group_id.as_deref()?;
    groups
        .iter()
        .find(|group| group.id == group_id)
        .and_then(|group| group.shared_input.as_ref())
        .filter(|mapping| mapping.enabled)
}

fn resolve_group_for_layer<'a>(layer: &Layer, groups: &'a [LayerGroup]) -> Option<&'a LayerGroup> {
    let group_id = layer.group_id.as_deref()?;
    groups.iter().find(|group| group.id == group_id)
}

fn fract(value: f32) -> f32 {
    value.rem_euclid(1.0)
}

pub fn current_dimmer_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn evaluate_dimmer_curve(curve: DimmerCurve, phase: f32, duty_cycle: f32) -> f32 {
    let phase = fract(phase);
    let duty = duty_cycle.clamp(0.01, 0.99);
    match curve {
        DimmerCurve::Sine => (phase * std::f32::consts::TAU).sin() * 0.5 + 0.5,
        DimmerCurve::Triangle => 1.0 - ((phase * 2.0) - 1.0).abs(),
        DimmerCurve::RampUp => phase,
        DimmerCurve::RampDown => 1.0 - phase,
        DimmerCurve::Square => {
            if phase < duty {
                1.0
            } else {
                0.0
            }
        }
        DimmerCurve::Pulse => {
            if phase < duty {
                1.0 - phase / duty
            } else {
                0.0
            }
        }
    }
}

fn compute_dimmer_phase_at_time(
    effect: &DimmerEffect,
    bpm: BpmRenderSnapshot,
    phase_offset: f32,
    now_ms: u64,
) -> f32 {
    if !effect.enabled {
        return 0.0;
    }
    let phase_origin_ms = if bpm.phase_origin_ms == 0 {
        now_ms
    } else {
        bpm.phase_origin_ms
    };
    let effective_bpm = bpm.bpm.max(1.0) * bpm.multiplier.max(0.0625);
    let beat_interval_ms = 60_000.0 / effective_bpm;
    let beats_per_cycle = (effect.speed as f32).max(0.25);
    fract(
        (now_ms.saturating_sub(phase_origin_ms) as f32 / beat_interval_ms) / beats_per_cycle
            + effect.phase_offset as f32
            + phase_offset,
    )
}

fn compute_dimmer_multiplier_at_time(
    effect: &DimmerEffect,
    bpm: BpmRenderSnapshot,
    phase_offset: f32,
    now_ms: u64,
) -> f32 {
    if !effect.enabled {
        return 1.0;
    }
    let phase = compute_dimmer_phase_at_time(effect, bpm, phase_offset, now_ms);
    let sample = evaluate_dimmer_curve(effect.curve, phase, effect.duty_cycle as f32);
    let depth = (effect.depth as f32).clamp(0.0, 1.0);
    (1.0 - depth + depth * sample).clamp(0.0, 1.0)
}

fn compute_group_phase_offset(
    layer: &Layer,
    layers: &[Layer],
    group: &LayerGroup,
    effect: &DimmerEffect,
) -> f32 {
    if effect.phase_spread.abs() < f64::EPSILON {
        return 0.0;
    }
    let mut members: Vec<(usize, &Layer)> = layers
        .iter()
        .enumerate()
        .filter(|(_, candidate)| candidate.group_id.as_deref() == Some(group.id.as_str()))
        .collect();
    members
        .sort_by(|(a_idx, a), (b_idx, b)| a.z_index.cmp(&b.z_index).then_with(|| a_idx.cmp(b_idx)));

    let Some(member_index) = members
        .iter()
        .position(|(_, candidate)| candidate.id == layer.id)
    else {
        return 0.0;
    };
    if members.len() <= 1 {
        return 0.0;
    }
    let member_count = members.len() as f32;
    match effect.phase_direction {
        PhaseDirection::Forward => {
            effect.phase_spread as f32 * (member_index as f32 / member_count)
        }
        PhaseDirection::Center => {
            effect.phase_spread as f32 * (((member_index as f32 + 0.5) / member_count) - 0.5)
        }
        PhaseDirection::Reverse => {
            effect.phase_spread as f32 * ((members.len() - 1 - member_index) as f32 / member_count)
        }
    }
}

pub fn compute_effective_opacity(
    layer: &Layer,
    layers: &[Layer],
    groups: &[LayerGroup],
    bpm: BpmRenderSnapshot,
) -> f32 {
    compute_effective_opacity_at_time(layer, layers, groups, bpm, current_dimmer_time_millis())
}

pub fn compute_effective_opacity_at_time(
    layer: &Layer,
    layers: &[Layer],
    groups: &[LayerGroup],
    bpm: BpmRenderSnapshot,
    now_ms: u64,
) -> f32 {
    let base_opacity = (layer.properties.opacity as f32).clamp(0.0, 1.0);

    if let Some(group) = resolve_group_for_layer(layer, groups) {
        if let Some(effect) = group.dimmer_fx.as_ref().filter(|effect| effect.enabled) {
            let phase_offset = compute_group_phase_offset(layer, layers, group, effect);
            return base_opacity
                * compute_dimmer_multiplier_at_time(effect, bpm, phase_offset, now_ms);
        }
    }

    if let Some(effect) = layer.dimmer_fx.as_ref().filter(|effect| effect.enabled) {
        return base_opacity * compute_dimmer_multiplier_at_time(effect, bpm, 0.0, now_ms);
    }

    base_opacity
}

impl LayerUniforms {
    pub fn from_layer(
        layer: &Layer,
        shared_input: Option<&SharedInputMapping>,
        opacity: f32,
        bpm: BpmRenderSnapshot,
    ) -> Self {
        let props = &layer.properties;
        let input = &layer.input_transform;
        let shape_kind = if layer.layer_type == "circle" {
            1.0
        } else {
            0.0
        };
        let rot = input.rotation as f32;
        let (shared_input_box, shared_input_transform, shared_input_rot) =
            if let Some(mapping) = shared_input.filter(|mapping| mapping.enabled) {
                let rotation = mapping.rotation as f32;
                (
                    [
                        mapping.r#box[0] as f32,
                        mapping.r#box[1] as f32,
                        mapping.r#box[2] as f32,
                        mapping.r#box[3] as f32,
                    ],
                    [
                        mapping.offset_x as f32,
                        mapping.offset_y as f32,
                        mapping.scale_x as f32,
                        mapping.scale_y as f32,
                    ],
                    [rotation.cos(), rotation.sin(), 1.0, 0.0],
                )
            } else {
                (
                    [0.0, 0.0, 1.0, 1.0],
                    [0.0, 0.0, 1.0, 1.0],
                    [1.0, 0.0, 0.0, 0.0],
                )
            };

        // Pixel mapping
        let (pm_config, pm_anim, pm_transform, pm_world, pm_flags) =
            if let Some(ref pm) = layer.pixel_map {
                if pm.enabled {
                    let animated_phase = (bpm.phase * bpm.multiplier * pm.speed as f32).fract();
                    (
                        [
                            1.0,
                            pattern_to_f32(pm.pattern),
                            coord_mode_to_f32(pm.coord_mode),
                            pm.intensity as f32,
                        ],
                        [
                            animated_phase,
                            pm.speed as f32,
                            pm.width as f32,
                            (pm.direction as f32).to_radians(),
                        ],
                        [
                            pm.offset_x as f32,
                            pm.offset_y as f32,
                            pm.scale_x as f32,
                            pm.scale_y as f32,
                        ],
                        [
                            pm.world_box[0] as f32,
                            pm.world_box[1] as f32,
                            pm.world_box[2] as f32,
                            pm.world_box[3] as f32,
                        ],
                        [if pm.invert { 1.0 } else { 0.0 }, 0.0, 0.0, 0.0],
                    )
                } else {
                    (
                        [0.0; 4],
                        [0.0; 4],
                        [0.0, 0.0, 1.0, 1.0],
                        [0.0, 0.0, 1.0, 1.0],
                        [0.0; 4],
                    )
                }
            } else {
                (
                    [0.0; 4],
                    [0.0; 4],
                    [0.0, 0.0, 1.0, 1.0],
                    [0.0, 0.0, 1.0, 1.0],
                    [0.0; 4],
                )
            };

        Self {
            color_adjust: [
                props.brightness as f32,
                props.contrast as f32,
                props.gamma as f32,
                opacity,
            ],
            feather_and_shape: [props.feather as f32, shape_kind, 0.0, 0.0],
            input_offset: [input.offset[0] as f32, input.offset[1] as f32, 0.0, 0.0],
            input_scale: [input.scale[0] as f32, input.scale[1] as f32, 0.0, 0.0],
            input_rot: [rot.cos(), rot.sin(), 0.0, 0.0],
            pxmap_config: pm_config,
            pxmap_anim: pm_anim,
            pxmap_transform: pm_transform,
            pxmap_world: pm_world,
            pxmap_flags: pm_flags,
            shared_input_box,
            shared_input_transform,
            shared_input_rot,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::group::LayerGroup;

    #[test]
    fn layer_uniforms_disable_shared_input_without_mapping() {
        let layer = Layer::new_quad("Q", 0);
        let uniforms = LayerUniforms::from_layer(
            &layer,
            None,
            1.0,
            BpmRenderSnapshot {
                bpm: 120.0,
                phase: 0.25,
                multiplier: 1.0,
                phase_origin_ms: 0,
            },
        );
        assert_eq!(uniforms.shared_input_rot[2], 0.0);
        assert_eq!(uniforms.shared_input_box, [0.0, 0.0, 1.0, 1.0]);
    }

    #[test]
    fn layer_uniforms_include_shared_input_mapping() {
        let layer = Layer::new_quad("Q", 0);
        let mapping = SharedInputMapping {
            enabled: true,
            r#box: [0.1, 0.2, 0.3, 0.4],
            offset_x: 0.5,
            offset_y: -0.25,
            rotation: 0.75,
            scale_x: 2.0,
            scale_y: 3.0,
        };
        let uniforms = LayerUniforms::from_layer(
            &layer,
            Some(&mapping),
            1.0,
            BpmRenderSnapshot {
                bpm: 120.0,
                phase: 0.25,
                multiplier: 1.0,
                phase_origin_ms: 0,
            },
        );
        assert_eq!(uniforms.shared_input_box, [0.1, 0.2, 0.3, 0.4]);
        assert_eq!(uniforms.shared_input_transform, [0.5, -0.25, 2.0, 3.0]);
        assert_eq!(uniforms.shared_input_rot[2], 1.0);
    }

    #[test]
    fn resolve_shared_input_for_layer_uses_group_mapping() {
        let mut layer = Layer::new_quad("Q", 0);
        layer.group_id = Some("group-1".to_string());
        let group = LayerGroup {
            id: "group-1".to_string(),
            name: "Group".to_string(),
            layer_ids: vec![layer.id.clone()],
            visible: true,
            locked: false,
            pixel_map: None,
            dimmer_fx: None,
            shared_input: Some(SharedInputMapping::default()),
        };
        let groups = [group];
        let resolved = resolve_shared_input_for_layer(&layer, &groups);
        assert!(resolved.is_some());
    }

    #[test]
    fn compute_effective_opacity_uses_layer_dimmer_fx() {
        let mut layer = Layer::new_quad("Q", 0);
        layer.properties.opacity = 0.8;
        layer.dimmer_fx = Some(DimmerEffect {
            curve: DimmerCurve::Square,
            duty_cycle: 0.25,
            phase_offset: 0.0,
            ..DimmerEffect::default()
        });

        let opacity = compute_effective_opacity_at_time(
            &layer,
            &[layer.clone()],
            &[],
            BpmRenderSnapshot {
                bpm: 120.0,
                phase: 0.0,
                multiplier: 1.0,
                phase_origin_ms: 1_000,
            },
            1_300,
        );
        assert_eq!(opacity, 0.0);
    }

    #[test]
    fn compute_effective_opacity_group_dimmer_fx_overrides_layer_fx() {
        let mut layer_a = Layer::new_quad("A", 0);
        let mut layer_b = Layer::new_quad("B", 1);
        layer_a.group_id = Some("group-1".to_string());
        layer_b.group_id = Some("group-1".to_string());
        layer_a.dimmer_fx = Some(DimmerEffect {
            curve: DimmerCurve::Square,
            duty_cycle: 0.75,
            ..DimmerEffect::default()
        });

        let group = LayerGroup {
            id: "group-1".to_string(),
            name: "Group".to_string(),
            layer_ids: vec![layer_a.id.clone(), layer_b.id.clone()],
            visible: true,
            locked: false,
            pixel_map: None,
            dimmer_fx: Some(DimmerEffect {
                curve: DimmerCurve::Square,
                duty_cycle: 0.5,
                phase_spread: 1.0,
                ..DimmerEffect::default()
            }),
            shared_input: None,
        };

        let layers = vec![layer_a.clone(), layer_b];
        let opacity = compute_effective_opacity_at_time(
            &layer_a,
            &layers,
            &[group],
            BpmRenderSnapshot {
                bpm: 120.0,
                phase: 0.0,
                multiplier: 1.0,
                phase_origin_ms: 1_000,
            },
            1_300,
        );
        assert_eq!(opacity, 0.0);
    }

    #[test]
    fn compute_effective_opacity_supports_multi_beat_cycles() {
        let mut layer = Layer::new_quad("Q", 0);
        layer.dimmer_fx = Some(DimmerEffect {
            speed: 4.0,
            phase_offset: 0.0,
            curve: DimmerCurve::Square,
            duty_cycle: 0.5,
            ..DimmerEffect::default()
        });

        let early = compute_effective_opacity_at_time(
            &layer,
            &[layer.clone()],
            &[],
            BpmRenderSnapshot {
                bpm: 120.0,
                phase: 0.0,
                multiplier: 1.0,
                phase_origin_ms: 1_000,
            },
            1_500,
        );
        let late = compute_effective_opacity_at_time(
            &layer,
            &[layer.clone()],
            &[],
            BpmRenderSnapshot {
                bpm: 120.0,
                phase: 0.0,
                multiplier: 1.0,
                phase_origin_ms: 1_000,
            },
            2_500,
        );

        assert_eq!(early, 1.0);
        assert_eq!(late, 0.0);
    }

    #[test]
    fn group_phase_offsets_do_not_duplicate_endpoints() {
        let mut layers = vec![
            Layer::new_quad("A", 0),
            Layer::new_quad("B", 1),
            Layer::new_quad("C", 2),
            Layer::new_quad("D", 3),
        ];
        for layer in &mut layers {
            layer.group_id = Some("group-1".to_string());
        }
        let effect = DimmerEffect {
            phase_spread: 1.0,
            phase_direction: PhaseDirection::Forward,
            ..DimmerEffect::default()
        };
        let group = LayerGroup {
            id: "group-1".to_string(),
            name: "Group".to_string(),
            layer_ids: layers.iter().map(|layer| layer.id.clone()).collect(),
            visible: true,
            locked: false,
            pixel_map: None,
            dimmer_fx: Some(effect.clone()),
            shared_input: None,
        };

        let offsets: Vec<f32> = layers
            .iter()
            .map(|layer| compute_group_phase_offset(layer, &layers, &group, &effect))
            .collect();

        assert_eq!(offsets, vec![0.0, 0.25, 0.5, 0.75]);
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

        let calibration_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
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
                LayerVertex {
                    position: c[0],
                    tex_coord: [base_uvs[0][0] * q[0], base_uvs[0][1] * q[0], q[0]],
                },
                LayerVertex {
                    position: c[1],
                    tex_coord: [base_uvs[1][0] * q[1], base_uvs[1][1] * q[1], q[1]],
                },
                LayerVertex {
                    position: c[2],
                    tex_coord: [base_uvs[2][0] * q[2], base_uvs[2][1] * q[2], q[2]],
                },
                LayerVertex {
                    position: c[3],
                    tex_coord: [base_uvs[3][0] * q[3], base_uvs[3][1] * q[3], q[3]],
                },
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
        LayerGeometry::Mesh {
            cols, rows, points, ..
        } => {
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
                    q_accum[tl_idx] += qs[0];
                    q_count[tl_idx] += 1;
                    q_accum[tr_idx] += qs[1];
                    q_count[tr_idx] += 1;
                    q_accum[br_idx] += qs[2];
                    q_count[br_idx] += 1;
                    q_accum[bl_idx] += qs[3];
                    q_count[bl_idx] += 1;
                }
            }

            // Build base vertex grid with averaged q
            let mut vertices = Vec::with_capacity(n_verts);
            for r in 0..=rows {
                for c in 0..=cols {
                    let idx = r * (cols + 1) + c;
                    let pt = &points[idx];
                    let q = if q_count[idx] > 0 {
                        q_accum[idx] / q_count[idx] as f32
                    } else {
                        1.0
                    };
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
                LayerVertex {
                    position: corner_world[0],
                    tex_coord: [base_uvs[0][0] * q[0], base_uvs[0][1] * q[0], q[0]],
                },
                LayerVertex {
                    position: corner_world[1],
                    tex_coord: [base_uvs[1][0] * q[1], base_uvs[1][1] * q[1], q[1]],
                },
                LayerVertex {
                    position: corner_world[2],
                    tex_coord: [base_uvs[2][0] * q[2], base_uvs[2][1] * q[2], q[2]],
                },
                LayerVertex {
                    position: corner_world[3],
                    tex_coord: [base_uvs[3][0] * q[3], base_uvs[3][1] * q[3], q[3]],
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
                LayerVertex {
                    position: c[0],
                    tex_coord: [base_uvs[0][0] * q[0], base_uvs[0][1] * q[0], q[0]],
                },
                LayerVertex {
                    position: c[1],
                    tex_coord: [base_uvs[1][0] * q[1], base_uvs[1][1] * q[1], q[1]],
                },
                LayerVertex {
                    position: c[2],
                    tex_coord: [base_uvs[2][0] * q[2], base_uvs[2][1] * q[2], q[2]],
                },
                LayerVertex {
                    position: c[3],
                    tex_coord: [base_uvs[3][0] * q[3], base_uvs[3][1] * q[3], q[3]],
                },
            ];
            let indices = vec![0, 1, 2, 0, 2, 3];
            (vertices, indices)
        }
        LayerGeometry::Triangle { vertices: verts } => {
            // Triangles have no perspective distortion — keep q=1.0
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
                LayerVertex {
                    position: corner_world[0],
                    tex_coord: [base_uvs[0][0] * q[0], base_uvs[0][1] * q[0], q[0]],
                },
                LayerVertex {
                    position: corner_world[1],
                    tex_coord: [base_uvs[1][0] * q[1], base_uvs[1][1] * q[1], q[1]],
                },
                LayerVertex {
                    position: corner_world[2],
                    tex_coord: [base_uvs[2][0] * q[2], base_uvs[2][1] * q[2], q[2]],
                },
                LayerVertex {
                    position: corner_world[3],
                    tex_coord: [base_uvs[3][0] * q[3], base_uvs[3][1] * q[3], q[3]],
                },
            ];
            let indices = vec![0, 1, 2, 0, 2, 3];
            (vertices, indices)
        }
        LayerGeometry::Mesh {
            cols, rows, points, ..
        } => {
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
                    q_accum[tl_idx] += qs[0];
                    q_count[tl_idx] += 1;
                    q_accum[tr_idx] += qs[1];
                    q_count[tr_idx] += 1;
                    q_accum[br_idx] += qs[2];
                    q_count[br_idx] += 1;
                    q_accum[bl_idx] += qs[3];
                    q_count[bl_idx] += 1;
                }
            }

            let mut vertices = Vec::with_capacity(n_verts);
            for r in 0..=rows {
                for c in 0..=cols {
                    let idx = r * (cols + 1) + c;
                    let pt = &points[idx];
                    let q = if q_count[idx] > 0 {
                        q_accum[idx] / q_count[idx] as f32
                    } else {
                        1.0
                    };
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
