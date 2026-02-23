pub mod commands;
pub mod input;
pub mod persistence;
pub mod renderer;
pub mod scene;

use std::sync::Arc;
use tauri::Manager;
use scene::state::SceneState;
use renderer::engine::RenderState;
use renderer::projector::GpuProjector;
use input::adapter::InputManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_millis()
        .init();

    log::info!("AuraMap starting...");

    let scene_state = SceneState::new();
    let render_state = Arc::new(RenderState::new());
    let input_manager = Arc::new(parking_lot::RwLock::new(InputManager::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // If a second instance tries to launch, just focus the existing main window
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(scene_state)
        .manage(render_state)
        .manage(input_manager)
        .manage(Arc::new(parking_lot::Mutex::new(sysinfo::System::new_all())))
        .manage(Arc::new(parking_lot::Mutex::new(GpuProjector::new())))
        .invoke_handler(tauri::generate_handler![
            // Projector window
            commands::open_projector_window,
            commands::close_projector_window,
            commands::retarget_projector,
            commands::list_monitors,
            // Layers
            commands::add_layer,
            commands::remove_layer,
            commands::duplicate_layer,
            commands::rename_layer,
            commands::set_layer_visibility,
            commands::set_layer_locked,
            commands::reorder_layers,
            commands::begin_interaction,
            commands::update_layer_geometry,
            commands::update_layer_properties,
            commands::set_layer_source,
            commands::set_layer_blend_mode,
            commands::get_layers,
            // Calibration
            commands::set_calibration_enabled,
            commands::set_calibration_pattern,
            // Persistence
            commands::save_project,
            commands::load_project,
            commands::new_project,
            commands::get_project,
            commands::is_dirty,
            commands::has_recovery,
            commands::load_recovery,
            // Syphon management
            commands::check_syphon_status,
            commands::install_syphon_framework,
            // Sources
            commands::list_sources,
            commands::refresh_sources,
            commands::add_media_file,
            commands::remove_media_file,
            commands::connect_source,
            commands::disconnect_source,
            commands::poll_layer_frame,
            commands::poll_all_frames,
            // Output
            commands::set_output_config,
            // Undo / Redo
            commands::undo,
            commands::redo,
            // Render
            commands::get_render_stats,
            // GPU projector
            commands::get_projector_stats,
            // System
            commands::get_system_stats,
        ])
        .setup(|app| {
            log::info!("AuraMap setup complete");

            // Initialize GPU context on a background thread
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                log::info!("Initializing GPU...");
                let gpu_result = pollster::block_on(renderer::gpu::GpuContext::new());
                match gpu_result {
                    Ok(gpu) => {
                        log::info!("GPU initialized: {}", gpu.adapter.get_info().name);
                        let engine = renderer::engine::RenderEngine::new(gpu, 1920, 1080);
                        app_handle.manage(Arc::new(parking_lot::RwLock::new(engine)));

                        // Sync initial scene to render state
                        let render_state = app_handle.state::<Arc<RenderState>>();
                        let scene_state = app_handle.state::<SceneState>();
                        let layers = scene_state.get_layers_snapshot();
                        let project = scene_state.get_project_snapshot();
                        render_state.update_layers(layers);
                        render_state.update_calibration(project.calibration);

                        log::info!("Render engine ready");
                    }
                    Err(e) => {
                        log::error!("GPU initialization failed: {}. Rendering disabled.", e);
                    }
                }
            });

            // Check for crash recovery
            let _state = app.state::<SceneState>();
            if persistence::has_recovery(None) {
                log::info!("Autosave recovery file detected");
            }

            // Start frame pump thread — polls input sources and uploads to GPU textures
            let app_handle_pump = app.handle().clone();
            std::thread::spawn(move || {
                log::info!("Frame pump thread started");
                let frame_interval = std::time::Duration::from_millis(33); // ~30fps
                let mut log_counter = 0u64;
                let mut reconnect_timer = std::time::Instant::now();
                let reconnect_interval = std::time::Duration::from_secs(3);

                loop {
                    let start = std::time::Instant::now();

                    // Rate-limited auto-reconnect for stale sources (~every 3s)
                    if reconnect_timer.elapsed() >= reconnect_interval {
                        reconnect_timer = std::time::Instant::now();
                        let input_mgr = app_handle_pump.state::<Arc<parking_lot::RwLock<InputManager>>>();
                        let recovered = input_mgr.write().try_reconnect_stale();
                        if !recovered.is_empty() {
                            log::info!("Auto-reconnected {} source(s): {:?}", recovered.len(), recovered);
                        }
                    }

                    let input_mgr = app_handle_pump.state::<Arc<parking_lot::RwLock<InputManager>>>();
                    let render_state = app_handle_pump.state::<Arc<RenderState>>();
                    let bound_ids = input_mgr.read().bound_layer_ids();

                    if !bound_ids.is_empty() {
                        let engine_state = app_handle_pump
                            .try_state::<Arc<parking_lot::RwLock<renderer::engine::RenderEngine>>>();

                        if let Some(engine_lock) = engine_state {
                            // PHASE 1: Poll frames from input sources (hold input lock only)
                            // This is separate from texture upload to avoid holding both locks
                            // simultaneously, which causes a deadlock chain:
                            //   GPU projector: holds engine.read()
                            //   Frame pump: holds input.write(), waits for engine.write()
                            //   poll_all_frames: waits for input.write()
                            let mut polled_frames: Vec<(String, crate::input::adapter::FramePacket)> = Vec::new();
                            {
                                let mut input = input_mgr.write();
                                for layer_id in &bound_ids {
                                    if let Some(frame) = input.poll_frame_for_layer(layer_id) {
                                        polled_frames.push((layer_id.clone(), frame));
                                    }
                                }
                                // Input lock released here
                            }

                            // PHASE 2: Upload polled frames to GPU textures (hold engine lock only)
                            if !polled_frames.is_empty() {
                                let mut engine = engine_lock.write();

                                let renderer::engine::RenderEngine {
                                    ref gpu,
                                    ref mut texture_manager,
                                    ..
                                } = *engine;

                                for (layer_id, frame) in &polled_frames {
                                    texture_manager.upload_frame(
                                        &gpu.device,
                                        &gpu.queue,
                                        layer_id,
                                        frame,
                                    );
                                }
                                // Engine lock released here

                                render_state.request_redraw();
                            }

                            // Log every ~5 seconds (150 ticks at 30fps)
                            log_counter += 1;
                            if log_counter % 150 == 0 {
                                let pump_ms = start.elapsed().as_secs_f64() * 1000.0;
                                log::debug!(
                                    "Frame pump: {} layers bound, {} uploaded, {:.1}ms",
                                    bound_ids.len(),
                                    polled_frames.len(),
                                    pump_ms
                                );
                            }
                        }
                    }

                    let elapsed = start.elapsed();
                    if elapsed < frame_interval {
                        std::thread::sleep(frame_interval - elapsed);
                    }
                }
            });

            // Start autosave timer
            let app_handle2 = app.handle().clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Runtime::new().unwrap();
                rt.block_on(async {
                    let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(60));
                    loop {
                        interval.tick().await;
                        let state = app_handle2.state::<SceneState>();
                        if state.is_dirty() {
                            let project = state.get_project_snapshot();
                            let path: Option<String> = state.project_path.read().clone();
                            if let Err(e) = persistence::autosave(
                                &project,
                                path.as_deref().map(std::path::Path::new),
                            ) {
                                log::error!("Autosave failed: {}", e);
                            }
                        }
                    }
                });
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running AuraMap");
}
