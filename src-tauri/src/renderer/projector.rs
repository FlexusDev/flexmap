//! Native GPU projector — renders composited scene directly to a wgpu surface,
//! bypassing the webview/IPC/Canvas2D pipeline entirely.
//!
//! Architecture:
//!   1. A Tauri window is created and we obtain the raw window handle
//!   2. We create a wgpu::Surface on the main thread (required by Metal)
//!   3. A dedicated render thread composites layers at display refresh rate
//!   4. The frame pump thread uploads source frames to GPU textures (already exists)
//!   5. The engine read lock is held ONLY during command encoding (< 1ms),
//!      NOT during VSync wait or present — so the frame pump can upload textures
//!
//! This removes the entire base64 → IPC → JS → Canvas2D bottleneck for projector output.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use parking_lot::RwLock;

use super::engine::{RenderEngine, RenderState};
use super::gpu::{FramePacingMode, OutputSurface};

/// Shared state for the GPU projector render loop
pub struct GpuProjector {
    pub running: Arc<AtomicBool>,
    pub stop_signal: Arc<AtomicBool>,
    pub current_fps: Arc<AtomicU64>,
    pub current_frametime_us: Arc<AtomicU64>,
    pub thread_handle: Option<std::thread::JoinHandle<()>>,
}

impl GpuProjector {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            stop_signal: Arc::new(AtomicBool::new(false)),
            current_fps: Arc::new(AtomicU64::new(0)),
            current_frametime_us: Arc::new(AtomicU64::new(0)),
            thread_handle: None,
        }
    }

    /// Start the GPU render loop for the given surface.
    pub fn start(
        &mut self,
        surface: wgpu::Surface<'static>,
        adapter: &wgpu::Adapter,
        device: Arc<wgpu::Device>,
        _queue: Arc<wgpu::Queue>,
        engine: Arc<RwLock<RenderEngine>>,
        render_state: Arc<RenderState>,
        initial_width: u32,
        initial_height: u32,
    ) -> Result<(), String> {
        if self.running.load(Ordering::SeqCst) {
            return Err("Projector render loop already running".into());
        }

        // Configure the surface on the main thread (we're called from run_on_main_thread)
        let output_surface = OutputSurface::new(
            surface,
            adapter,
            &device,
            initial_width,
            initial_height,
        )?;

        self.stop_signal.store(false, Ordering::SeqCst);
        self.running.store(true, Ordering::SeqCst);

        let running = self.running.clone();
        let stop_signal = self.stop_signal.clone();
        let fps_counter = self.current_fps.clone();
        let frametime_counter = self.current_frametime_us.clone();

        let thread = std::thread::Builder::new()
            .name("gpu-projector".into())
            .spawn(move || {
                log::info!("GPU projector render loop started ({}x{})", initial_width, initial_height);

                let mut surface = output_surface;
                let mut frame_count = 0u64;
                let mut fps_timer = std::time::Instant::now();
                let target_interval = std::time::Duration::from_micros(16_667); // ~60fps cap
                let mut current_pacing = FramePacingMode::Show;
                let mut last_prepared_generation: u64 = u64::MAX; // Force first prepare

                loop {
                    if stop_signal.load(Ordering::SeqCst) {
                        break;
                    }

                    let frame_start = std::time::Instant::now();

                    // Snapshot scene state (cheap clones behind RwLock)
                    let layers = render_state.layers.read().clone();
                    let calibration = render_state.calibration.read().clone();
                    let bpm_phase = *render_state.bpm_phase.read();
                    let bpm_multiplier = *render_state.bpm_multiplier.read();

                    // Check if output size changed
                    let out_w = *render_state.output_width.read();
                    let out_h = *render_state.output_height.read();
                    if out_w != surface.width || out_h != surface.height {
                        surface.resize(&device, out_w, out_h);
                        log::info!("GPU projector resized to {}x{}", out_w, out_h);
                    }

                    // Check if frame pacing mode changed
                    let new_pacing = *render_state.frame_pacing.read();
                    if new_pacing != current_pacing {
                        surface.set_present_mode(&device, new_pacing);
                        current_pacing = new_pacing;
                    }

                    // Acquire the next surface texture.
                    // With Fifo present mode this may block waiting for VSync.
                    // We do NOT hold the engine lock here — so the frame pump
                    // thread can upload textures while we wait.
                    let t_surface = std::time::Instant::now();
                    let surface_texture = match surface.surface.get_current_texture() {
                        Ok(t) => t,
                        Err(wgpu::SurfaceError::Lost | wgpu::SurfaceError::Outdated) => {
                            surface.reconfigure(&device);
                            log::warn!("GPU projector surface reconfigured");
                            continue;
                        }
                        Err(e) => {
                            log::error!("GPU projector surface error: {}", e);
                            std::thread::sleep(std::time::Duration::from_millis(16));
                            continue;
                        }
                    };
                    let surface_ms = t_surface.elapsed().as_secs_f64() * 1000.0;
                    let target_view = surface_texture.texture
                        .create_view(&wgpu::TextureViewDescriptor::default());

                    // Hold the engine read lock ONLY for command encoding.
                    // This is fast (< 1ms) — just building GPU command buffers.
                    // The frame pump thread needs a write lock to upload textures,
                    // so we release this as quickly as possible.
                    let t_prepare = std::time::Instant::now();
                    let prepare_ms;
                    let render_ms;
                    {
                        let eng = engine.read();

                        // Check if offscreen needs resize to match projector surface
                        let needs_resize = out_w != eng.offscreen_width || out_h != eng.offscreen_height;
                        drop(eng);

                        if needs_resize {
                            let mut eng = engine.write();
                            eng.resize_offscreen(out_w, out_h);
                            last_prepared_generation = u64::MAX; // Force re-prepare after resize
                            drop(eng);
                        }

                        // Pre-populate buffer cache only when layers/textures changed.
                        // This avoids taking an expensive write lock at 60fps when only
                        // the projector is rendering unchanged content.
                        let current_gen = render_state.layer_generation();
                        if current_gen != last_prepared_generation {
                            let mut eng = engine.write();
                            eng.prepare_all_buffers(&layers, bpm_phase, bpm_multiplier);
                            last_prepared_generation = current_gen;
                        }

                        let eng = engine.read();
                        prepare_ms = t_prepare.elapsed().as_secs_f64() * 1000.0;

                        // Use full multi-pass compositing (supports all 13 blend modes)
                        let t_render = std::time::Instant::now();
                        let scene_cmd = eng.render_scene(&layers, &calibration, bpm_phase, bpm_multiplier);

                        // Blit offscreen → surface
                        let mut blit_encoder = eng.gpu.device.create_command_encoder(
                            &wgpu::CommandEncoderDescriptor {
                                label: Some("Projector Blit Encoder"),
                            },
                        );
                        eng.blit_to_view(&mut blit_encoder, &target_view);

                        eng.gpu.queue.submit([scene_cmd, blit_encoder.finish()]);
                        render_ms = t_render.elapsed().as_secs_f64() * 1000.0;
                        // Engine lock released here
                    };

                    // Present doesn't need any lock
                    let t_present = std::time::Instant::now();
                    surface_texture.present();
                    let present_ms = t_present.elapsed().as_secs_f64() * 1000.0;

                    // Log frametime breakdown when frametime exceeds 20ms (stutter detection)
                    let total_frame_ms = frame_start.elapsed().as_secs_f64() * 1000.0;
                    if total_frame_ms > 20.0 {
                        log::warn!(
                            "GPU projector stutter: {:.1}ms total — surface={:.1}ms prepare={:.1}ms render={:.1}ms present={:.1}ms",
                            total_frame_ms,
                            surface_ms,
                            prepare_ms,
                            render_ms,
                            present_ms
                        );
                    }

                    // Track FPS
                    frame_count += 1;
                    let frame_elapsed = frame_start.elapsed();
                    frametime_counter.store(frame_elapsed.as_micros() as u64, Ordering::Relaxed);

                    let fps_elapsed = fps_timer.elapsed();
                    if fps_elapsed >= std::time::Duration::from_secs(1) {
                        let fps = (frame_count as f64 / fps_elapsed.as_secs_f64()) as u64;
                        fps_counter.store(fps, Ordering::Relaxed);
                        frame_count = 0;
                        fps_timer = std::time::Instant::now();
                        log::debug!("GPU projector: {} fps, {:.1}ms frametime, {} layers",
                            fps, frame_elapsed.as_secs_f64() * 1000.0, layers.len());
                    }

                    // Rate limit if faster than target — skip in Benchmark mode
                    if current_pacing != FramePacingMode::Benchmark
                        && frame_elapsed < target_interval
                    {
                        std::thread::sleep(target_interval - frame_elapsed);
                    }
                }

                log::info!("GPU projector render loop stopped");
                running.store(false, Ordering::SeqCst);
            })
            .map_err(|e| format!("Failed to spawn projector thread: {}", e))?;

        self.thread_handle = Some(thread);
        Ok(())
    }

    pub fn stop(&mut self) {
        if !self.running.load(Ordering::SeqCst) {
            return;
        }

        log::info!("Stopping GPU projector render loop...");
        self.stop_signal.store(true, Ordering::SeqCst);

        if let Some(handle) = self.thread_handle.take() {
            let _ = handle.join();
        }

        self.running.store(false, Ordering::SeqCst);
        self.current_fps.store(0, Ordering::Relaxed);
        self.current_frametime_us.store(0, Ordering::Relaxed);
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn fps(&self) -> u64 {
        self.current_fps.load(Ordering::Relaxed)
    }

    pub fn frametime_ms(&self) -> f64 {
        self.current_frametime_us.load(Ordering::Relaxed) as f64 / 1000.0
    }
}

impl Default for GpuProjector {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for GpuProjector {
    fn drop(&mut self) {
        self.stop();
    }
}
