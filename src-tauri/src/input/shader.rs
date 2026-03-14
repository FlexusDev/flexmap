use super::adapter::*;
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

const SHADER_SOURCES: [(&str, &str); 3] = [
    ("shader:plasma_flow", "Shader: Plasma Flow"),
    ("shader:kaleido_spin", "Shader: Kaleido Spin"),
    ("shader:tunnel_pulse", "Shader: Tunnel Pulse"),
];

const INSTALLED_ECO_WIDTH: u32 = 128;
const INSTALLED_ECO_HEIGHT: u32 = 96;
const INSTALLED_ECO_FRAME_INTERVAL: Duration = Duration::from_micros(41_666); // ~24fps

#[derive(Clone, Copy)]
struct InstalledVisualProfile {
    phase: f32,
    speed_a: f32,
    speed_b: f32,
    density: f32,
    hue: f32,
    contrast: f32,
    invert: bool,
}

impl InstalledVisualProfile {
    fn from_source(source: &InstalledShaderSource) -> Self {
        let mut fingerprint = source.seed as u64 ^ 0x9E37_79B9_7F4A_7C15;

        for byte in source.id.bytes() {
            fingerprint = fingerprint
                .wrapping_mul(0x100_0000_01b3)
                .wrapping_add(byte as u64 + 1);
        }

        if let Some(hash) = source.source_hash.as_deref() {
            for byte in hash.bytes() {
                fingerprint = fingerprint
                    .wrapping_mul(0x100_0000_01b3)
                    .wrapping_add(byte as u64 + 7);
            }
        }

        let unit = |shift: u32| -> f32 { ((fingerprint >> shift) & 0xffff) as f32 / 65535.0 };

        Self {
            phase: unit(12) * std::f32::consts::TAU,
            speed_a: 0.7 + unit(28) * 1.6,
            speed_b: 0.55 + unit(44) * 1.45,
            density: 3.4 + unit(8) * 6.2,
            hue: unit(52),
            contrast: 0.9 + unit(20) * 0.35,
            invert: false,
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum ShaderQualityTier {
    Eco,
}

#[derive(Clone, Copy, Debug)]
enum IsfPattern {
    Plasma,
    Kaleido,
    Tunnel,
    Grid,
    Ripple,
    Noise,
}

#[derive(Clone, Debug)]
struct IsfCompiledSource {
    pattern: IsfPattern,
    input_bias: f32,
    warnings: Vec<String>,
    supports_runtime: bool,
}

#[derive(Clone)]
struct InstalledRuntimeConfig {
    profile: InstalledVisualProfile,
    quality: ShaderQualityTier,
    width: u32,
    height: u32,
    frame_interval: Duration,
    compiled: IsfCompiledSource,
}

#[derive(Clone, Copy)]
struct SourceModulation {
    bpm: f32,
    beat: f32,
    level: f32,
    phase: f32,
    beat_gain: f32,
}

impl Default for SourceModulation {
    fn default() -> Self {
        Self {
            bpm: 120.0,
            beat: 0.0,
            level: 0.0,
            phase: 0.0,
            beat_gain: 0.0,
        }
    }
}

pub struct ShaderPatternBackend {
    active_sources: HashSet<String>,
    start_time: Instant,
    builtin_width: u32,
    builtin_height: u32,
    source_counters: HashMap<String, u64>,
    source_last_emit: HashMap<String, Instant>,
    installed_sources: HashMap<String, InstalledShaderSource>,
    installed_profile_cache: HashMap<String, InstalledVisualProfile>,
    installed_runtime: HashMap<String, InstalledRuntimeConfig>,
    compiled_cache: HashMap<String, IsfCompiledSource>,
    source_modulation: HashMap<String, SourceModulation>,
}

impl ShaderPatternBackend {
    pub fn new() -> Self {
        Self {
            active_sources: HashSet::new(),
            start_time: Instant::now(),
            builtin_width: 160,
            builtin_height: 120,
            source_counters: HashMap::new(),
            source_last_emit: HashMap::new(),
            installed_sources: HashMap::new(),
            installed_profile_cache: HashMap::new(),
            installed_runtime: HashMap::new(),
            compiled_cache: HashMap::new(),
            source_modulation: HashMap::new(),
        }
    }

    fn is_valid_source(source_id: &str) -> bool {
        SHADER_SOURCES.iter().any(|(id, _)| *id == source_id)
    }

    fn runtime_cache_key(source: &InstalledShaderSource) -> String {
        source
            .source_hash
            .clone()
            .unwrap_or_else(|| source.id.clone())
    }

    fn runtime_config_for_source(&self, source: &InstalledShaderSource) -> InstalledRuntimeConfig {
        if let Some(config) = self.installed_runtime.get(&source.id) {
            return config.clone();
        }

        // Fallback: keep rendering even if runtime config isn't precomputed.
        let compiled = Self::compile_installed_source(source);
        InstalledRuntimeConfig {
            profile: InstalledVisualProfile::from_source(source),
            quality: ShaderQualityTier::Eco,
            width: INSTALLED_ECO_WIDTH,
            height: INSTALLED_ECO_HEIGHT,
            frame_interval: INSTALLED_ECO_FRAME_INTERVAL,
            compiled,
        }
    }

    fn compile_installed_source(source: &InstalledShaderSource) -> IsfCompiledSource {
        let Some(source_code) = source.source_code.as_deref() else {
            return IsfCompiledSource {
                pattern: IsfPattern::Noise,
                input_bias: 0.0,
                warnings: vec![
                    "No ISF source text found. This source cannot run real ISF code yet."
                        .to_string(),
                ],
                supports_runtime: false,
            };
        };

        let mut warnings = Vec::new();
        let mut input_bias = 0.0f32;
        let lower = source_code.to_lowercase();

        if let Some(header) = extract_isf_header_json(source_code) {
            if let Some(inputs) = header.get("INPUTS").and_then(|value| value.as_array()) {
                for input in inputs {
                    let kind = input
                        .get("TYPE")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_ascii_lowercase();
                    let default = input.get("DEFAULT");
                    input_bias += summarize_input_bias(kind.as_str(), default);
                }
            }

            if header
                .get("PASSES")
                .and_then(|value| value.as_array())
                .map(|passes| passes.len() > 1)
                .unwrap_or(false)
            {
                warnings.push(
                    "Multi-pass ISF detected. Runtime currently executes single-pass approximation."
                        .to_string(),
                );
            }
        } else {
            warnings.push("Could not parse ISF JSON header; using runtime defaults.".to_string());
        }

        if lower.contains("audiofft") || lower.contains("audiodata") || lower.contains("sound") {
            warnings.push(
                "Audio-specific ISF inputs detected; using fallback values until audio mapping is configured."
                    .to_string(),
            );
        }

        let pattern = detect_pattern(&lower, source.seed);
        IsfCompiledSource {
            pattern,
            input_bias: input_bias.clamp(-1.0, 1.0),
            warnings,
            supports_runtime: true,
        }
    }

    pub fn generate_frame_for_source(&mut self, source_id: &str) -> Option<FramePacket> {
        let is_builtin = Self::is_valid_source(source_id);
        let installed_source = self.installed_sources.get(source_id);
        if !is_builtin && installed_source.is_none() {
            log::warn!(
                "[ISF-diag] generate_frame: unknown source_id={} (installed_sources has {} entries: [{}])",
                source_id,
                self.installed_sources.len(),
                self.installed_sources.keys().take(10).cloned().collect::<Vec<_>>().join(", ")
            );
            return None;
        }

        // Log on first frame generation per source
        let is_first = !self.source_counters.contains_key(source_id);
        if is_first {
            if let Some(src) = installed_source {
                let has_code = src.source_code.is_some();
                let runtime_ready = self
                    .installed_runtime
                    .get(source_id)
                    .map(|r| r.compiled.supports_runtime)
                    .unwrap_or(false);
                log::info!(
                    "[ISF-diag] generate_frame: first frame for {} (has_code={}, runtime_ready={}, seed={})",
                    source_id, has_code, runtime_ready, src.seed
                );
            } else {
                log::info!(
                    "[ISF-diag] generate_frame: first frame for builtin {}",
                    source_id
                );
            }
        }

        let installed_runtime = installed_source.map(|source| {
            if let Some(runtime) = self.installed_runtime.get(source_id) {
                runtime.clone()
            } else {
                log::warn!(
                    "Installed shader runtime config missing for {}; using eco fallback",
                    source_id
                );
                self.runtime_config_for_source(source)
            }
        });

        if let Some(runtime) = &installed_runtime {
            let now = Instant::now();
            if let Some(last_emit) = self.source_last_emit.get(source_id) {
                if now.duration_since(*last_emit) < runtime.frame_interval {
                    return None;
                }
            }
            self.source_last_emit.insert(source_id.to_string(), now);
        }

        let t = self.start_time.elapsed().as_secs_f32();
        let modulation = self
            .source_modulation
            .get(source_id)
            .copied()
            .unwrap_or_default();

        let data = match source_id {
            "shader:plasma_flow" => self.generate_plasma_flow(t),
            "shader:kaleido_spin" => self.generate_kaleido_spin(t),
            "shader:tunnel_pulse" => self.generate_tunnel_pulse(t),
            _ => self.generate_installed_shader(t, installed_runtime.as_ref()?, modulation),
        };

        let (width, height) = if let Some(runtime) = installed_runtime {
            (runtime.width, runtime.height)
        } else {
            (self.builtin_width, self.builtin_height)
        };

        let counter = self
            .source_counters
            .entry(source_id.to_string())
            .or_insert(0);
        *counter += 1;

        Some(FramePacket {
            width,
            height,
            pixel_format: PixelFormat::Rgba8,
            data,
            timestamp: Some(self.start_time.elapsed().as_millis() as u64),
            sequence: Some(*counter),
        })
    }

    fn generate_plasma_flow(&self, t: f32) -> Vec<u8> {
        let w = self.builtin_width as usize;
        let h = self.builtin_height as usize;
        let mut data = vec![0u8; w * h * 4];

        for y in 0..h {
            for x in 0..w {
                let nx = x as f32 / w as f32;
                let ny = y as f32 / h as f32;

                let wave = (nx * 10.0 + t * 1.4).sin()
                    + (ny * 12.0 - t * 1.1).sin()
                    + ((nx + ny) * 9.0 + t * 0.7).sin();
                let v = wave / 3.0;

                let r = 0.5 + 0.5 * (v + t * 0.6).sin();
                let g = 0.5 + 0.5 * (v * 1.3 - t * 0.4).sin();
                let b = 0.5 + 0.5 * (v * 1.7 + t * 0.2).sin();

                let idx = (y * w + x) * 4;
                data[idx] = to_u8(r);
                data[idx + 1] = to_u8(g);
                data[idx + 2] = to_u8(b);
                data[idx + 3] = 255;
            }
        }

        data
    }

    fn generate_kaleido_spin(&self, t: f32) -> Vec<u8> {
        let w = self.builtin_width as usize;
        let h = self.builtin_height as usize;
        let mut data = vec![0u8; w * h * 4];

        for y in 0..h {
            for x in 0..w {
                let nx = x as f32 / w as f32;
                let ny = y as f32 / h as f32;
                let cx = nx - 0.5;
                let cy = ny - 0.5;

                let radius = (cx * cx + cy * cy).sqrt() * 2.0;
                let angle = cy.atan2(cx);

                let mirrored = ((angle * 6.0 + t).sin()).abs();
                let rings = ((radius * 11.0 - t * 2.3).sin() * 0.5) + 0.5;
                let glow = (1.0 - radius).clamp(0.0, 1.0);

                let r = (mirrored * 0.8 + rings * 0.2) * glow + rings * 0.15;
                let g = (rings * 0.7 + mirrored * 0.3) * glow + mirrored * 0.1;
                let b = ((1.0 - mirrored) * 0.8 + rings * 0.2) * glow + 0.1;

                let idx = (y * w + x) * 4;
                data[idx] = to_u8(r);
                data[idx + 1] = to_u8(g);
                data[idx + 2] = to_u8(b);
                data[idx + 3] = 255;
            }
        }

        data
    }

    fn generate_tunnel_pulse(&self, t: f32) -> Vec<u8> {
        let w = self.builtin_width as usize;
        let h = self.builtin_height as usize;
        let mut data = vec![0u8; w * h * 4];

        for y in 0..h {
            for x in 0..w {
                let nx = x as f32 / w as f32;
                let ny = y as f32 / h as f32;
                let cx = nx - 0.5;
                let cy = ny - 0.5;

                let dist = (cx * cx + cy * cy).sqrt().max(0.001);
                let angle = cy.atan2(cx);

                let rings = ((10.0 / dist) - t * 4.0).sin() * 0.5 + 0.5;
                let spokes = (angle * 8.0 + t * 1.6).sin() * 0.5 + 0.5;
                let pulse = (t * 2.2).sin() * 0.5 + 0.5;
                let blend = rings * 0.6 + spokes * 0.4;

                let r = blend * (0.35 + 0.65 * pulse);
                let g = (blend * 0.75 + (1.0 - rings) * 0.25) * (0.45 + 0.55 * pulse);
                let b = (1.0 - blend) * 0.7 + rings * 0.3;

                let idx = (y * w + x) * 4;
                data[idx] = to_u8(r);
                data[idx + 1] = to_u8(g);
                data[idx + 2] = to_u8(b);
                data[idx + 3] = 255;
            }
        }

        data
    }

    fn generate_installed_shader(
        &self,
        t: f32,
        runtime: &InstalledRuntimeConfig,
        modulation: SourceModulation,
    ) -> Vec<u8> {
        if !runtime.compiled.supports_runtime {
            return generate_error_frame(runtime.width, runtime.height, t);
        }

        let w = runtime.width as usize;
        let h = runtime.height as usize;
        let mut data = vec![0u8; w * h * 4];
        let profile = runtime.profile;

        let tempo = (modulation.bpm / 120.0).clamp(0.5, 2.5);
        let beat = modulation.beat_gain.clamp(0.0, 1.5);
        let beat_pulse = modulation.beat.clamp(0.0, 1.0);
        let level = modulation.level.clamp(0.0, 1.0);
        let phase = profile.phase + modulation.phase * std::f32::consts::TAU;
        let input_bias = runtime.compiled.input_bias;
        let time = t * (0.6 + 0.4 * tempo) + beat * 0.25 + beat_pulse * 0.1;

        for y in 0..h {
            for x in 0..w {
                let nx = x as f32 / w as f32;
                let ny = y as f32 / h as f32;
                let cx = nx - 0.5;
                let cy = ny - 0.5;
                let radius = (cx * cx + cy * cy).sqrt().max(0.001);
                let angle = cy.atan2(cx);

                let (value, energy) = match runtime.compiled.pattern {
                    IsfPattern::Plasma => {
                        let wave = (nx * (8.0 + profile.density) + time * profile.speed_a + phase)
                            .sin()
                            + (ny * (9.0 + profile.density * 0.8) - time * profile.speed_b).cos()
                            + ((nx + ny) * (4.0 + profile.density * 0.4) + time * 0.9).sin();
                        let value = (wave / 3.0) + input_bias * 0.35;
                        let energy = 0.45
                            + (0.5 + 0.5 * (time * 1.2).sin()) * (0.45 + 0.1 * beat_pulse)
                            + beat * 0.25;
                        (value, energy)
                    }
                    IsfPattern::Kaleido => {
                        let mirrored = (angle * (6.0 + profile.density * 0.6)
                            + time * profile.speed_a)
                            .sin()
                            .abs();
                        let rings = (radius * (8.0 + profile.density * 0.7)
                            - time * profile.speed_b * 1.9)
                            .sin();
                        let value =
                            (mirrored * 1.2 - 0.2) * 0.65 + rings * 0.35 + input_bias * 0.25;
                        let energy =
                            (1.0 - radius * 1.2).clamp(0.15, 1.0) + beat * 0.3 + beat_pulse * 0.12;
                        (value, energy)
                    }
                    IsfPattern::Tunnel => {
                        let tunnel = ((9.5 / radius) - time * profile.speed_a * 2.6).sin();
                        let spokes = (angle * (7.0 + profile.density * 0.8)
                            + time * profile.speed_b * 1.8)
                            .cos();
                        let pulse = (time * 1.8 + phase).sin() * 0.5 + 0.5;
                        let value = tunnel * 0.6 + spokes * 0.4 + input_bias * 0.2;
                        let energy = (0.35 + pulse * 0.65) * (1.0 - radius * 0.8).clamp(0.25, 1.0)
                            + beat * 0.25
                            + beat_pulse * 0.08;
                        (value, energy)
                    }
                    IsfPattern::Grid => {
                        let gx =
                            (nx * (12.0 + profile.density) + time * profile.speed_a + phase).sin();
                        let gy = (ny * (12.0 + profile.density) - time * profile.speed_b).sin();
                        let cells = gx.signum() * gy.signum();
                        let scan = (ny * 90.0 + time * 12.0).sin() * 0.5 + 0.5;
                        let value = cells * 0.85 + (scan * 2.0 - 1.0) * 0.15 + input_bias * 0.2;
                        let energy = 0.3 + scan * 0.7 + beat * 0.2 + beat_pulse * 0.07;
                        (value, energy)
                    }
                    IsfPattern::Ripple => {
                        let ripple = (radius * (16.0 + profile.density)
                            - time * profile.speed_a * 2.4
                            + phase)
                            .sin();
                        let swirl =
                            (angle * (3.0 + profile.density * 0.35) + time * profile.speed_b).cos();
                        let value = ripple * 0.7 + swirl * 0.3 + input_bias * 0.3;
                        let energy = (1.0 - radius).clamp(0.2, 1.0) * (0.6 + 0.4 * level)
                            + beat * 0.22
                            + beat_pulse * 0.08;
                        (value, energy)
                    }
                    IsfPattern::Noise => {
                        let noise = pseudo_noise(
                            nx * profile.density * 14.0,
                            ny * profile.density * 12.0,
                            time * 0.8,
                        );
                        let contour = (noise * std::f32::consts::TAU + phase).sin();
                        let shimmer = (noise + time * 0.15).cos() * 0.5 + 0.5;
                        let value = contour + input_bias * 0.35;
                        let energy = 0.25 + shimmer * 0.75 + beat * 0.2 + beat_pulse * 0.06;
                        (value, energy)
                    }
                };

                let (r, g, b) = installed_palette(value, energy, time, profile);
                let idx = (y * w + x) * 4;
                data[idx] = r;
                data[idx + 1] = g;
                data[idx + 2] = b;
                data[idx + 3] = 255;
            }
        }

        data
    }
}

impl InputBackend for ShaderPatternBackend {
    fn protocol_name(&self) -> &str {
        "shader"
    }

    fn list_sources(&self) -> Vec<SourceInfo> {
        let width = Some(self.builtin_width);
        let height = Some(self.builtin_height);

        SHADER_SOURCES
            .iter()
            .map(|(id, name)| SourceInfo {
                id: (*id).to_string(),
                name: (*name).to_string(),
                protocol: "shader".to_string(),
                width,
                height,
                fps: Some(30.0),
            })
            .chain(self.installed_sources.values().map(|src| {
                let runtime = self.runtime_config_for_source(src);
                SourceInfo {
                    id: src.id.clone(),
                    name: src.name.clone(),
                    protocol: "shader".to_string(),
                    width: Some(runtime.width),
                    height: Some(runtime.height),
                    fps: Some(1.0 / runtime.frame_interval.as_secs_f64()),
                }
            }))
            .collect()
    }

    fn connect(&mut self, source_id: &str) -> Result<(), InputError> {
        if !Self::is_valid_source(source_id) && !self.installed_sources.contains_key(source_id) {
            return Err(InputError::SourceNotFound(source_id.to_string()));
        }

        let was_empty = self.active_sources.is_empty();
        self.active_sources.insert(source_id.to_string());
        self.source_last_emit.remove(source_id);

        if was_empty {
            self.start_time = Instant::now();
        }

        if let Some(installed) = self.installed_sources.get(source_id) {
            let runtime = self.runtime_config_for_source(installed);
            for warning in &runtime.compiled.warnings {
                log::warn!("ISF {}: {}", installed.id, warning);
            }
            log::info!(
                "Installed shader connected: {} (seed={}, hash={:?}, pattern={:?}, tier={}, {}x{}, {:.1}fps)",
                installed.id,
                installed.seed,
                installed.source_hash,
                runtime.compiled.pattern,
                quality_tier_label(runtime.quality),
                runtime.width,
                runtime.height,
                1.0 / runtime.frame_interval.as_secs_f64()
            );
        }

        Ok(())
    }

    fn disconnect(&mut self) {
        self.active_sources.clear();
        self.source_last_emit.clear();
        self.source_modulation.clear();
    }

    fn disconnect_source(&mut self, source_id: &str) {
        self.active_sources.remove(source_id);
        self.source_last_emit.remove(source_id);
        self.source_modulation.remove(source_id);
    }

    fn poll_frame(&mut self) -> Option<FramePacket> {
        let first = self.active_sources.iter().next()?.clone();
        self.generate_frame_for_source(&first)
    }

    fn poll_frame_for_source(&mut self, source_id: &str) -> Option<FramePacket> {
        if !self.active_sources.contains(source_id) {
            return None;
        }
        self.generate_frame_for_source(source_id)
    }

    fn state(&self) -> SourceState {
        if self.active_sources.is_empty() {
            SourceState::Disconnected
        } else {
            SourceState::Connected
        }
    }

    fn connected_source(&self) -> Option<&SourceInfo> {
        None
    }

    fn is_source_active(&self, source_id: &str) -> bool {
        self.active_sources.contains(source_id)
    }

    fn set_installed_sources(&mut self, sources: Vec<InstalledShaderSource>) {
        let total = sources.len();
        let with_code = sources.iter().filter(|s| s.source_code.is_some()).count();
        log::info!(
            "[ISF-diag] set_installed_sources: received {} source(s) ({} with code, {} without)",
            total,
            with_code,
            total - with_code
        );

        self.installed_sources = sources.into_iter().map(|s| (s.id.clone(), s)).collect();
        self.installed_runtime.clear();

        let mut active_cache_keys = HashSet::new();
        let mut compile_ok = 0usize;
        let mut compile_fallback = 0usize;
        for source in self.installed_sources.values() {
            let cache_key = Self::runtime_cache_key(source);
            active_cache_keys.insert(cache_key.clone());

            let profile = *self
                .installed_profile_cache
                .entry(cache_key.clone())
                .or_insert_with(|| InstalledVisualProfile::from_source(source));
            let compiled = self
                .compiled_cache
                .entry(cache_key)
                .or_insert_with(|| Self::compile_installed_source(source))
                .clone();

            if compiled.supports_runtime {
                compile_ok += 1;
            } else {
                compile_fallback += 1;
                log::warn!(
                    "[ISF-diag] compile fallback for {}: pattern={:?}, warnings={:?}",
                    source.id,
                    compiled.pattern,
                    compiled.warnings
                );
            }

            self.installed_runtime.insert(
                source.id.clone(),
                InstalledRuntimeConfig {
                    profile,
                    quality: ShaderQualityTier::Eco,
                    width: INSTALLED_ECO_WIDTH,
                    height: INSTALLED_ECO_HEIGHT,
                    frame_interval: INSTALLED_ECO_FRAME_INTERVAL,
                    compiled,
                },
            );
        }

        log::info!(
            "[ISF-diag] set_installed_sources: compiled {} runtime-ready, {} fallback",
            compile_ok,
            compile_fallback
        );

        self.installed_profile_cache
            .retain(|cache_key, _| active_cache_keys.contains(cache_key));
        self.compiled_cache
            .retain(|cache_key, _| active_cache_keys.contains(cache_key));

        let active_before = self.active_sources.len();
        self.active_sources
            .retain(|id| Self::is_valid_source(id) || self.installed_sources.contains_key(id));
        let pruned = active_before - self.active_sources.len();
        if pruned > 0 {
            log::warn!(
                "[ISF-diag] set_installed_sources: pruned {} stale active source(s)",
                pruned
            );
        }
        self.source_counters
            .retain(|id, _| Self::is_valid_source(id) || self.installed_sources.contains_key(id));
        self.source_last_emit
            .retain(|id, _| Self::is_valid_source(id) || self.installed_sources.contains_key(id));
        self.source_modulation
            .retain(|id, _| Self::is_valid_source(id) || self.installed_sources.contains_key(id));
    }

    fn set_frame_modulation(
        &mut self,
        source_id: &str,
        bpm: BpmRuntimeSnapshot,
        layer: LayerBeatModulation,
    ) {
        let beat_amount = if layer.beat_reactive {
            layer.beat_amount.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let beat_gain = ((bpm.beat * 0.75 + bpm.level * 0.25) * beat_amount).clamp(0.0, 1.5);
        self.source_modulation.insert(
            source_id.to_string(),
            SourceModulation {
                bpm: bpm.bpm.max(1.0),
                beat: bpm.beat.clamp(0.0, 1.0),
                level: bpm.level.clamp(0.0, 1.0),
                phase: bpm.phase.fract(),
                beat_gain,
            },
        );
    }
}

fn quality_tier_label(tier: ShaderQualityTier) -> &'static str {
    match tier {
        ShaderQualityTier::Eco => "eco",
    }
}

fn detect_pattern(lower: &str, seed: u32) -> IsfPattern {
    if lower.contains("kaleid") || lower.contains("mirror") {
        return IsfPattern::Kaleido;
    }
    if lower.contains("tunnel") || lower.contains("spiral") {
        return IsfPattern::Tunnel;
    }
    if lower.contains("grid") || lower.contains("checker") || lower.contains("brick") {
        return IsfPattern::Grid;
    }
    if lower.contains("ripple") || lower.contains("wave") {
        return IsfPattern::Ripple;
    }
    if lower.contains("noise") || lower.contains("grain") {
        return IsfPattern::Noise;
    }
    if lower.contains("plasma") || lower.contains("flow") || lower.contains("cloud") {
        return IsfPattern::Plasma;
    }

    match seed % 6 {
        0 => IsfPattern::Plasma,
        1 => IsfPattern::Kaleido,
        2 => IsfPattern::Tunnel,
        3 => IsfPattern::Grid,
        4 => IsfPattern::Ripple,
        _ => IsfPattern::Noise,
    }
}

fn extract_isf_header_json(source: &str) -> Option<serde_json::Value> {
    let comment_start = source.find("/*")?;
    let after_start = comment_start + 2;
    let comment_end = source[after_start..].find("*/")? + after_start;
    let comment = &source[after_start..comment_end];

    let json_start = comment.find('{')?;
    let json_end = comment.rfind('}')?;
    if json_end <= json_start {
        return None;
    }

    let raw = &comment[json_start..=json_end];
    serde_json::from_str::<serde_json::Value>(raw).ok()
}

fn summarize_input_bias(kind: &str, default: Option<&serde_json::Value>) -> f32 {
    match kind {
        "float" => default
            .and_then(|value| value.as_f64())
            .map(|value| value as f32 * 0.07)
            .unwrap_or(0.0),
        "long" => default
            .and_then(|value| value.as_i64())
            .map(|value| value as f32 * 0.015)
            .unwrap_or(0.0),
        "bool" => default
            .and_then(|value| value.as_bool())
            .map(|value| if value { 0.12 } else { -0.05 })
            .unwrap_or(0.0),
        "color" => {
            if let Some(values) = default.and_then(|value| value.as_array()) {
                if values.is_empty() {
                    0.0
                } else {
                    let mut sum = 0.0f32;
                    let mut count = 0.0f32;
                    for value in values {
                        if let Some(v) = value.as_f64() {
                            sum += v as f32;
                            count += 1.0;
                        }
                    }
                    if count > 0.0 {
                        (sum / count) * 0.1
                    } else {
                        0.0
                    }
                }
            } else {
                0.0
            }
        }
        "point2d" => {
            if let Some(values) = default.and_then(|value| value.as_array()) {
                let x = values
                    .first()
                    .and_then(|value| value.as_f64())
                    .unwrap_or(0.5) as f32;
                let y = values
                    .get(1)
                    .and_then(|value| value.as_f64())
                    .unwrap_or(0.5) as f32;
                (x + y - 1.0) * 0.2
            } else {
                0.0
            }
        }
        _ => 0.0,
    }
}

#[inline]
fn to_u8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0) as u8
}

fn pseudo_noise(x: f32, y: f32, t: f32) -> f32 {
    let n = (x * 127.1 + y * 311.7 + t * 74.7).sin() * 43758.5453;
    (n - n.floor()) * 2.0 - 1.0
}

#[inline]
fn installed_palette(
    value: f32,
    energy: f32,
    t: f32,
    profile: InstalledVisualProfile,
) -> (u8, u8, u8) {
    let phase = profile.phase + profile.hue * std::f32::consts::TAU;
    let tone = value * profile.contrast;
    let boost = energy.clamp(0.0, 1.2);

    let mut r = (0.5 + 0.5 * (tone + phase + t * 0.22).sin()) * boost;
    let mut g = (0.5 + 0.5 * (tone * 1.25 + phase + 2.1 - t * 0.14).sin()) * boost;
    let mut b = (0.5 + 0.5 * (tone * 1.65 + phase + 4.2 + t * 0.09).sin()) * boost;

    if profile.invert {
        r = 1.0 - r;
        g = 1.0 - g;
        b = 1.0 - b;
    }

    (to_u8(r), to_u8(g), to_u8(b))
}

fn generate_error_frame(width: u32, height: u32, t: f32) -> Vec<u8> {
    let w = width as usize;
    let h = height as usize;
    let mut data = vec![0u8; w * h * 4];
    let pulse = (0.5 + 0.5 * (t * 2.8).sin()).clamp(0.15, 1.0);

    for y in 0..h {
        for x in 0..w {
            let nx = x as f32 / w as f32;
            let ny = y as f32 / h as f32;
            let diag = (nx - ny).abs();
            let anti = (nx - (1.0 - ny)).abs();
            let stripe = ((x + y) as f32 * 0.25 + t * 12.0).sin() * 0.5 + 0.5;
            let mark = if diag < 0.025 || anti < 0.025 {
                1.0
            } else {
                0.0
            };
            let r = (0.2 + 0.75 * mark + 0.25 * stripe) * pulse;
            let g = 0.04 + 0.06 * stripe;
            let b = 0.04 + 0.08 * stripe;

            let idx = (y * w + x) * 4;
            data[idx] = to_u8(r);
            data[idx + 1] = to_u8(g);
            data[idx + 2] = to_u8(b);
            data[idx + 3] = 255;
        }
    }

    data
}
