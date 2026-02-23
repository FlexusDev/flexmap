//! Tauri IPC commands — control actions from the React UI to Rust backend

use std::sync::Arc;
use crate::scene::layer::*;
use crate::scene::project::*;
use crate::scene::state::SceneState;
use crate::persistence;
use crate::input::adapter::SourceInfo;
use crate::renderer::engine::RenderState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Manager, State, WebviewUrl, webview::WebviewWindowBuilder};
use tauri::window::WindowBuilder;
use crate::renderer::projector::GpuProjector;

/// Helper: after any scene mutation, sync layers + calibration to the render state
fn sync_render_state(scene: &SceneState, render: &Arc<RenderState>) {
    render.update_layers(scene.get_layers_snapshot());
    let project = scene.get_project_snapshot();
    render.update_calibration(project.calibration);
}

// =============================================================================
// Projector window commands
// =============================================================================

/// Open the projector window.
/// Attempts GPU-native rendering first (direct wgpu surface, zero IPC overhead).
/// Falls back to webview-based rendering if GPU surface creation fails.
#[tauri::command]
pub async fn open_projector_window(
    app: tauri::AppHandle,
    render: State<'_, Arc<RenderState>>,
) -> Result<(), String> {
    // Check if already running
    {
        let projector = app.state::<Arc<parking_lot::Mutex<GpuProjector>>>();
        if projector.lock().is_running() {
            log::info!("GPU projector already running");
            return Ok(());
        }
    }

    // Also check for existing webview projector (fallback path)
    if let Some(win) = app.get_webview_window("projector") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Try GPU-native path: create a native window and attach a wgpu surface
    let engine_state = app
        .try_state::<Arc<parking_lot::RwLock<crate::renderer::engine::RenderEngine>>>();

    if let Some(engine_lock) = engine_state {
        // Clone Arcs out of State wrappers so we can move them into closures
        let engine_arc: Arc<parking_lot::RwLock<crate::renderer::engine::RenderEngine>> =
            engine_lock.inner().clone();
        let render_state_arc = render.inner().clone();
        let app_handle = app.clone();

        // On macOS, Metal surface creation MUST happen on the main (UI) thread.
        // Use a oneshot channel to get the result back from the main thread.
        let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();

        app.run_on_main_thread(move || {
            let result = (|| -> Result<(), String> {
                // Create a BARE native window (no webview overlay).
                // A webview would sit on top of the wgpu surface and cover it.
                let win = WindowBuilder::new(&app_handle, "projector")
                    .decorations(true)
                    .fullscreen(false)
                    .visible(true)
                    .inner_size(960.0, 540.0)
                    .title("AuraMap Projector Output [GPU]")
                    .build()
                    .map_err(|e| format!("Window creation failed: {}", e))?;

                let size = win.inner_size().map_err(|e| format!("{}", e))?;
                let width = size.width.max(1);
                let height = size.height.max(1);

                // Create wgpu surface on the main thread (required by Metal)
                // SAFETY: The window is kept alive by Tauri's window manager
                // and the render loop is stopped before the window is destroyed.
                let surface = unsafe {
                    use raw_window_handle::{HasWindowHandle, HasDisplayHandle};
                    let raw_window = win.window_handle()
                        .map_err(|e| format!("Failed to get window handle: {}", e))?;
                    let raw_display = win.display_handle()
                        .map_err(|e| format!("Failed to get display handle: {}", e))?;
                    let target = wgpu::SurfaceTargetUnsafe::RawHandle {
                        raw_display_handle: raw_display.as_raw(),
                        raw_window_handle: raw_window.as_raw(),
                    };
                    let engine = engine_arc.read();
                    engine.gpu.instance
                        .create_surface_unsafe(target)
                        .map_err(|e| format!("Failed to create wgpu surface: {}", e))?
                };

                // Configure the surface and start the render loop (still on main thread)
                {
                    let engine = engine_arc.read();
                    let device = engine.gpu.device.clone();
                    let queue = engine.gpu.queue.clone();

                    let projector_state = app_handle.state::<Arc<parking_lot::Mutex<GpuProjector>>>();
                    let mut projector = projector_state.lock();
                    projector.start(
                        surface,
                        &engine.gpu.adapter,
                        device,
                        queue,
                        engine_arc.clone(),
                        render_state_arc,
                        width,
                        height,
                    )?;
                }

                // Listen for window resize / close events
                let resize_app = app_handle.clone();
                win.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::Resized(size) => {
                            let rs = resize_app.state::<Arc<RenderState>>();
                            *rs.output_width.write() = size.width.max(1);
                            *rs.output_height.write() = size.height.max(1);
                            rs.request_redraw();
                        }
                        tauri::WindowEvent::CloseRequested { .. } => {
                            let p = resize_app.state::<Arc<parking_lot::Mutex<GpuProjector>>>();
                            p.lock().stop();
                            log::info!("GPU projector stopped via window close");
                        }
                        tauri::WindowEvent::Destroyed => {
                            let p = resize_app.state::<Arc<parking_lot::Mutex<GpuProjector>>>();
                            p.lock().stop();
                        }
                        _ => {}
                    }
                });

                log::info!("GPU-native projector window opened ({}x{})", width, height);
                Ok(())
            })();

            let _ = tx.send(result);
        }).map_err(|e| format!("Failed to run on main thread: {}", e))?;

        // Wait for the main thread to finish
        return rx.await.map_err(|_| "Main thread channel dropped".to_string())?;
    }

    // Fallback: webview-based projector (GPU not ready yet)
    log::warn!("GPU not ready, falling back to webview projector");
    WebviewWindowBuilder::new(
        &app,
        "projector",
        WebviewUrl::App("index.html#/projector".into()),
    )
    .decorations(true)
    .fullscreen(false)
    .visible(true)
    .inner_size(960.0, 540.0)
    .title("AuraMap Projector Output")
    .build()
    .map_err(|e: tauri::Error| e.to_string())?;

    log::info!("Webview projector window opened (GPU fallback)");
    Ok(())
}

#[tauri::command]
pub async fn close_projector_window(app: tauri::AppHandle) -> Result<(), String> {
    // Stop the GPU render loop first
    {
        let projector = app.state::<Arc<parking_lot::Mutex<GpuProjector>>>();
        projector.lock().stop();
    }

    // Close the projector window.
    // Try bare native window (GPU path) first, then webview (fallback path).
    if let Some(win) = app.get_window("projector") {
        win.destroy().map_err(|e| e.to_string())?;
    } else if let Some(win) = app.get_webview_window("projector") {
        win.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn retarget_projector(
    _app: tauri::AppHandle,
    monitor_name: Option<String>,
    state: State<'_, SceneState>,
) -> Result<(), String> {
    state.set_monitor_preference(monitor_name);
    Ok(())
}

// =============================================================================
// Monitor detection
// =============================================================================

#[derive(Serialize)]
pub struct MonitorInfo {
    pub name: Option<String>,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub scale_factor: f64,
}

#[tauri::command]
pub async fn list_monitors(app: tauri::AppHandle) -> Result<Vec<MonitorInfo>, String> {
    let main_window = app
        .get_webview_window("main")
        .ok_or("Main window not found")?;

    let monitors = main_window
        .available_monitors()
        .map_err(|e| e.to_string())?;

    let infos: Vec<MonitorInfo> = monitors
        .iter()
        .map(|m| MonitorInfo {
            name: m.name().map(|n| n.to_string()),
            width: m.size().width,
            height: m.size().height,
            x: m.position().x,
            y: m.position().y,
            scale_factor: m.scale_factor(),
        })
        .collect();

    Ok(infos)
}

// =============================================================================
// Layer commands
// =============================================================================

#[derive(Deserialize)]
pub struct AddLayerParams {
    pub name: String,
    #[serde(rename = "type")]
    pub layer_type: String,
    pub cols: Option<u32>,
    pub rows: Option<u32>,
}

#[tauri::command]
pub async fn add_layer(
    params: AddLayerParams,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<Layer, String> {
    let z_index = state.get_layers_snapshot().len() as i32;
    let layer = match params.layer_type.as_str() {
        "quad" => Layer::new_quad(&params.name, z_index),
        "triangle" => Layer::new_triangle(&params.name, z_index),
        "mesh" => Layer::new_mesh(
            &params.name,
            z_index,
            params.cols.unwrap_or(4),
            params.rows.unwrap_or(4),
        ),
        "circle" => Layer::new_circle(&params.name, z_index),
        _ => return Err(format!("Unknown layer type: {}", params.layer_type)),
    };
    state.add_layer(layer.clone());
    sync_render_state(&state, &render);
    Ok(layer)
}

#[tauri::command]
pub async fn remove_layer(
    layer_id: String,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let result = state.remove_layer(&layer_id).is_some();
    if result {
        sync_render_state(&state, &render);
    }
    Ok(result)
}

#[tauri::command]
pub async fn duplicate_layer(
    layer_id: String,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<Option<Layer>, String> {
    let result = state.duplicate_layer(&layer_id);
    if result.is_some() {
        sync_render_state(&state, &render);
    }
    Ok(result)
}

#[tauri::command]
pub async fn rename_layer(
    layer_id: String,
    name: String,
    state: State<'_, SceneState>,
) -> Result<bool, String> {
    Ok(state.rename_layer(&layer_id, &name))
}

#[tauri::command]
pub async fn set_layer_visibility(
    layer_id: String,
    visible: bool,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let result = state.set_layer_visibility(&layer_id, visible);
    if result {
        sync_render_state(&state, &render);
    }
    Ok(result)
}

#[tauri::command]
pub async fn set_layer_locked(
    layer_id: String,
    locked: bool,
    state: State<'_, SceneState>,
) -> Result<bool, String> {
    Ok(state.set_layer_locked(&layer_id, locked))
}

#[tauri::command]
pub async fn reorder_layers(
    layer_ids: Vec<String>,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let result = state.reorder_layers(&layer_ids);
    sync_render_state(&state, &render);
    Ok(result)
}

/// Snapshot undo state before a drag/interaction begins.
/// Call once at mousedown, NOT during mousemove.
#[tauri::command]
pub async fn begin_interaction(
    state: State<'_, SceneState>,
) -> Result<(), String> {
    state.begin_interaction();
    Ok(())
}

#[tauri::command]
pub async fn update_layer_geometry(
    layer_id: String,
    geometry: LayerGeometry,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let result = state.update_layer_geometry(&layer_id, geometry);
    if result {
        sync_render_state(&state, &render);
    }
    Ok(result)
}

#[tauri::command]
pub async fn update_layer_properties(
    layer_id: String,
    properties: LayerProperties,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let result = state.update_layer_properties(&layer_id, properties);
    if result {
        sync_render_state(&state, &render);
    }
    Ok(result)
}

#[tauri::command]
pub async fn set_layer_source(
    layer_id: String,
    source: Option<SourceAssignment>,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let result = state.set_layer_source(&layer_id, source);
    if result {
        sync_render_state(&state, &render);
    }
    Ok(result)
}

#[tauri::command]
pub async fn set_layer_blend_mode(
    layer_id: String,
    blend_mode: crate::scene::layer::BlendMode,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let result = state.set_layer_blend_mode(&layer_id, blend_mode);
    if result {
        sync_render_state(&state, &render);
    }
    Ok(result)
}

#[tauri::command]
pub async fn get_layers(state: State<'_, SceneState>) -> Result<Vec<Layer>, String> {
    Ok(state.get_layers_snapshot())
}

// =============================================================================
// Calibration commands
// =============================================================================

#[tauri::command]
pub async fn set_calibration_enabled(
    enabled: bool,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<(), String> {
    state.set_calibration_enabled(enabled);
    sync_render_state(&state, &render);
    Ok(())
}

#[tauri::command]
pub async fn set_calibration_pattern(
    pattern: CalibrationPattern,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<(), String> {
    state.set_calibration_pattern(pattern);
    sync_render_state(&state, &render);
    Ok(())
}

// =============================================================================
// Project persistence commands
// =============================================================================

#[tauri::command]
pub async fn save_project(
    path: Option<String>,
    state: State<'_, SceneState>,
) -> Result<String, String> {
    let save_path = if let Some(p) = path {
        PathBuf::from(p)
    } else if let Some(p) = state.project_path.read().clone() {
        PathBuf::from(p)
    } else {
        return Err("No file path specified".to_string());
    };

    let project = state.get_project_snapshot();
    persistence::save_project(&project, &save_path)?;
    *state.project_path.write() = Some(save_path.to_string_lossy().to_string());
    state.mark_clean();
    persistence::clear_recovery(Some(&save_path));
    Ok(save_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn load_project(
    path: String,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<ProjectFile, String> {
    let project = persistence::load_project(&PathBuf::from(&path))?;
    state.load_project(project.clone(), Some(path));
    sync_render_state(&state, &render);
    Ok(project)
}

#[tauri::command]
pub async fn new_project(
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<ProjectFile, String> {
    state.new_project("Untitled Project");
    sync_render_state(&state, &render);
    Ok(state.get_project_snapshot())
}

#[tauri::command]
pub async fn get_project(state: State<'_, SceneState>) -> Result<ProjectFile, String> {
    Ok(state.get_project_snapshot())
}

#[tauri::command]
pub async fn is_dirty(state: State<'_, SceneState>) -> Result<bool, String> {
    Ok(state.is_dirty())
}

#[tauri::command]
pub async fn has_recovery(state: State<'_, SceneState>) -> Result<bool, String> {
    let path = state.project_path.read().clone();
    Ok(persistence::has_recovery(path.as_ref().map(|p| std::path::Path::new(p.as_str()))))
}

#[tauri::command]
pub async fn load_recovery(
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<ProjectFile, String> {
    let path = state.project_path.read().clone();
    let project = persistence::load_recovery(path.as_ref().map(|p| std::path::Path::new(p.as_str())))?;
    state.load_project(project.clone(), path);
    sync_render_state(&state, &render);
    Ok(project)
}

// =============================================================================
// Undo / Redo
// =============================================================================

#[derive(Serialize)]
pub struct UndoRedoResult {
    pub layers: Vec<Layer>,
    pub can_undo: bool,
    pub can_redo: bool,
}

#[tauri::command]
pub async fn undo(
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<Option<UndoRedoResult>, String> {
    if let Some(layers) = state.undo() {
        sync_render_state(&state, &render);
        Ok(Some(UndoRedoResult {
            layers,
            can_undo: state.can_undo(),
            can_redo: state.can_redo(),
        }))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn redo(
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<Option<UndoRedoResult>, String> {
    if let Some(layers) = state.redo() {
        sync_render_state(&state, &render);
        Ok(Some(UndoRedoResult {
            layers,
            can_undo: state.can_undo(),
            can_redo: state.can_redo(),
        }))
    } else {
        Ok(None)
    }
}

// =============================================================================
// Source discovery commands
// =============================================================================

#[tauri::command]
pub async fn list_sources(
    input: State<'_, Arc<parking_lot::RwLock<crate::input::adapter::InputManager>>>,
) -> Result<Vec<SourceInfo>, String> {
    Ok(input.read().list_all_sources())
}

#[tauri::command]
pub async fn refresh_sources(
    input: State<'_, Arc<parking_lot::RwLock<crate::input::adapter::InputManager>>>,
) -> Result<Vec<SourceInfo>, String> {
    Ok(input.read().list_all_sources())
}

/// Register a media file (image) as an available source.
/// The frontend calls this after the user picks a file via the native file dialog.
#[tauri::command]
pub async fn add_media_file(
    path: String,
    input: State<'_, Arc<parking_lot::RwLock<crate::input::adapter::InputManager>>>,
) -> Result<SourceInfo, String> {
    let file_path = std::path::PathBuf::from(&path);
    input
        .write()
        .register_media_file(&file_path)
        .map_err(|e| e.to_string())
}

/// Remove a previously registered media file source.
#[tauri::command]
pub async fn remove_media_file(
    source_id: String,
    input: State<'_, Arc<parking_lot::RwLock<crate::input::adapter::InputManager>>>,
) -> Result<bool, String> {
    Ok(input.write().remove_media_file(&source_id))
}

/// Connect a source to a layer (binds source_id to layer_id in the InputManager,
/// and also sets the SourceAssignment on the layer in SceneState).
#[tauri::command]
pub async fn connect_source(
    layer_id: String,
    source_id: String,
    input: State<'_, Arc<parking_lot::RwLock<crate::input::adapter::InputManager>>>,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    // Connect in input manager
    input
        .write()
        .connect_source(&layer_id, &source_id)
        .map_err(|e| e.to_string())?;

    // Set the source assignment on the layer
    let source_info = input
        .read()
        .list_all_sources()
        .into_iter()
        .find(|s| s.id == source_id);

    if let Some(info) = source_info {
        let assignment = SourceAssignment {
            source_id: info.id,
            protocol: info.protocol,
            display_name: info.name,
        };
        state.set_layer_source(&layer_id, Some(assignment));
        sync_render_state(&state, &render);
    }

    Ok(true)
}

/// Disconnect a source from a layer.
#[tauri::command]
pub async fn disconnect_source(
    layer_id: String,
    input: State<'_, Arc<parking_lot::RwLock<crate::input::adapter::InputManager>>>,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    input.write().disconnect_source(&layer_id);
    state.set_layer_source(&layer_id, None);
    sync_render_state(&state, &render);
    Ok(true)
}

// =============================================================================
// Syphon framework management (macOS only)
// =============================================================================

/// Syphon framework status diagnostic info
#[derive(Serialize)]
pub struct SyphonStatus {
    /// Whether the bridge was compiled (framework found at build time)
    pub bridge_compiled: bool,
    /// Whether the runtime check reports the framework is usable
    pub bridge_available: bool,
    /// Paths checked and whether each exists
    pub search_paths: Vec<(String, bool)>,
    /// Hint message for the user
    pub message: String,
}

#[tauri::command]
pub async fn check_syphon_status() -> Result<SyphonStatus, String> {
    #[cfg(all(target_os = "macos", feature = "input-syphon"))]
    {
        // Bridge is always compiled now (uses dlopen at runtime)
        let bridge_compiled = true;
        let bridge_available = crate::input::syphon::is_bridge_available();

        let search_paths: Vec<(String, bool)> = crate::input::syphon::framework_search_paths()
            .into_iter()
            .map(|p| {
                let exists = std::path::Path::new(&p).exists();
                (p, exists)
            })
            .collect();

        let any_exists = search_paths.iter().any(|(_, exists)| *exists);
        let message = if bridge_available {
            "Syphon is ready. Syphon servers should appear automatically.".to_string()
        } else if any_exists {
            "Syphon.framework found but can't load (likely wrong architecture). \
             Click below to build a native version for your Mac."
                .to_string()
        } else {
            "Syphon.framework not found. Click below to build and install it."
                .to_string()
        };

        log::info!(
            "check_syphon_status: compiled={} available={} paths={:?}",
            bridge_compiled,
            bridge_available,
            search_paths
        );

        Ok(SyphonStatus {
            bridge_compiled,
            bridge_available,
            search_paths,
            message,
        })
    }

    #[cfg(not(all(target_os = "macos", feature = "input-syphon")))]
    {
        Ok(SyphonStatus {
            bridge_compiled: false,
            bridge_available: false,
            search_paths: Vec::new(),
            message: "Syphon is only available on macOS.".to_string(),
        })
    }
}

/// Build and install Syphon.framework from source to ~/Library/Frameworks/.
///
/// The official Syphon SDK 5 release is x86_64-only. Apple Silicon Macs need
/// an arm64 build, so we clone the repo and build a universal framework via
/// xcodebuild. Requires Xcode command-line tools.
#[tauri::command]
pub async fn install_syphon_framework() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        use std::process::Command;

        let home = std::env::var("HOME").map_err(|_| "Cannot determine HOME directory")?;
        let frameworks_dir = format!("{}/Library/Frameworks", home);
        let target_path = format!("{}/Syphon.framework", frameworks_dir);

        // If already installed, try to load it first
        if std::path::Path::new(&target_path).exists() {
            let loaded = crate::input::syphon::try_reload();
            if loaded {
                return Ok("Syphon.framework is already installed and loaded! \
                           Refresh sources to see Syphon servers."
                    .to_string());
            }
            // Exists but can't load — likely wrong architecture.
            // Remove and rebuild.
            log::warn!(
                "Syphon: existing framework at {} can't be loaded (likely x86_64-only). Rebuilding...",
                target_path
            );
            let _ = std::fs::remove_dir_all(&target_path);
        }

        // Check for Xcode command-line tools
        let xcrun = Command::new("xcrun")
            .args(["--find", "xcodebuild"])
            .output();
        if xcrun.is_err() || !xcrun.unwrap().status.success() {
            return Err(
                "Xcode command-line tools are required to build Syphon.\n\
                 Install them with: xcode-select --install"
                    .to_string(),
            );
        }

        // Ensure ~/Library/Frameworks/ exists
        std::fs::create_dir_all(&frameworks_dir)
            .map_err(|e| format!("Failed to create {}: {}", frameworks_dir, e))?;

        let tmp_dir = std::env::temp_dir().join("auramap_syphon_build");
        let repo_dir = tmp_dir.join("Syphon-Framework");

        // Clean up any previous attempt
        let _ = std::fs::remove_dir_all(&tmp_dir);
        std::fs::create_dir_all(&tmp_dir)
            .map_err(|e| format!("Failed to create temp dir: {}", e))?;

        // Clone the Syphon-Framework repo (shallow clone for speed)
        log::info!("Syphon: cloning Syphon-Framework from GitHub...");
        let git_output = Command::new("git")
            .args([
                "clone",
                "--depth",
                "1",
                "https://github.com/Syphon/Syphon-Framework.git",
                repo_dir.to_str().unwrap(),
            ])
            .output()
            .map_err(|e| format!("Failed to run git: {}", e))?;

        if !git_output.status.success() {
            let stderr = String::from_utf8_lossy(&git_output.stderr);
            return Err(format!("Failed to clone Syphon repo: {}", stderr));
        }

        // Build universal framework (arm64 + x86_64) using xcodebuild archive + export
        log::info!("Syphon: building universal framework with xcodebuild...");

        let archive_path = tmp_dir.join("Syphon.xcarchive");

        // Build the framework archive
        let build_output = Command::new("xcodebuild")
            .current_dir(&repo_dir)
            .args([
                "archive",
                "-project",
                "Syphon.xcodeproj",
                "-scheme",
                "Syphon",
                "-archivePath",
                archive_path.to_str().unwrap(),
                "-configuration",
                "Release",
                "ONLY_ACTIVE_ARCH=NO",
                "SKIP_INSTALL=NO",
                "BUILD_LIBRARY_FOR_DISTRIBUTION=YES",
            ])
            .output()
            .map_err(|e| format!("Failed to run xcodebuild: {}", e))?;

        if !build_output.status.success() {
            let stderr = String::from_utf8_lossy(&build_output.stderr);
            let stdout = String::from_utf8_lossy(&build_output.stdout);
            log::error!("xcodebuild archive failed:\nstdout: {}\nstderr: {}", stdout, stderr);

            // Fallback: try a simple build instead of archive
            log::info!("Syphon: trying simple xcodebuild build...");
            let simple_build = Command::new("xcodebuild")
                .current_dir(&repo_dir)
                .args([
                    "-project",
                    "Syphon.xcodeproj",
                    "-scheme",
                    "Syphon",
                    "-configuration",
                    "Release",
                    "ONLY_ACTIVE_ARCH=NO",
                    "BUILD_LIBRARY_FOR_DISTRIBUTION=YES",
                ])
                .output()
                .map_err(|e| format!("Failed to run xcodebuild: {}", e))?;

            if !simple_build.status.success() {
                let stderr2 = String::from_utf8_lossy(&simple_build.stderr);
                return Err(format!(
                    "xcodebuild failed. Make sure Xcode is installed.\n\
                     Error: {}",
                    stderr2.chars().take(500).collect::<String>()
                ));
            }

            // Find the built framework in DerivedData or build dir
            let find_output = Command::new("find")
                .args([
                    repo_dir.to_str().unwrap(),
                    "-name",
                    "Syphon.framework",
                    "-type",
                    "d",
                    "-path",
                    "*/Release/*",
                ])
                .output()
                .map_err(|e| format!("Failed to search for built framework: {}", e))?;

            let found = String::from_utf8_lossy(&find_output.stdout)
                .lines()
                .next()
                .map(|s| s.to_string());

            match found {
                Some(p) if !p.is_empty() => {
                    log::info!("Syphon: found built framework at {}", p);
                    let cp = Command::new("cp")
                        .args(["-R", &p, &target_path])
                        .output()
                        .map_err(|e| format!("Failed to copy: {}", e))?;
                    if !cp.status.success() {
                        return Err("Failed to copy built framework".to_string());
                    }
                }
                _ => {
                    // Also check DerivedData
                    let dd_find = Command::new("find")
                        .args([
                            &format!("{}/Library/Developer/Xcode/DerivedData", home),
                            "-name",
                            "Syphon.framework",
                            "-type",
                            "d",
                            "-path",
                            "*/Release/*",
                        ])
                        .output();

                    let dd_found = dd_find
                        .ok()
                        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                        .and_then(|s| s.lines().next().map(|l| l.to_string()));

                    match dd_found {
                        Some(p) if !p.is_empty() => {
                            log::info!("Syphon: found in DerivedData at {}", p);
                            let cp = Command::new("cp")
                                .args(["-R", &p, &target_path])
                                .output()
                                .map_err(|e| format!("Failed to copy: {}", e))?;
                            if !cp.status.success() {
                                return Err("Failed to copy built framework".to_string());
                            }
                        }
                        _ => {
                            return Err(
                                "Build succeeded but could not find the output framework."
                                    .to_string(),
                            );
                        }
                    }
                }
            }
        } else {
            // Archive succeeded — extract the framework from the archive
            let archive_fw = archive_path.join("Products/Library/Frameworks/Syphon.framework");
            if archive_fw.exists() {
                let cp = Command::new("cp")
                    .args(["-R", archive_fw.to_str().unwrap(), &target_path])
                    .output()
                    .map_err(|e| format!("Failed to copy: {}", e))?;
                if !cp.status.success() {
                    return Err("Failed to copy archived framework".to_string());
                }
            } else {
                return Err(format!(
                    "Archive succeeded but framework not found at expected path: {:?}",
                    archive_fw
                ));
            }
        }

        // Clean up
        let _ = std::fs::remove_dir_all(&tmp_dir);

        log::info!("Syphon: framework built and installed at {}", target_path);

        // Try to load immediately
        let loaded = crate::input::syphon::try_reload();
        if loaded {
            log::info!("Syphon: framework loaded at runtime — ready to use!");
            Ok("Syphon.framework built and loaded! Syphon sources should appear when you refresh."
                .to_string())
        } else {
            log::warn!("Syphon: built and installed but runtime load failed");
            Ok(format!(
                "Syphon.framework built and installed to {}.\n\
                 Runtime loading failed — please restart the app.",
                target_path
            ))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Syphon is only available on macOS.".to_string())
    }
}

// =============================================================================
// Output config
// =============================================================================

#[tauri::command]
pub async fn set_output_config(
    config: OutputConfig,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<(), String> {
    *render.output_width.write() = config.width;
    *render.output_height.write() = config.height;
    state.set_output_config(config);
    render.request_redraw();
    Ok(())
}

// =============================================================================
// Frame preview — returns raw RGBA pixels for a layer's source
// =============================================================================

/// Max preview dimension — frames are downscaled to this before base64 encoding.
/// Keeps IPC payload small (~40KB instead of ~1.2MB per frame).
const PREVIEW_MAX_DIM: u32 = 160;

/// Response carrying a frame snapshot for the frontend to paint
#[derive(Serialize)]
pub struct FrameSnapshot {
    pub width: u32,
    pub height: u32,
    /// RGBA pixels as base64-encoded data
    pub data_b64: String,
}

/// Downsample RGBA frame using nearest-neighbor. Fast, no deps needed.
fn downsample_rgba(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    dst_w: u32,
    dst_h: u32,
) -> Vec<u8> {
    let mut dst = vec![0u8; (dst_w * dst_h * 4) as usize];
    for y in 0..dst_h {
        for x in 0..dst_w {
            let sx = (x * src_w / dst_w).min(src_w - 1);
            let sy = (y * src_h / dst_h).min(src_h - 1);
            let si = ((sy * src_w + sx) * 4) as usize;
            let di = ((y * dst_w + x) * 4) as usize;
            dst[di..di + 4].copy_from_slice(&src[si..si + 4]);
        }
    }
    dst
}

/// Compute preview dimensions maintaining aspect ratio
fn preview_dims(w: u32, h: u32) -> (u32, u32) {
    if w <= PREVIEW_MAX_DIM && h <= PREVIEW_MAX_DIM {
        return (w, h);
    }
    let scale = PREVIEW_MAX_DIM as f32 / w.max(h) as f32;
    let nw = ((w as f32 * scale) as u32).max(1);
    let nh = ((h as f32 * scale) as u32).max(1);
    (nw, nh)
}

/// Encode a frame to a FrameSnapshot, downscaling for IPC efficiency.
fn encode_frame(f: &crate::input::adapter::FramePacket) -> FrameSnapshot {
    use base64::Engine;

    let (pw, ph) = preview_dims(f.width, f.height);
    let data = if pw == f.width && ph == f.height {
        f.data.clone()
    } else {
        downsample_rgba(&f.data, f.width, f.height, pw, ph)
    };
    let b64 = base64::engine::general_purpose::STANDARD.encode(&data);

    FrameSnapshot {
        width: pw,
        height: ph,
        data_b64: b64,
    }
}

/// Poll a single frame from the source assigned to a layer.
/// Returns None if the layer has no source or no frame is available.
#[tauri::command]
pub async fn poll_layer_frame(
    layer_id: String,
    input: State<'_, Arc<parking_lot::RwLock<crate::input::adapter::InputManager>>>,
) -> Result<Option<FrameSnapshot>, String> {
    let mut mgr = input.write();
    let frame = mgr.poll_frame_for_layer(&layer_id);

    match frame {
        Some(f) => Ok(Some(encode_frame(&f))),
        None => Ok(None),
    }
}

/// Poll frames for ALL layers that have sources assigned.
/// Returns a map of layer_id -> FrameSnapshot. Much more efficient than
/// calling poll_layer_frame per-layer since it only acquires the lock once.
#[tauri::command]
pub async fn poll_all_frames(
    input: State<'_, Arc<parking_lot::RwLock<crate::input::adapter::InputManager>>>,
) -> Result<std::collections::HashMap<String, FrameSnapshot>, String> {
    let t0 = std::time::Instant::now();

    let mut mgr = input.write();
    let bound = mgr.bound_layer_ids();
    let mut result = std::collections::HashMap::new();
    let mut frame_count = 0u32;

    for layer_id in &bound {
        let binding = mgr.get_binding(layer_id).map(|s| s.to_string());
        if let Some(f) = mgr.poll_frame_for_layer(layer_id) {
            // Log first 4 pixels (16 bytes) as fingerprint to detect cross-contamination
            let fingerprint: Vec<u8> = f.data.iter().take(16).copied().collect();
            log::debug!(
                "poll_all_frames: layer={} source={:?} dims={}x{} fp={:?}",
                &layer_id[..8],
                binding,
                f.width,
                f.height,
                fingerprint
            );
            result.insert(layer_id.clone(), encode_frame(&f));
            frame_count += 1;
        }
    }

    let elapsed = t0.elapsed();
    if frame_count > 0 && elapsed.as_millis() > 16 {
        log::warn!(
            "poll_all_frames SLOW: {} frames, {:.1}ms",
            frame_count,
            elapsed.as_secs_f64() * 1000.0
        );
    }

    Ok(result)
}

// =============================================================================
// Render stats (for StatusBar)
// =============================================================================

#[derive(Serialize)]
pub struct RenderStats {
    pub gpu_name: String,
    pub gpu_ready: bool,
}

#[tauri::command]
pub async fn get_render_stats(
    app: tauri::AppHandle,
) -> Result<RenderStats, String> {
    let engine_state = app
        .try_state::<Arc<parking_lot::RwLock<crate::renderer::engine::RenderEngine>>>();

    match engine_state {
        Some(engine_lock) => {
            let engine = engine_lock.read();
            let info = engine.gpu.adapter.get_info();
            Ok(RenderStats {
                gpu_name: info.name.clone(),
                gpu_ready: true,
            })
        }
        None => Ok(RenderStats {
            gpu_name: "Initializing GPU...".to_string(),
            gpu_ready: false,
        }),
    }
}

// =============================================================================
// GPU projector stats
// =============================================================================

#[derive(Serialize)]
pub struct ProjectorStats {
    pub gpu_native: bool,
    pub fps: u64,
    pub frametime_ms: f64,
}

#[tauri::command]
pub async fn get_projector_stats(
    app: tauri::AppHandle,
) -> Result<ProjectorStats, String> {
    let projector = app.state::<Arc<parking_lot::Mutex<GpuProjector>>>();
    let p = projector.lock();
    Ok(ProjectorStats {
        gpu_native: p.is_running(),
        fps: p.fps(),
        frametime_ms: p.frametime_ms(),
    })
}

// =============================================================================
// System utilization stats
// =============================================================================

#[derive(Serialize)]
pub struct SystemStats {
    /// Process CPU usage 0–100 (can exceed 100 on multi-core)
    pub process_cpu: f32,
    /// Process RSS in bytes
    pub process_mem: u64,
    /// Total system memory in bytes
    pub total_mem: u64,
    /// Used system memory in bytes
    pub used_mem: u64,
    /// Overall system CPU usage 0–100
    pub system_cpu: f32,
    /// Number of logical CPUs
    pub cpu_count: usize,
    /// CPU model name
    pub cpu_name: String,
}

#[tauri::command]
pub async fn get_system_stats(
    sys: State<'_, Arc<parking_lot::Mutex<sysinfo::System>>>,
) -> Result<SystemStats, String> {
    let mut s = sys.lock();

    // Refresh only what we need (CPU + memory + our process)
    s.refresh_cpu_usage();
    s.refresh_memory();

    let pid = sysinfo::get_current_pid().ok();
    if let Some(pid) = pid {
        s.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
    }

    let (process_cpu, process_mem) = pid
        .and_then(|p| s.process(p))
        .map(|p| (p.cpu_usage(), p.memory()))
        .unwrap_or((0.0, 0));

    let global_cpu = s.global_cpu_usage();
    let cpu_name = s.cpus().first().map(|c| c.brand().to_string()).unwrap_or_default();

    Ok(SystemStats {
        process_cpu,
        process_mem,
        total_mem: s.total_memory(),
        used_mem: s.used_memory(),
        system_cpu: global_cpu,
        cpu_count: s.cpus().len(),
        cpu_name,
    })
}
