// Test pattern input backend — always available, no external dependencies.
// Generates animated RGBA frames for development and calibration.
//
// Unlike real capture backends, the test pattern backend can serve
// multiple sources simultaneously (each layer can use a different pattern).

use super::adapter::*;
use std::collections::HashSet;
use std::time::Instant;

/// Available test pattern types
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TestPatternKind {
    ColorBars,
    GradientSweep,
    Checkerboard,
    SolidColor,
}

pub struct TestPatternBackend {
    /// Set of currently active source IDs (supports multiple simultaneous)
    active_sources: HashSet<String>,
    start_time: Instant,
    width: u32,
    height: u32,
    /// Per-source sequence counters (avoids shared mutable state between sources)
    source_counters: std::collections::HashMap<String, u64>,
}

const VALID_SOURCES: [&str; 4] = [
    "test:color_bars",
    "test:gradient",
    "test:checkerboard",
    "test:solid",
];

impl TestPatternBackend {
    pub fn new() -> Self {
        // Generate at preview resolution directly — these are procedural patterns,
        // so there's no quality loss. Generating at 640×480 then downscaling to
        // 160×120 wasted ~30ms per frame on an M1 Pro.
        Self {
            active_sources: HashSet::new(),
            start_time: Instant::now(),
            width: 160,
            height: 120,
            source_counters: std::collections::HashMap::new(),
        }
    }

    /// Generate a frame for a specific source_id without needing to be "connected"
    pub fn generate_frame_for_source(&mut self, source_id: &str) -> Option<FramePacket> {
        if !VALID_SOURCES.contains(&source_id) {
            return None;
        }

        let t = self.start_time.elapsed().as_secs_f32();

        let data = match source_id {
            "test:color_bars" => self.generate_color_bars(t),
            "test:gradient" => self.generate_gradient_sweep(t),
            "test:checkerboard" => self.generate_checkerboard(t),
            "test:solid" => self.generate_solid_color(t),
            _ => return None,
        };

        // Per-source sequence counter to avoid shared mutable state
        let counter = self
            .source_counters
            .entry(source_id.to_string())
            .or_insert(0);
        *counter += 1;
        let seq = *counter;

        Some(FramePacket {
            width: self.width,
            height: self.height,
            pixel_format: PixelFormat::Rgba8,
            data,
            timestamp: Some(self.start_time.elapsed().as_millis() as u64),
            sequence: Some(seq),
        })
    }

    fn generate_color_bars(&self, t: f32) -> Vec<u8> {
        let w = self.width as usize;
        let h = self.height as usize;
        let mut data = vec![0u8; w * h * 4];

        // Classic 7-bar pattern with animated hue shift
        let bar_colors: [(u8, u8, u8); 7] = [
            (192, 192, 192), // White (75%)
            (192, 192, 0),   // Yellow
            (0, 192, 192),   // Cyan
            (0, 192, 0),     // Green
            (192, 0, 192),   // Magenta
            (192, 0, 0),     // Red
            (0, 0, 192),     // Blue
        ];

        let hue_shift = ((t * 30.0) % 360.0) as i32;

        for y in 0..h {
            for x in 0..w {
                let bar_idx = (x * 7) / w;
                let (r, g, b) = bar_colors[bar_idx.min(6)];

                // Animate: shift hue slightly over time
                let r = ((r as i32 + hue_shift) % 256).unsigned_abs() as u8;

                let offset = (y * w + x) * 4;
                data[offset] = r;
                data[offset + 1] = g;
                data[offset + 2] = b;
                data[offset + 3] = 255;
            }
        }

        data
    }

    fn generate_gradient_sweep(&self, t: f32) -> Vec<u8> {
        let w = self.width as usize;
        let h = self.height as usize;
        let mut data = vec![0u8; w * h * 4];

        let sweep = (t * 0.5) % 1.0;

        for y in 0..h {
            for x in 0..w {
                let nx = x as f32 / w as f32;
                let ny = y as f32 / h as f32;

                // Diagonal gradient that sweeps across
                let v = ((nx + ny + sweep) % 1.0 * 255.0) as u8;

                // RGB channels at different phases
                let r = v;
                let g = ((nx * 255.0 + t * 50.0) % 255.0) as u8;
                let b = ((ny * 255.0 + t * 80.0) % 255.0) as u8;

                let offset = (y * w + x) * 4;
                data[offset] = r;
                data[offset + 1] = g;
                data[offset + 2] = b;
                data[offset + 3] = 255;
            }
        }

        data
    }

    fn generate_checkerboard(&self, t: f32) -> Vec<u8> {
        let w = self.width as usize;
        let h = self.height as usize;
        let mut data = vec![0u8; w * h * 4];

        let cell_size = 32;
        let phase = (t * 2.0) as usize;

        for y in 0..h {
            for x in 0..w {
                let cx = (x + phase) / cell_size;
                let cy = (y + phase) / cell_size;
                let is_white = (cx + cy) % 2 == 0;
                let v = if is_white { 240u8 } else { 16u8 };

                let offset = (y * w + x) * 4;
                data[offset] = v;
                data[offset + 1] = v;
                data[offset + 2] = v;
                data[offset + 3] = 255;
            }
        }

        data
    }

    fn generate_solid_color(&self, t: f32) -> Vec<u8> {
        let w = self.width as usize;
        let h = self.height as usize;
        let mut data = vec![0u8; w * h * 4];

        // Slowly cycle through hues
        let hue = (t * 20.0) % 360.0;
        let (r, g, b) = hsv_to_rgb(hue, 0.8, 0.9);

        for y in 0..h {
            for x in 0..w {
                let offset = (y * w + x) * 4;
                data[offset] = r;
                data[offset + 1] = g;
                data[offset + 2] = b;
                data[offset + 3] = 255;
            }
        }

        data
    }
}

impl InputBackend for TestPatternBackend {
    fn protocol_name(&self) -> &str {
        "test"
    }

    fn list_sources(&self) -> Vec<SourceInfo> {
        let w = Some(self.width);
        let h = Some(self.height);
        vec![
            SourceInfo {
                id: "test:color_bars".to_string(),
                name: "Test: Color Bars".to_string(),
                protocol: "test".to_string(),
                width: w,
                height: h,
                fps: Some(30.0),
            },
            SourceInfo {
                id: "test:gradient".to_string(),
                name: "Test: Gradient Sweep".to_string(),
                protocol: "test".to_string(),
                width: w,
                height: h,
                fps: Some(30.0),
            },
            SourceInfo {
                id: "test:checkerboard".to_string(),
                name: "Test: Checkerboard".to_string(),
                protocol: "test".to_string(),
                width: w,
                height: h,
                fps: Some(30.0),
            },
            SourceInfo {
                id: "test:solid".to_string(),
                name: "Test: Solid Color Cycle".to_string(),
                protocol: "test".to_string(),
                width: w,
                height: h,
                fps: Some(30.0),
            },
        ]
    }

    fn connect(&mut self, source_id: &str) -> Result<(), InputError> {
        if !VALID_SOURCES.contains(&source_id) {
            return Err(InputError::SourceNotFound(source_id.to_string()));
        }

        let was_empty = self.active_sources.is_empty();
        self.active_sources.insert(source_id.to_string());

        // Only reset the timer when the very first source connects,
        // NOT when additional sources are added (that would reset ALL animations)
        if was_empty {
            self.start_time = Instant::now();
        }

        log::info!(
            "Test pattern connected: {} (active: {})",
            source_id,
            self.active_sources.len()
        );
        Ok(())
    }

    fn disconnect(&mut self) {
        self.active_sources.clear();
        log::info!("Test pattern: all sources disconnected");
    }

    /// Disconnect a specific source (called by InputManager when a layer unbinds)
    fn disconnect_source(&mut self, source_id: &str) {
        self.active_sources.remove(source_id);
        log::info!(
            "Test pattern disconnected: {} (active: {})",
            source_id,
            self.active_sources.len()
        );
    }

    fn poll_frame(&mut self) -> Option<FramePacket> {
        // For trait compatibility: generate frame for the first active source
        let first = self.active_sources.iter().next()?.clone();
        self.generate_frame_for_source(&first)
    }

    /// Generate frame for a specific source — the key method for multi-source support
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
        // For trait compatibility: this isn't meaningful for multi-source backends
        None
    }

    fn is_source_active(&self, source_id: &str) -> bool {
        self.active_sources.contains(source_id)
    }
}

/// Simple HSV to RGB conversion
fn hsv_to_rgb(h: f32, s: f32, v: f32) -> (u8, u8, u8) {
    let c = v * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = v - c;

    let (r1, g1, b1) = match (h as u32) / 60 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };

    (
        ((r1 + m) * 255.0) as u8,
        ((g1 + m) * 255.0) as u8,
        ((b1 + m) * 255.0) as u8,
    )
}
