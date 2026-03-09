/// WGSL shader for layer rendering with post-processing
/// Handles textured quad/triangle/mesh rendering with per-layer adjustments
pub const LAYER_SHADER: &str = r#"
// Vertex input
struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) tex_coord: vec3<f32>,
};

// Vertex output / Fragment input
struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) tex_coord: vec3<f32>,
};

// Per-layer uniforms
struct LayerUniforms {
    // brightness, contrast, gamma, opacity
    color_adjust: vec4<f32>,
    // feather, shape_kind (0=regular, 1=ellipse mask), pad, pad
    feather_and_shape: vec4<f32>,
    // x, y, pad, pad
    input_offset: vec4<f32>,
    // x, y, pad, pad
    input_scale: vec4<f32>,
    // cos, sin, pad, pad
    input_rot: vec4<f32>,
    // Pixel mapping
    pxmap_config: vec4<f32>,     // enabled, pattern, coord_mode, intensity
    pxmap_anim: vec4<f32>,       // phase, speed, width, direction_rad
    pxmap_transform: vec4<f32>,  // offset_x, offset_y, scale_x, scale_y
    pxmap_world: vec4<f32>,      // world_box x, y, w, h
    pxmap_flags: vec4<f32>,      // invert, 0, 0, 0
};

@group(0) @binding(0) var t_source: texture_2d<f32>;
@group(0) @binding(1) var s_source: sampler;
@group(0) @binding(2) var<uniform> uniforms: LayerUniforms;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    // Convert from normalized [0,1] to clip space [-1,1], flip Y
    out.clip_position = vec4<f32>(
        in.position.x * 2.0 - 1.0,
        1.0 - in.position.y * 2.0,
        0.0,
        1.0
    );
    out.tex_coord = in.tex_coord;
    return out;
}

fn transform_uv(base_uv: vec2<f32>) -> vec2<f32> {
    let center = vec2<f32>(0.5, 0.5);
    let p = (base_uv - center) * uniforms.input_scale.xy;
    let r = vec2<f32>(
        p.x * uniforms.input_rot.x - p.y * uniforms.input_rot.y,
        p.x * uniforms.input_rot.y + p.y * uniforms.input_rot.x
    );
    return r + center + uniforms.input_offset.xy;
}

// --- Pixel Mapping Patterns ---

fn pxmap_rotate(p: vec2<f32>, angle: f32) -> vec2<f32> {
    let c = cos(angle);
    let s = sin(angle);
    return vec2<f32>(p.x * c - p.y * s, p.x * s + p.y * c);
}

fn pattern_chase(t: f32, width: f32) -> f32 {
    let pos = fract(t);
    let w = max(width, 0.01);
    return smoothstep(0.0, w * 0.25, pos) * (1.0 - smoothstep(w * 0.75, w, pos));
}

fn pattern_stripes(t: f32, width: f32) -> f32 {
    let freq = max(1.0, 1.0 / max(width, 0.01));
    return abs(sin(t * freq * 3.14159));
}

fn pattern_gradient(t: f32) -> f32 {
    return fract(t);
}

fn pattern_wave(t: f32, width: f32) -> f32 {
    let freq = max(1.0, 1.0 / max(width, 0.01));
    return sin(t * freq * 6.28318) * 0.5 + 0.5;
}

fn pattern_strobe(t: f32) -> f32 {
    return step(0.5, fract(t));
}

fn pattern_radial(p: vec2<f32>, phase: f32) -> f32 {
    let dist = length(p - vec2<f32>(0.5, 0.5));
    return fract(dist * 2.0 - phase);
}

fn compute_pixel_map(base_uv: vec2<f32>) -> f32 {
    let enabled = uniforms.pxmap_config.x;
    if enabled < 0.5 {
        return 1.0;
    }

    let pattern_type = u32(uniforms.pxmap_config.y);
    let coord_mode = u32(uniforms.pxmap_config.z);
    let intensity = uniforms.pxmap_config.w;
    let phase = uniforms.pxmap_anim.x;
    let width = uniforms.pxmap_anim.z;
    let direction = uniforms.pxmap_anim.w;
    let invert = uniforms.pxmap_flags.x;

    // Choose coordinate space
    var p: vec2<f32>;
    if coord_mode == 0u {
        // PerShape: use base_uv with transform (offset + scale)
        p = (base_uv - vec2<f32>(0.5)) * uniforms.pxmap_transform.zw; // scale
        p = p + vec2<f32>(0.5) + uniforms.pxmap_transform.xy;         // offset
    } else {
        // WorldSpace: remap UV through world box
        let wb = uniforms.pxmap_world;
        p = (base_uv - wb.xy) / max(wb.zw, vec2<f32>(0.001));
    }

    // Rotate by direction
    let centered = p - vec2<f32>(0.5);
    let rotated = pxmap_rotate(centered, direction) + vec2<f32>(0.5);

    // Compute pattern value using rotated.x + phase for linear patterns
    let t = rotated.x + phase;
    var mask: f32;
    switch pattern_type {
        case 0u: { mask = pattern_chase(t, width); }
        case 1u: { mask = pattern_stripes(t, width); }
        case 2u: { mask = pattern_gradient(t); }
        case 3u: { mask = pattern_wave(t, width); }
        case 4u: { mask = pattern_strobe(t); }
        case 5u: { mask = pattern_radial(p, phase); }
        default: { mask = 1.0; }
    }

    if invert > 0.5 {
        mask = 1.0 - mask;
    }

    return mix(1.0, mask, intensity);
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let base_uv = in.tex_coord.xy / in.tex_coord.z;
    let sample_uv = transform_uv(base_uv);
    var color = textureSample(t_source, s_source, sample_uv);

    let feather = uniforms.feather_and_shape.x;
    let shape_kind = uniforms.feather_and_shape.y;

    // Apply brightness
    color = vec4<f32>(color.rgb * uniforms.color_adjust.x, color.a);

    // Apply contrast (centered around 0.5)
    color = vec4<f32>(
        (color.rgb - vec3<f32>(0.5)) * uniforms.color_adjust.y + vec3<f32>(0.5),
        color.a
    );

    // Apply gamma correction
    let inv_gamma = 1.0 / max(uniforms.color_adjust.z, 0.01);
    color = vec4<f32>(
        pow(max(color.rgb, vec3<f32>(0.0)), vec3<f32>(inv_gamma)),
        color.a
    );

    // Ellipse analytic mask for Circle layers.
    // Geometry is rendered as an oriented quad; this mask cuts it to ellipse.
    if shape_kind > 0.5 {
        let d = (base_uv - vec2<f32>(0.5, 0.5)) / vec2<f32>(0.5, 0.5);
        let radius = length(d);
        if radius > 1.0 {
            discard;
        }
        if feather > 0.0 {
            let feather_start = 1.0 - feather;
            let feather_alpha = 1.0 - smoothstep(feather_start, 1.0, radius);
            color = vec4<f32>(color.rgb, color.a * feather_alpha);
        }
    } else if feather > 0.0 {
        // Existing radial feather for non-circle layers
        let dist = length(base_uv - vec2<f32>(0.5, 0.5)) * 2.0;
        let feather_start = 1.0 - feather;
        let feather_alpha = 1.0 - smoothstep(feather_start, 1.0, dist);
        color = vec4<f32>(color.rgb, color.a * feather_alpha);
    }

    // Apply pixel mapping pattern
    let pxmap_mask = compute_pixel_map(base_uv);
    color = vec4<f32>(color.rgb, color.a * pxmap_mask);

    // Apply opacity
    color = vec4<f32>(color.rgb, color.a * uniforms.color_adjust.w);

    // Clamp output
    return clamp(color, vec4<f32>(0.0), vec4<f32>(1.0));
}
"#;

/// WGSL shader for blend compositing (ping-pong multi-pass)
/// Combines a source layer with the current composite using various blend modes.
pub const BLEND_COMPOSITE_SHADER: &str = r#"
struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct BlendUniforms {
    blend_mode: u32,
    opacity: f32,
    _pad0: f32,
    _pad1: f32,
};

@group(0) @binding(0) var t_source: texture_2d<f32>;
@group(0) @binding(1) var s_source: sampler;
@group(1) @binding(0) var t_dest: texture_2d<f32>;
@group(1) @binding(1) var s_dest: sampler;
@group(2) @binding(0) var<uniform> uniforms: BlendUniforms;

// Fullscreen triangle vertex shader
@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(i32(vertex_index) / 2) * 4.0 - 1.0;
    let y = f32(i32(vertex_index) % 2) * 4.0 - 1.0;
    out.clip_position = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>((x + 1.0) / 2.0, (1.0 - y) / 2.0);
    return out;
}

// Blend mode implementations (standard Photoshop math)
fn blend_multiply(base: vec3<f32>, blend: vec3<f32>) -> vec3<f32> {
    return base * blend;
}

fn blend_screen(base: vec3<f32>, blend: vec3<f32>) -> vec3<f32> {
    return 1.0 - (1.0 - base) * (1.0 - blend);
}

fn blend_overlay_ch(base: f32, blend: f32) -> f32 {
    if base < 0.5 {
        return 2.0 * base * blend;
    } else {
        return 1.0 - 2.0 * (1.0 - base) * (1.0 - blend);
    }
}

fn blend_overlay(base: vec3<f32>, blend: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        blend_overlay_ch(base.r, blend.r),
        blend_overlay_ch(base.g, blend.g),
        blend_overlay_ch(base.b, blend.b),
    );
}

fn blend_darken(base: vec3<f32>, blend: vec3<f32>) -> vec3<f32> {
    return min(base, blend);
}

fn blend_lighten(base: vec3<f32>, blend: vec3<f32>) -> vec3<f32> {
    return max(base, blend);
}

fn blend_color_dodge_ch(base: f32, blend: f32) -> f32 {
    if blend >= 1.0 { return 1.0; }
    return min(1.0, base / (1.0 - blend));
}

fn blend_color_dodge(base: vec3<f32>, blend: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        blend_color_dodge_ch(base.r, blend.r),
        blend_color_dodge_ch(base.g, blend.g),
        blend_color_dodge_ch(base.b, blend.b),
    );
}

fn blend_color_burn_ch(base: f32, blend: f32) -> f32 {
    if blend <= 0.0 { return 0.0; }
    return max(0.0, 1.0 - (1.0 - base) / blend);
}

fn blend_color_burn(base: vec3<f32>, blend: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        blend_color_burn_ch(base.r, blend.r),
        blend_color_burn_ch(base.g, blend.g),
        blend_color_burn_ch(base.b, blend.b),
    );
}

fn blend_soft_light_ch(base: f32, blend: f32) -> f32 {
    if blend <= 0.5 {
        return base - (1.0 - 2.0 * blend) * base * (1.0 - base);
    } else {
        var d: f32;
        if base <= 0.25 {
            d = ((16.0 * base - 12.0) * base + 4.0) * base;
        } else {
            d = sqrt(base);
        }
        return base + (2.0 * blend - 1.0) * (d - base);
    }
}

fn blend_soft_light(base: vec3<f32>, blend: vec3<f32>) -> vec3<f32> {
    return vec3<f32>(
        blend_soft_light_ch(base.r, blend.r),
        blend_soft_light_ch(base.g, blend.g),
        blend_soft_light_ch(base.b, blend.b),
    );
}

fn blend_hard_light(base: vec3<f32>, blend: vec3<f32>) -> vec3<f32> {
    // Hard light is overlay with base and blend swapped
    return vec3<f32>(
        blend_overlay_ch(blend.r, base.r),
        blend_overlay_ch(blend.g, base.g),
        blend_overlay_ch(blend.b, base.b),
    );
}

fn blend_difference(base: vec3<f32>, blend: vec3<f32>) -> vec3<f32> {
    return abs(base - blend);
}

fn blend_exclusion(base: vec3<f32>, blend: vec3<f32>) -> vec3<f32> {
    return base + blend - 2.0 * base * blend;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let src = textureSample(t_source, s_source, in.uv);
    let dst = textureSample(t_dest, s_dest, in.uv);

    // Source is pre-multiplied from the layer shader; extract straight color
    let src_a = src.a * uniforms.opacity;
    var src_rgb = src.rgb;
    if src.a > 0.001 {
        src_rgb = src.rgb / src.a;
    }
    let dst_rgb = dst.rgb;

    var blended: vec3<f32>;
    switch uniforms.blend_mode {
        // 0 = Normal (shouldn't reach here, but handle as fallback)
        case 0u: { blended = src_rgb; }
        // 1 = Multiply
        case 1u: { blended = blend_multiply(dst_rgb, src_rgb); }
        // 2 = Screen
        case 2u: { blended = blend_screen(dst_rgb, src_rgb); }
        // 3 = Overlay
        case 3u: { blended = blend_overlay(dst_rgb, src_rgb); }
        // 4 = Darken
        case 4u: { blended = blend_darken(dst_rgb, src_rgb); }
        // 5 = Lighten
        case 5u: { blended = blend_lighten(dst_rgb, src_rgb); }
        // 6 = ColorDodge
        case 6u: { blended = blend_color_dodge(dst_rgb, src_rgb); }
        // 7 = ColorBurn
        case 7u: { blended = blend_color_burn(dst_rgb, src_rgb); }
        // 8 = SoftLight
        case 8u: { blended = blend_soft_light(dst_rgb, src_rgb); }
        // 9 = HardLight
        case 9u: { blended = blend_hard_light(dst_rgb, src_rgb); }
        // 10 = Difference
        case 10u: { blended = blend_difference(dst_rgb, src_rgb); }
        // 11 = Exclusion
        case 11u: { blended = blend_exclusion(dst_rgb, src_rgb); }
        // 12 = Additive (shouldn't reach here, uses hw blend)
        case 12u: { blended = src_rgb; }
        default: { blended = src_rgb; }
    }

    // Composite: blend result mixed with destination based on source alpha
    let out_rgb = mix(dst_rgb, blended, src_a);
    let out_a = dst.a + src_a * (1.0 - dst.a);

    return clamp(vec4<f32>(out_rgb, out_a), vec4<f32>(0.0), vec4<f32>(1.0));
}
"#;

/// WGSL shader for face-level calibration overlay.
/// Uses LayerVertex (position + tex_coord) where tex_coord is local [0,1] per face.
/// Same pattern logic as CALIBRATION_SHADER but drawn via vertex buffer over targeted faces.
pub const FACE_CALIBRATION_SHADER: &str = r#"
struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) tex_coord: vec3<f32>,
};

struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec3<f32>,
};

struct CalibrationUniforms {
    pattern: u32,
    line_width: f32,
    grid_divisions: f32,
    brightness: f32,
};

@group(0) @binding(0) var<uniform> uniforms: CalibrationUniforms;

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
    var out: VertexOutput;
    out.clip_position = vec4<f32>(
        in.position.x * 2.0 - 1.0,
        1.0 - in.position.y * 2.0,
        0.0, 1.0
    );
    out.uv = in.tex_coord;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let uv = in.uv.xy / in.uv.z;
    let brightness = uniforms.brightness;

    switch uniforms.pattern {
        case 0u: {
            let grid = uniforms.grid_divisions;
            let lw = uniforms.line_width;
            let gx = fract(uv.x * grid);
            let gy = fract(uv.y * grid);
            let line = step(gx, lw) + step(1.0 - lw, gx) + step(gy, lw) + step(1.0 - lw, gy);
            let c = min(line, 1.0) * brightness;
            return vec4<f32>(c, c, c, 1.0);
        }
        case 1u: {
            let lw = uniforms.line_width * 2.0;
            let cx = abs(uv.x - 0.5);
            let cy = abs(uv.y - 0.5);
            let line = step(cx, lw) + step(cy, lw);
            let c = min(line, 1.0) * brightness;
            return vec4<f32>(c, c, c, 1.0);
        }
        case 2u: {
            let grid = uniforms.grid_divisions;
            let cx = floor(uv.x * grid);
            let cy = floor(uv.y * grid);
            let checker = (cx + cy) % 2.0;
            let c = checker * brightness;
            return vec4<f32>(c, c, c, 1.0);
        }
        case 3u: {
            return vec4<f32>(brightness, brightness, brightness, 1.0);
        }
        case 4u: {
            let bar = floor(uv.x * 7.0);
            var r = 0.0; var g = 0.0; var b = 0.0;
            switch u32(bar) {
                case 0u: { r = 1.0; g = 1.0; b = 1.0; }
                case 1u: { r = 1.0; g = 1.0; b = 0.0; }
                case 2u: { r = 0.0; g = 1.0; b = 1.0; }
                case 3u: { r = 0.0; g = 1.0; b = 0.0; }
                case 4u: { r = 1.0; g = 0.0; b = 1.0; }
                case 5u: { r = 1.0; g = 0.0; b = 0.0; }
                case 6u: { r = 0.0; g = 0.0; b = 1.0; }
                default: { }
            }
            return vec4<f32>(r * brightness, g * brightness, b * brightness, 1.0);
        }
        case 5u: {
            return vec4<f32>(0.0, 0.0, 0.0, 1.0);
        }
        default: {
            return vec4<f32>(0.0, 0.0, 0.0, 1.0);
        }
    }
}
"#;

/// WGSL shader for calibration test pattern rendering
pub const CALIBRATION_SHADER: &str = r#"
struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

struct CalibrationUniforms {
    pattern: u32,      // 0=grid, 1=crosshair, 2=checkerboard, 3=white, 4=colorbars, 5=black
    line_width: f32,
    grid_divisions: f32,
    brightness: f32,
};

@group(0) @binding(0) var<uniform> uniforms: CalibrationUniforms;

// Fullscreen triangle vertex shader
@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var out: VertexOutput;
    let x = f32(i32(vertex_index) / 2) * 4.0 - 1.0;
    let y = f32(i32(vertex_index) % 2) * 4.0 - 1.0;
    out.clip_position = vec4<f32>(x, y, 0.0, 1.0);
    out.uv = vec2<f32>((x + 1.0) / 2.0, (1.0 - y) / 2.0);
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    let uv = in.uv;
    let brightness = uniforms.brightness;

    switch uniforms.pattern {
        // Grid
        case 0u: {
            let grid = uniforms.grid_divisions;
            let lw = uniforms.line_width;
            let gx = fract(uv.x * grid);
            let gy = fract(uv.y * grid);
            let line = step(gx, lw) + step(1.0 - lw, gx) + step(gy, lw) + step(1.0 - lw, gy);
            let c = min(line, 1.0) * brightness;
            return vec4<f32>(c, c, c, 1.0);
        }
        // Crosshair
        case 1u: {
            let lw = uniforms.line_width * 2.0;
            let cx = abs(uv.x - 0.5);
            let cy = abs(uv.y - 0.5);
            let line = step(cx, lw) + step(cy, lw);
            let c = min(line, 1.0) * brightness;
            return vec4<f32>(c, c, c, 1.0);
        }
        // Checkerboard
        case 2u: {
            let grid = uniforms.grid_divisions;
            let cx = floor(uv.x * grid);
            let cy = floor(uv.y * grid);
            let checker = (cx + cy) % 2.0;
            let c = checker * brightness;
            return vec4<f32>(c, c, c, 1.0);
        }
        // Full white
        case 3u: {
            return vec4<f32>(brightness, brightness, brightness, 1.0);
        }
        // Color bars (SMPTE-style simplified)
        case 4u: {
            let bar = floor(uv.x * 7.0);
            var r = 0.0; var g = 0.0; var b = 0.0;
            switch u32(bar) {
                case 0u: { r = 1.0; g = 1.0; b = 1.0; } // White
                case 1u: { r = 1.0; g = 1.0; b = 0.0; } // Yellow
                case 2u: { r = 0.0; g = 1.0; b = 1.0; } // Cyan
                case 3u: { r = 0.0; g = 1.0; b = 0.0; } // Green
                case 4u: { r = 1.0; g = 0.0; b = 1.0; } // Magenta
                case 5u: { r = 1.0; g = 0.0; b = 0.0; } // Red
                case 6u: { r = 0.0; g = 0.0; b = 1.0; } // Blue
                default: { }
            }
            return vec4<f32>(r * brightness, g * brightness, b * brightness, 1.0);
        }
        // Black
        case 5u: {
            return vec4<f32>(0.0, 0.0, 0.0, 1.0);
        }
        default: {
            return vec4<f32>(0.0, 0.0, 0.0, 1.0);
        }
    }
}
"#;
