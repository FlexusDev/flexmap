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
