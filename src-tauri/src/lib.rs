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
use commands::PreviewCache;

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
        .manage(Arc::new(PreviewCache::new()))
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
            // Diagnostics
            commands::get_source_diagnostics,
            commands::set_frame_pacing,
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
                let reconnect_interval = std::time::Duration::from_secs(10);
                let mut last_uploaded_sequence: std::collections::HashMap<String, u64> =
                    std::collections::HashMap::new();

                loop {
                    let start = std::time::Instant::now();

                    // Rate-limited auto-reconnect for stale sources (~every 10s).
                    // Uses a read-lock pre-check to avoid taking an expensive write lock
                    // when all sources are already connected.
                    if reconnect_timer.elapsed() >= reconnect_interval {
                        reconnect_timer = std::time::Instant::now();
                        let input_mgr = app_handle_pump.state::<Arc<parking_lot::RwLock<InputManager>>>();
                        let has_stale = input_mgr.read().has_stale_bindings();
                        if has_stale {
                            let recovered = input_mgr.write().try_reconnect_stale();
                            if !recovered.is_empty() {
                                log::info!("Auto-reconnected {} source(s): {:?}", recovered.len(), recovered);
                            }
                        }
                    }

                    let input_mgr = app_handle_pump.state::<Arc<parking_lot::RwLock<InputManager>>>();
                    let render_state = app_handle_pump.state::<Arc<RenderState>>();
                    let bound_ids = input_mgr.read().bound_layer_ids();

                    if !bound_ids.is_empty() {
                        let engine_state = app_handle_pump
                            .try_state::<Arc<parking_lot::RwLock<renderer::engine::RenderEngine>>>();

                        if let Some(engine_lock) = engine_state {
                            // PHASE 1: Collect source bindings and deduplicate by source_id.
                            // Multiple layers sharing the same source only need 1 poll + 1 upload.
                            let mut source_to_layers: std::collections::HashMap<String, Vec<String>> =
                                std::collections::HashMap::new();
                            {
                                let input = input_mgr.read();
                                for layer_id in &bound_ids {
                                    if let Some(source_id) = input.get_binding(layer_id) {
                                        source_to_layers
                                            .entry(source_id.to_string())
                                            .or_default()
                                            .push(layer_id.clone());
                                    }
                                }
                            }

                            // PHASE 2: Poll frames from unique sources (hold input lock only).
                            // Each unique source is polled once via any layer bound to it.
                            // Uses try_write() to avoid blocking behind auto-reconnect —
                            // if the lock is held, we skip this cycle and use cached frames.
                            let t_poll = std::time::Instant::now();
                            let mut polled_source_frames: Vec<(String, Vec<String>, crate::input::adapter::FramePacket)> = Vec::new();
                            {
                                if let Some(mut input) = input_mgr.try_write() {
                                    for (source_id, layer_ids) in &source_to_layers {
                                        if let Some(first_layer) = layer_ids.first() {
                                            if let Some(frame) = input.poll_frame_for_layer(first_layer) {
                                                polled_source_frames.push((
                                                    source_id.clone(),
                                                    layer_ids.clone(),
                                                    frame,
                                                ));
                                            }
                                        }
                                    }
                                }
                                // Input lock released here (or was never taken)
                            }
                            let poll_ms = t_poll.elapsed().as_secs_f64() * 1000.0;

                            // Filter out frames with unchanged sequence numbers.
                            // At 30fps pump with ~10fps Syphon, ~20 ticks return cached frames
                            // with the same sequence — skip the 8MB GPU upload + preview encode.
                            polled_source_frames.retain(|(source_id, _, frame)| {
                                let seq = frame.sequence.unwrap_or(0);
                                if seq == 0 {
                                    return true; // No sequence tracking — always upload
                                }
                                let prev = last_uploaded_sequence.get(source_id).copied().unwrap_or(0);
                                if seq == prev {
                                    return false; // Same frame — skip
                                }
                                last_uploaded_sequence.insert(source_id.clone(), seq);
                                true
                            });

                            // PHASE 3: Upload each unique source frame once and sync layer bindings.
                            let t_upload = std::time::Instant::now();
                            if !polled_source_frames.is_empty() {
                                let mut engine = engine_lock.write();

                                let renderer::engine::RenderEngine {
                                    ref gpu,
                                    ref mut texture_manager,
                                    ..
                                } = *engine;

                                for (source_id, layer_ids, frame) in &polled_source_frames {
                                    // Upload once per source
                                    texture_manager.upload_frame_for_source(
                                        &gpu.device,
                                        &gpu.queue,
                                        source_id,
                                        frame,
                                    );
                                    // Ensure all layers are bound to this source
                                    for layer_id in layer_ids {
                                        texture_manager.bind_layer_to_source(layer_id, source_id);
                                    }
                                }
                                // Engine lock released here

                                render_state.request_redraw();
                            }
                            let upload_ms = t_upload.elapsed().as_secs_f64() * 1000.0;

                            // PHASE 4: Generate preview snapshots for the editor.
                            // This runs on the frame pump thread so poll_all_frames (IPC)
                            // reads from cache instead of triggering a second Metal readback.
                            let t_preview = std::time::Instant::now();
                            if !polled_source_frames.is_empty() {
                                let preview_cache = app_handle_pump.state::<Arc<PreviewCache>>();
                                let mut cache = preview_cache.frames.write();
                                // Remove stale entries for layers no longer bound
                                cache.retain(|lid, _| bound_ids.contains(lid));
                                for (_source_id, layer_ids, frame) in &polled_source_frames {
                                    let snapshot = Arc::new(commands::encode_frame(frame));
                                    for layer_id in layer_ids {
                                        cache.insert(layer_id.clone(), snapshot.clone());
                                    }
                                }
                            }
                            let preview_ms = t_preview.elapsed().as_secs_f64() * 1000.0;

                            // Debounced logging: every ~5 seconds (150 ticks at 30fps)
                            log_counter += 1;
                            if log_counter % 150 == 0 {
                                let total_ms = start.elapsed().as_secs_f64() * 1000.0;
                                log::info!(
                                    "Frame pump: {} layers, {} sources, poll={:.1}ms upload={:.1}ms preview={:.1}ms total={:.1}ms",
                                    bound_ids.len(),
                                    source_to_layers.len(),
                                    poll_ms,
                                    upload_ms,
                                    preview_ms,
                                    total_ms
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
