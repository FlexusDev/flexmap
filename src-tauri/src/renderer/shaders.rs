/// WGSL shader for layer rendering with post-processing
/// Handles textured quad/triangle/mesh rendering with per-layer adjustments
pub const LAYER_SHADER: &str = r#"
// Vertex input
struct VertexInput {
    @location(0) position: vec2<f32>,
    @location(1) tex_coord: vec2<f32>,
};

// Vertex output / Fragment input
struct VertexOutput {
    @builtin(position) clip_position: vec4<f32>,
    @location(0) tex_coord: vec2<f32>,
};

// Per-layer uniforms
struct LayerUniforms {
    // Post-processing
    brightness: f32,
    contrast: f32,
    gamma: f32,
    opacity: f32,
    // Feather
    feather: f32,
    // Padding for alignment
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
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

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    var color = textureSample(t_source, s_source, in.tex_coord);

    // Apply brightness
    color = vec4<f32>(color.rgb * uniforms.brightness, color.a);

    // Apply contrast (centered around 0.5)
    color = vec4<f32>(
        (color.rgb - vec3<f32>(0.5)) * uniforms.contrast + vec3<f32>(0.5),
        color.a
    );

    // Apply gamma correction
    let inv_gamma = 1.0 / max(uniforms.gamma, 0.01);
    color = vec4<f32>(
        pow(max(color.rgb, vec3<f32>(0.0)), vec3<f32>(inv_gamma)),
        color.a
    );

    // Apply feather (soft edge based on distance from center of UV)
    if uniforms.feather > 0.0 {
        let center = vec2<f32>(0.5, 0.5);
        let dist = length(in.tex_coord - center) * 2.0;
        let feather_start = 1.0 - uniforms.feather;
        let feather_alpha = 1.0 - smoothstep(feather_start, 1.0, dist);
        color = vec4<f32>(color.rgb, color.a * feather_alpha);
    }

    // Apply opacity
    color = vec4<f32>(color.rgb, color.a * uniforms.opacity);

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
