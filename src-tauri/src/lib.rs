pub mod commands;
pub mod audio;
pub mod input;
pub mod persistence;
pub mod renderer;
pub mod scene;

/// macOS-only: hooks WebKit's private console delegate method so native engine
/// warnings (e.g. "too many WebGL contexts") appear in the cargo tauri dev terminal.
/// Uses raw ObjC runtime FFI — no extra crate deps required on macOS.
#[cfg(target_os = "macos")]
mod webkit_console {
    use std::ffi::{c_char, c_void, CStr};

    pub type Id = *mut c_void;
    type Sel = *const c_void;
    type Class = *mut c_void;

    extern "C" {
        fn sel_registerName(str: *const c_char) -> Sel;
        fn object_getClass(obj: Id) -> Class;
        fn class_addMethod(
            cls: Class,
            name: Sel,
            imp: unsafe extern "C" fn(),
            types: *const c_char,
        ) -> bool;
        fn objc_msgSend(recv: Id, sel: Sel, ...) -> Id;
    }

    /// Send a message that returns an `id` (pointer).
    #[inline]
    unsafe fn msg_id(recv: Id, sel: Sel) -> Id {
        let f: unsafe extern "C" fn(Id, Sel) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
        f(recv, sel)
    }

    /// Send a message that returns a C string (e.g. `UTF8String`).
    #[inline]
    unsafe fn msg_cstr(recv: Id, sel: Sel) -> *const c_char {
        let f: unsafe extern "C" fn(Id, Sel) -> *const c_char =
            std::mem::transmute(objc_msgSend as *const c_void);
        f(recv, sel)
    }

    /// Send a message that returns a `usize` (e.g. `NSUInteger` level).
    #[inline]
    unsafe fn msg_usize(recv: Id, sel: Sel) -> usize {
        let f: unsafe extern "C" fn(Id, Sel) -> usize =
            std::mem::transmute(objc_msgSend as *const c_void);
        f(recv, sel)
    }

    /// Method implementation added to the WKWebView UI delegate.
    /// WebKit calls `-_webView:didReceiveConsoleLogForTesting:` for every console message.
    /// (Private Apple SPI — the "ForTesting" suffix is the actual selector name, not test-only.)
    unsafe extern "C" fn console_log_imp(
        _self: Id,
        _cmd: Sel,
        _webview: Id,
        message: Id, // WKConsoleMessage *
    ) {
        let sel_message = sel_registerName(c"message".as_ptr());
        let sel_level = sel_registerName(c"level".as_ptr());
        let sel_utf8 = sel_registerName(c"UTF8String".as_ptr());

        let ns_string = msg_id(message, sel_message);
        let level: usize = msg_usize(message, sel_level);
        let utf8_ptr = msg_cstr(ns_string, sel_utf8);

        if !utf8_ptr.is_null() {
            let s = CStr::from_ptr(utf8_ptr).to_string_lossy();
            // WKConsoleMessageLevel: Log=0, Warning=1, Error=2, Debug=3, Info=4
            match level {
                2 => log::error!(target: "webview_native", "[console] {s}"),
                1 => log::warn!(target: "webview_native", "[console] {s}"),
                _ => log::info!(target: "webview_native", "[console] {s}"),
            }
        }
    }

    /// Install the console hook onto the WKWebView's UIDelegate class.
    /// `webview_id` must be a valid `WKWebView *`.
    pub unsafe fn install(webview_id: Id) {
        let sel_ui_delegate = sel_registerName(c"UIDelegate".as_ptr());
        let delegate = msg_id(webview_id, sel_ui_delegate);
        if delegate.is_null() {
            log::warn!("[webview_native] UIDelegate is nil — console hook not installed");
            return;
        }

        let cls = object_getClass(delegate);
        let sel = sel_registerName(c"_webView:didReceiveConsoleLogForTesting:".as_ptr());
        let added = class_addMethod(
            cls,
            sel,
            std::mem::transmute::<
                unsafe extern "C" fn(Id, Sel, Id, Id),
                unsafe extern "C" fn(),
            >(console_log_imp),
            c"v@:@@".as_ptr(),
        );

        if added {
            log::info!("[webview_native] WebKit console hook installed");
        } else {
            log::warn!("[webview_native] WebKit console hook: method already registered or failed");
        }
    }
}

/// Windows: hooks WebView2 console events via Chrome DevTools Protocol so native
/// engine warnings (e.g. "too many WebGL contexts") appear in the cargo tauri dev terminal.
#[cfg(windows)]
mod webview2_cdp {
    use webview2_com::{
        CallDevToolsProtocolMethodCompletedHandler,
        DevToolsProtocolEventReceivedEventHandler,
        Microsoft::Web::WebView2::Win32::ICoreWebView2,
    };
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::System::Com::CoTaskMemFree;

    /// Subscribe to one CDP event, forwarding output to the log.
    unsafe fn subscribe(webview: &ICoreWebView2, event_name: &str) {
        let ev: Vec<u16> = event_name.encode_utf16().chain(Some(0)).collect();
        let receiver = match webview.GetDevToolsProtocolEventReceiver(PCWSTR::from_raw(ev.as_ptr())) {
            Ok(r) => r,
            Err(e) => {
                log::warn!("[webview_native] CDP receiver failed for {event_name}: {e:?}");
                return;
            }
        };

        let en = event_name.to_string();
        let handler = DevToolsProtocolEventReceivedEventHandler::create(Box::new(
            move |_sender, args| {
                if let Some(args) = args {
                    unsafe {
                        let mut json = PWSTR::null();
                        args.ParameterObjectAsJson(&mut json)?;
                        if !json.is_null() {
                            if let Ok(s) = json.to_string() {
                                log::warn!(target: "webview_native", "[cdp/{en}] {s}");
                            }
                            CoTaskMemFree(Some(json.as_ptr() as *const _));
                        }
                    }
                }
                Ok(())
            },
        ));

        let mut token: i64 = 0;
        if let Err(e) = receiver.add_DevToolsProtocolEventReceived(&handler, &mut token) {
            log::warn!("[webview_native] CDP subscribe failed for {event_name}: {e:?}");
        }
    }

    /// Enable CDP domains and subscribe to all console-related events.
    pub unsafe fn install(webview: &ICoreWebView2) {
        // Enable Runtime and Log CDP domains (fire-and-forget no-op completion)
        for domain in ["Runtime.enable", "Log.enable"] {
            let m: Vec<u16> = domain.encode_utf16().chain(Some(0)).collect();
            let p: Vec<u16> = "{}".encode_utf16().chain(Some(0)).collect();
            let handler = CallDevToolsProtocolMethodCompletedHandler::create(
                Box::new(|_result, _json| Ok(())),
            );
            let _ = webview.CallDevToolsProtocolMethod(
                PCWSTR::from_raw(m.as_ptr()),
                PCWSTR::from_raw(p.as_ptr()),
                &handler,
            );
        }

        subscribe(webview, "Runtime.consoleAPICalled");
        subscribe(webview, "Log.entryAdded");
        subscribe(webview, "Runtime.exceptionThrown");

        log::info!("[webview_native] WebView2 CDP console hooks installed");
    }
}

use std::sync::Arc;
use tauri::{Emitter, Manager};
use scene::state::SceneState;
use renderer::engine::RenderState;
use renderer::projector::GpuProjector;
use input::adapter::InputManager;
use audio::BpmEngine;
use commands::{PreviewCache, CompositedPreviewCache};

fn build_app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

    let file_new = MenuItem::with_id(app, "app.new", "New Project", true, Some("CmdOrCtrl+N"))?;
    let file_open = MenuItem::with_id(app, "app.open", "Open Project...", true, Some("CmdOrCtrl+O"))?;
    let file_save = MenuItem::with_id(app, "app.save", "Save", true, Some("CmdOrCtrl+S"))?;
    let file_save_as = MenuItem::with_id(app, "app.save_as", "Save As...", true, Some("CmdOrCtrl+Shift+S"))?;
    let file_sep_1 = PredefinedMenuItem::separator(app)?;
    let file_sep_2 = PredefinedMenuItem::separator(app)?;
    let file_close = PredefinedMenuItem::close_window(app, None)?;
    let file_submenu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &file_new,
            &file_open,
            &file_sep_1,
            &file_save,
            &file_save_as,
            &file_sep_2,
            &file_close,
        ],
    )?;

    let edit_undo = MenuItem::with_id(app, "app.undo", "Undo", true, Some("CmdOrCtrl+Z"))?;
    let edit_redo = MenuItem::with_id(app, "app.redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?;
    let edit_duplicate = MenuItem::with_id(app, "app.duplicate", "Duplicate", true, Some("CmdOrCtrl+D"))?;
    let edit_sep_1 = PredefinedMenuItem::separator(app)?;
    let edit_sep_2 = PredefinedMenuItem::separator(app)?;
    let edit_cut = PredefinedMenuItem::cut(app, None)?;
    let edit_copy = PredefinedMenuItem::copy(app, None)?;
    let edit_paste = PredefinedMenuItem::paste(app, None)?;
    let edit_select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit_submenu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &edit_undo,
            &edit_redo,
            &edit_sep_1,
            &edit_duplicate,
            &edit_sep_2,
            &edit_cut,
            &edit_copy,
            &edit_paste,
            &edit_select_all,
        ],
    )?;

    let view_projector =
        MenuItem::with_id(app, "app.toggle_projector", "Toggle Projector", true, Some("CmdOrCtrl+P"))?;
    let view_submenu = Submenu::with_items(app, "View", true, &[&view_projector])?;

    #[cfg(target_os = "macos")]
    let app_submenu = {
        let app_name = app.package_info().name.clone();
        let app_about = PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?;
        let app_services = PredefinedMenuItem::services(app, None)?;
        let app_hide = PredefinedMenuItem::hide(app, None)?;
        let app_hide_others = PredefinedMenuItem::hide_others(app, None)?;
        let app_quit = PredefinedMenuItem::quit(app, None)?;
        let app_sep_1 = PredefinedMenuItem::separator(app)?;
        let app_sep_2 = PredefinedMenuItem::separator(app)?;
        let app_sep_3 = PredefinedMenuItem::separator(app)?;

        Submenu::with_items(
            app,
            app_name,
            true,
            &[
                &app_about,
                &app_sep_1,
                &app_services,
                &app_sep_2,
                &app_hide,
                &app_hide_others,
                &app_sep_3,
                &app_quit,
            ],
        )?
    };

    #[cfg(target_os = "macos")]
    return Menu::with_items(app, &[&app_submenu, &file_submenu, &edit_submenu, &view_submenu]);

    #[cfg(not(target_os = "macos"))]
    return Menu::with_items(app, &[&file_submenu, &edit_submenu, &view_submenu]);
}

fn menu_shortcut_action(id: &str) -> Option<&'static str> {
    match id {
        "app.undo" => Some("undo"),
        "app.redo" => Some("redo"),
        "app.new" => Some("new"),
        "app.open" => Some("open"),
        "app.save" => Some("save"),
        "app.save_as" => Some("save_as"),
        "app.duplicate" => Some("duplicate"),
        "app.toggle_projector" => Some("toggle_projector"),
        _ => None,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    log::info!("FlexMap starting...");

    let scene_state = SceneState::new();
    let render_state = Arc::new(RenderState::new());
    let input_manager = Arc::new(parking_lot::RwLock::new(InputManager::new()));

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                // Clear default targets (Stdout + LogDir) to avoid duplicate lines
                // in the terminal — we add only Stderr explicitly below.
                .clear_targets()
                // Write all logs (backend + frontend-forwarded) to stderr so they
                // appear in the `cargo tauri dev` terminal.
                .target(tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stderr))
                // Forward Rust backend logs to the browser devtools via log://log
                // events. The filter excludes frontend-originated records (target
                // starts with "webview:") so they don't echo back to the browser.
                .target(
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Webview)
                        .filter(|metadata| {
                            !metadata.target().starts_with(tauri_plugin_log::WEBVIEW_TARGET)
                        }),
                )
                .level(log::LevelFilter::Info)
                .level_for("flexmap_lib::input::adapter", log::LevelFilter::Warn)
                .level_for("flexmap_lib::input::syphon", log::LevelFilter::Warn)
                .level_for("flexmap_lib::input::test_pattern", log::LevelFilter::Warn)
                .level_for("flexmap_lib::input::shader", log::LevelFilter::Warn)
                .level_for("flexmap_lib::renderer::projector", log::LevelFilter::Warn)
                .level_for("flexmap_lib::commands", log::LevelFilter::Warn)
                .build()
        )
        .menu(|app| build_app_menu(app))
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            let action = menu_shortcut_action(id).or_else(|| {
                // Fallback for any platform-provided predefined ids.
                let lower = id.to_lowercase();
                if lower.contains("undo") {
                    Some("undo")
                } else if lower.contains("redo") {
                    Some("redo")
                } else if lower.contains("save") && lower.contains("as") {
                    Some("save_as")
                } else if lower == "save" || lower.ends_with(":save") {
                    Some("save")
                } else if lower.contains("open") {
                    Some("open")
                } else if lower.contains("new") {
                    Some("new")
                } else {
                    None
                }
            });

            if let Some(action) = action {
                let _ = app.emit("native-menu-shortcut", action);
            }
        })
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
        .manage(Arc::new(parking_lot::Mutex::new(BpmEngine::new())))
        .manage(Arc::new(PreviewCache::new()))
        .manage(Arc::new(CompositedPreviewCache::new()))
        .manage(Arc::new(parking_lot::Mutex::new(sysinfo::System::new_all())))
        .manage(Arc::new(parking_lot::Mutex::new(GpuProjector::new())))
        .invoke_handler(tauri::generate_handler![
            // Projector window
            commands::open_projector_window,
            commands::close_projector_window,
            commands::set_projector_fullscreen,
            commands::get_projector_fullscreen,
            commands::get_projector_window_state,
            commands::retarget_projector,
            commands::list_monitors,
            // Layers
            commands::add_layer,
            commands::remove_layer,
            commands::remove_layers,
            commands::duplicate_layer,
            commands::duplicate_layers,
            commands::rename_layer,
            commands::set_layer_visibility,
            commands::set_layer_locked,
            commands::reorder_layers,
            commands::begin_interaction,
            commands::update_layer_geometry,
            commands::update_layer_properties,
            commands::set_layer_source,
            commands::set_layer_input_transform,
            commands::apply_layer_geometry_transform_delta,
            commands::update_layer_point,
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
            commands::get_project_if_changed,
            commands::is_dirty,
            commands::has_recovery,
            commands::load_recovery,
            // Syphon management
            commands::check_syphon_status,
            commands::install_syphon_framework,
            // Sources
            commands::list_sources,
            commands::refresh_sources,
            commands::set_installed_shader_sources,
            commands::list_audio_input_devices,
            commands::set_audio_input_device,
            commands::set_bpm_config,
            commands::get_bpm_state,
            commands::tap_tempo,
            commands::add_media_file,
            commands::remove_media_file,
            commands::connect_source,
            commands::disconnect_source,
            commands::poll_layer_frame,
            commands::poll_all_frames,
            commands::poll_all_frames_delta,
            commands::set_preview_consumers,
            // Output
            commands::set_output_config,
            commands::set_project_ui_state,
            commands::set_main_window_fullscreen,
            commands::get_main_window_fullscreen,
            commands::sync_main_window_aspect,
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
            // Mesh operations
            commands::set_calibration_target,
            commands::subdivide_mesh,
            // Pixel mapping + Groups
            commands::set_layer_pixel_map,
            commands::create_layer_group,
            commands::delete_layer_group,
            commands::set_group_pixel_map,
            commands::set_group_shared_input,
            commands::get_groups,
            // BPM control
            commands::set_bpm_multiplier,
            commands::set_bpm_source,
            commands::tap_bpm,
            // GPU composited preview
            commands::set_preview_quality,
            commands::get_composited_preview,
        ])
        .setup(|app| {
            log::info!("FlexMap setup complete");

            // Main editor window is always resizable; aspect lock applies only to projector + preview.
            if let Some(main_window) = app.get_webview_window("main") {
                let _ = main_window.set_resizable(true);

                // Install native webview console hooks so engine-level messages
                // (e.g. "too many WebGL contexts") reach the cargo tauri dev terminal.
                #[cfg(target_os = "macos")]
                {
                    let _ = main_window.with_webview(|wv| {
                        unsafe {
                            webkit_console::install(wv.inner() as *mut _ as webkit_console::Id);
                        }
                    });
                }
                #[cfg(windows)]
                {
                    let _ = main_window.with_webview(|wv| {
                        unsafe {
                            if let Ok(webview) = wv.controller().CoreWebView2() {
                                webview2_cdp::install(&webview);
                            }
                        }
                    });
                }
            }

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
                        let project = scene_state.get_project_snapshot();
                        render_state.update_scene(project.layers.clone(), project.groups.clone());
                        render_state.update_calibration(project.calibration);

                        log::info!("Render engine ready");
                    }
                    Err(e) => {
                        log::error!("GPU initialization failed: {}. Rendering disabled.", e);
                    }
                }
            });

            // Check for crash recovery
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
                    let project_snapshot = app_handle_pump
                        .state::<SceneState>()
                        .get_project_snapshot();
                    let layer_snapshot = project_snapshot.layers.clone();
                    let group_snapshot = project_snapshot.groups.clone();
                    let bpm_snapshot = {
                        let bpm_engine = app_handle_pump.state::<Arc<parking_lot::Mutex<BpmEngine>>>();
                        let s = bpm_engine.lock().runtime_snapshot();
                        s
                    };

                    render_state.update_bpm(bpm_snapshot.phase, bpm_snapshot.multiplier);

                    let engine_state = app_handle_pump
                        .try_state::<Arc<parking_lot::RwLock<renderer::engine::RenderEngine>>>();

                    if let Some(engine_lock) = engine_state {
                        // PHASE 1: Collect source bindings and deduplicate by source_id.
                        // Multiple layers sharing the same source only need 1 poll per tick.
                        let mut source_to_layers: std::collections::HashMap<String, Vec<String>> =
                            std::collections::HashMap::new();
                        if !bound_ids.is_empty() {
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
                        // Keep all polled frames for binding/cache sync; track changed sequences
                        // separately for GPU upload optimization.
                        let t_poll = std::time::Instant::now();
                        let mut all_polled_source_frames: Vec<(
                            String,
                            Vec<String>,
                            crate::input::adapter::FramePacket,
                        )> = Vec::new();
                        {
                            if !source_to_layers.is_empty() {
                                if let Some(mut input) = input_mgr.try_write() {
                                    input.set_bpm_snapshot(bpm_snapshot);
                                    for layer in &layer_snapshot {
                                        input.set_layer_modulation(
                                            &layer.id,
                                            crate::input::adapter::LayerBeatModulation {
                                                beat_reactive: layer.properties.beat_reactive,
                                                beat_amount: layer.properties.beat_amount as f32,
                                            },
                                        );
                                    }
                                    for (source_id, layer_ids) in &source_to_layers {
                                        if let Some(first_layer) = layer_ids.first() {
                                            if let Some(frame) = input.poll_frame_for_layer(first_layer) {
                                                all_polled_source_frames.push((
                                                    source_id.clone(),
                                                    layer_ids.clone(),
                                                    frame,
                                                ));
                                            }
                                        }
                                    }
                                }
                            }
                            // Input lock released here (or was never taken)
                        }
                        let poll_ms = t_poll.elapsed().as_secs_f64() * 1000.0;

                        // Visibility: if sources are bound but no frames came back, log once
                        // per pump tick at INFO so it's visible in cmd.exe release runs.
                        if all_polled_source_frames.is_empty() && !source_to_layers.is_empty() {
                            log::info!(
                                "[frame-pump] poll returned no frames for {} source(s): {:?}",
                                source_to_layers.len(),
                                source_to_layers.keys().collect::<Vec<_>>()
                            );
                        }

                        let mut changed_source_ids: std::collections::HashSet<String> =
                            std::collections::HashSet::new();
                        for (source_id, _, frame) in &all_polled_source_frames {
                            let seq = frame.sequence.unwrap_or(0);
                            if seq == 0 {
                                changed_source_ids.insert(source_id.clone());
                                continue;
                            }
                            let prev = last_uploaded_sequence.get(source_id).copied().unwrap_or(0);
                            if seq != prev {
                                last_uploaded_sequence.insert(source_id.clone(), seq);
                                changed_source_ids.insert(source_id.clone());
                            }
                        }

                        // PHASE 3: Sync layer/source bindings for all polled sources.
                        // Upload only sequence-changed frames.
                        let t_upload = std::time::Instant::now();
                        let mut binding_changed = false;
                        {
                            let mut engine = engine_lock.write();

                            let renderer::engine::RenderEngine {
                                ref gpu,
                                ref mut texture_manager,
                                ..
                            } = *engine;

                            // Cleanup bindings for layers that are no longer source-bound.
                            let bound_id_set: std::collections::HashSet<&str> =
                                bound_ids.iter().map(|id| id.as_str()).collect();
                            for layer in &layer_snapshot {
                                if !bound_id_set.contains(layer.id.as_str())
                                    && texture_manager.get_source_for_layer(&layer.id).is_some()
                                {
                                    texture_manager.unbind_layer(&layer.id);
                                    binding_changed = true;
                                }
                            }

                            for (source_id, layer_ids, frame) in &all_polled_source_frames {
                                if changed_source_ids.contains(source_id) {
                                    texture_manager.upload_frame_for_source(
                                        &gpu.device,
                                        &gpu.queue,
                                        source_id,
                                        frame,
                                    );
                                }

                                for layer_id in layer_ids {
                                    let already_bound = texture_manager
                                        .get_source_for_layer(layer_id)
                                        .map(|current| current == source_id.as_str())
                                        .unwrap_or(false);
                                    if !already_bound {
                                        texture_manager.bind_layer_to_source(layer_id, source_id);
                                        binding_changed = true;
                                    }
                                }
                            }

                            if binding_changed {
                                texture_manager.remove_unused_sources();
                            }
                        }

                        if !changed_source_ids.is_empty() || binding_changed {
                            render_state.request_redraw();
                        }
                        let upload_ms = t_upload.elapsed().as_secs_f64() * 1000.0;

                        // PHASE 4: Generate preview snapshots for the editor.
                        // Always keep the cache warm when there are bound sources so frames
                        // are immediately available when a consumer registers.
                        let t_preview = std::time::Instant::now();
                        let preview_cache = app_handle_pump.state::<Arc<PreviewCache>>();
                        if !all_polled_source_frames.is_empty() {
                            let mut frames = preview_cache.frames.write();
                            let mut versions = preview_cache.frame_versions.write();
                            let mut removed_versions = preview_cache.removed_versions.write();

                            // Remove stale entries for layers no longer bound
                            let stale_ids: Vec<String> = frames
                                .keys()
                                .filter(|lid| !bound_ids.contains(lid))
                                .cloned()
                                .collect();
                            for layer_id in stale_ids {
                                frames.remove(&layer_id);
                                versions.remove(&layer_id);
                                let next = preview_cache
                                    .cursor
                                    .fetch_add(1, std::sync::atomic::Ordering::AcqRel)
                                    + 1;
                                removed_versions.insert(layer_id, next);
                            }

                            for (source_id, layer_ids, frame) in &all_polled_source_frames {
                                let source_changed = changed_source_ids.contains(source_id);
                                let has_missing_layer =
                                    layer_ids.iter().any(|layer_id| !frames.contains_key(layer_id));
                                if !source_changed && !has_missing_layer {
                                    continue;
                                }

                                let snapshot = Arc::new(commands::encode_frame(frame));
                                for layer_id in layer_ids {
                                    let next = preview_cache
                                        .cursor
                                        .fetch_add(1, std::sync::atomic::Ordering::AcqRel)
                                        + 1;
                                    frames.insert(layer_id.clone(), snapshot.clone());
                                    versions.insert(layer_id.clone(), next);
                                    removed_versions.remove(layer_id);
                                }
                            }
                        }
                        let preview_ms = t_preview.elapsed().as_secs_f64() * 1000.0;

                        // PHASE 5: GPU composited preview — render scene at preview
                        // resolution and cache for the editor canvas.
                        let t_composited = std::time::Instant::now();
                        {
                            let preview_quality = *render_state.preview_quality.read();
                            let out_w = *render_state.output_width.read();
                            let out_h = *render_state.output_height.read();
                            let pw = ((out_w as f32 * preview_quality) as u32).max(64);
                            let ph = ((out_h as f32 * preview_quality) as u32).max(64);

                            let bpm_phase = *render_state.bpm_phase.read();
                            let bpm_mult = *render_state.bpm_multiplier.read();
                            let calibration = render_state.calibration.read().clone();

                            let mut eng = engine_lock.write();
                            if eng.preview_width != pw || eng.preview_height != ph {
                                eng.resize_preview(pw, ph);
                            }
                            eng.prepare_all_buffers(&layer_snapshot, &group_snapshot, bpm_phase, bpm_mult);
                            let bpr = eng.render_preview(
                                &layer_snapshot,
                                &group_snapshot,
                                &calibration,
                                bpm_phase,
                                bpm_mult,
                            );
                            let pixels = eng.read_preview_pixels(bpr);
                            drop(eng);

                            // Encode and cache
                            use base64::Engine as _;
                            let b64 = base64::engine::general_purpose::STANDARD.encode(&pixels);
                            let snapshot = Arc::new(commands::FrameSnapshot {
                                width: pw,
                                height: ph,
                                data_b64: b64,
                            });
                            let composited_cache = app_handle_pump.state::<Arc<CompositedPreviewCache>>();
                            *composited_cache.frame.write() = Some(snapshot);
                            composited_cache.version.fetch_add(1, std::sync::atomic::Ordering::Release);
                        }
                        let composited_ms = t_composited.elapsed().as_secs_f64() * 1000.0;

                        // Debounced logging: every ~5 seconds (150 ticks at 30fps)
                        log_counter += 1;
                        if log_counter % 150 == 0 {
                            let total_ms = start.elapsed().as_secs_f64() * 1000.0;
                            log::debug!(
                                "Frame pump: {} layers, {} sources, poll={:.1}ms upload={:.1}ms preview={:.1}ms composited={:.1}ms total={:.1}ms",
                                bound_ids.len(),
                                source_to_layers.len(),
                                poll_ms,
                                upload_ms,
                                preview_ms,
                                composited_ms,
                                total_ms
                            );
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
        .expect("error while running FlexMap");
}
