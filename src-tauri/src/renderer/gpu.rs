use std::sync::Arc;
use serde::{Deserialize, Serialize};

/// Frame pacing modes for projector output
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FramePacingMode {
    /// VSync — smooth, no tearing (default for shows)
    Show,
    /// Mailbox — tear-free but skips old frames (lower latency)
    LowLatency,
    /// Immediate — uncapped FPS, may tear (for benchmarking)
    Benchmark,
}

impl FramePacingMode {
    pub fn to_present_mode(self) -> wgpu::PresentMode {
        match self {
            FramePacingMode::Show => wgpu::PresentMode::Fifo,
            FramePacingMode::LowLatency => wgpu::PresentMode::Mailbox,
            FramePacingMode::Benchmark => wgpu::PresentMode::Immediate,
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            FramePacingMode::Show => "Show (VSync)",
            FramePacingMode::LowLatency => "Low Latency (Mailbox)",
            FramePacingMode::Benchmark => "Benchmark (Immediate)",
        }
    }
}

impl Default for FramePacingMode {
    fn default() -> Self {
        FramePacingMode::Show
    }
}

/// GPU context holding wgpu device/queue/adapter — shared across the app
pub struct GpuContext {
    pub instance: wgpu::Instance,
    pub adapter: wgpu::Adapter,
    pub device: Arc<wgpu::Device>,
    pub queue: Arc<wgpu::Queue>,
}

impl GpuContext {
    /// Initialize wgpu with best available backend
    pub async fn new() -> Result<Self, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::all(),
            ..Default::default()
        });

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .map_err(|e| format!("Failed to find a suitable GPU adapter: {}", e))?;

        log::info!("GPU adapter: {:?}", adapter.get_info());

        let (device, queue) = adapter
            .request_device(
                &wgpu::DeviceDescriptor {
                    label: Some("FlexMap GPU Device"),
                    required_features: wgpu::Features::empty(),
                    required_limits: wgpu::Limits {
                        max_texture_dimension_2d: 8192,
                        ..wgpu::Limits::downlevel_defaults()
                    },
                    memory_hints: wgpu::MemoryHints::Performance,
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| format!("Failed to create GPU device: {}", e))?;

        // Forward uncaptured GPU errors to log instead of panicking
        device.on_uncaptured_error(Box::new(|error| {
            log::error!("[wgpu] {error}");
        }));

        // Log device-lost events (GPU hang, driver crash, hardware removal)
        device.set_device_lost_callback(|reason, message| {
            log::error!("[wgpu] Device lost ({reason:?}): {message}");
        });

        Ok(Self {
            instance,
            adapter,
            device: Arc::new(device),
            queue: Arc::new(queue),
        })
    }
}

/// Output surface state for the projector window
pub struct OutputSurface {
    pub surface: wgpu::Surface<'static>,
    pub config: wgpu::SurfaceConfiguration,
    pub width: u32,
    pub height: u32,
}

impl OutputSurface {
    pub fn new(
        surface: wgpu::Surface<'static>,
        adapter: &wgpu::Adapter,
        device: &wgpu::Device,
        width: u32,
        height: u32,
    ) -> Result<Self, String> {
        if width == 0 || height == 0 {
            return Err("Surface dimensions must be non-zero".into());
        }

        let mut config = surface
            .get_default_config(adapter, width, height)
            .ok_or("Surface not supported by adapter")?;

        // On Windows/DX12, get_default_config returns Bgra8UnormSrgb but the
        // engine's blit pipeline is compiled for Bgra8Unorm. Force them to match.
        #[cfg(windows)]
        {
            config.format = wgpu::TextureFormat::Bgra8Unorm;
        }

        log::info!("[projector] surface format: {:?}", config.format);

        config.present_mode = wgpu::PresentMode::Fifo; // VSync for projector
        config.desired_maximum_frame_latency = 2;

        surface.configure(device, &config);

        Ok(Self {
            surface,
            config,
            width,
            height,
        })
    }

    pub fn resize(&mut self, device: &wgpu::Device, width: u32, height: u32) {
        if width > 0 && height > 0 {
            self.width = width;
            self.height = height;
            self.config.width = width;
            self.config.height = height;
            self.surface.configure(device, &self.config);
        }
    }

    pub fn reconfigure(&self, device: &wgpu::Device) {
        self.surface.configure(device, &self.config);
    }

    /// Change the present mode (frame pacing).
    pub fn set_present_mode(&mut self, device: &wgpu::Device, mode: FramePacingMode) {
        let new_mode = mode.to_present_mode();
        if self.config.present_mode != new_mode {
            self.config.present_mode = new_mode;
            self.surface.configure(device, &self.config);
            log::info!("Projector present mode changed to {:?}", mode);
        }
    }
}
