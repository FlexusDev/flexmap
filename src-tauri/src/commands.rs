//! Tauri IPC commands — control actions from the React UI to Rust backend

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use crate::scene::layer::*;
use crate::scene::project::*;
use crate::scene::state::SceneState;
use crate::audio::{AudioInputDevice, BpmConfig, BpmState, BpmEngine};
use crate::persistence;
use crate::input::adapter::{InstalledShaderSource, SourceInfo};
use crate::renderer::engine::RenderState;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{Emitter, Manager, State, Size, PhysicalSize, WebviewUrl, webview::WebviewWindowBuilder};
use tauri::window::WindowBuilder;
use crate::renderer::projector::GpuProjector;

/// Helper: after any scene mutation, sync layers + calibration to the render state
fn sync_render_state(scene: &SceneState, render: &Arc<RenderState>) {
    render.update_layers(scene.get_layers_snapshot());
    let project = scene.get_project_snapshot();
    render.update_calibration(project.calibration);
}

static PROJECTOR_RESIZE_ADJUSTING: AtomicBool = AtomicBool::new(false);

#[derive(Serialize, Clone, Copy)]
pub struct ProjectorWindowState {
    pub open: bool,
    pub gpu_native: bool,
}

fn current_projector_window_state(app: &tauri::AppHandle) -> ProjectorWindowState {
    let native_open = app.get_window("projector").is_some();
    let webview_open = app.get_webview_window("projector").is_some();
    let gpu_running = app
        .try_state::<Arc<parking_lot::Mutex<GpuProjector>>>()
        .map(|projector| projector.lock().is_running())
        .unwrap_or(false);

    ProjectorWindowState {
        open: native_open || webview_open || gpu_running,
        gpu_native: gpu_running && native_open,
    }
}

fn emit_projector_window_state(app: &tauri::AppHandle) {
    let state = current_projector_window_state(app);
    let _ = app.emit("projector-window-state", state);
}

const COMMON_ASPECT_RATIOS: [(&str, u32, u32); 11] = [
    ("1:1", 1, 1),
    ("4:3", 4, 3),
    ("5:4", 5, 4),
    ("3:2", 3, 2),
    ("16:10", 16, 10),
    ("16:9", 16, 9),
    ("17:9", 17, 9),
    ("21:9", 21, 9),
    ("32:9", 32, 9),
    ("9:16", 9, 16),
    ("3:4", 3, 4),
];

fn ratio_from_id(id: &str) -> Option<(u32, u32)> {
    COMMON_ASPECT_RATIOS
        .iter()
        .find_map(|(rid, w, h)| if *rid == id { Some((*w, *h)) } else { None })
}

fn infer_ratio_from_output(width: u32, height: u32) -> (u32, u32) {
    let w = width.max(1);
    let h = height.max(1);
    for (_, rw, rh) in COMMON_ASPECT_RATIOS.iter().copied() {
        if rw * h == rh * w {
            return (rw, rh);
        }
    }
    (16, 9)
}

fn resolve_main_window_ratio(project: &ProjectFile) -> Option<(u32, u32)> {
    let mut lock_enabled = true;
    let mut ratio = infer_ratio_from_output(project.output.width, project.output.height);

    if let Some(aspect) = project
        .ui_state
        .get("aspectRatio")
        .and_then(|v| v.as_object())
    {
        if let Some(lock) = aspect.get("lockEnabled").and_then(|v| v.as_bool()) {
            lock_enabled = lock;
        }
        if let Some(ratio_id) = aspect.get("ratioId").and_then(|v| v.as_str()) {
            if let Some((rw, rh)) = ratio_from_id(ratio_id) {
                ratio = (rw, rh);
            }
        }
    }

    if lock_enabled { Some(ratio) } else { None }
}

fn compute_locked_window_size(width: u32, height: u32, rw: u32, rh: u32) -> (u32, u32) {
    let w = width.max(1);
    let h = height.max(1);

    let h_from_w = ((w as f64 * rh as f64) / rw as f64).round().max(1.0) as u32;
    let w_from_h = ((h as f64 * rw as f64) / rh as f64).round().max(1.0) as u32;

    let h_delta = (h_from_w as i64 - h as i64).abs();
    let w_delta = (w_from_h as i64 - w as i64).abs();

    if h_delta <= w_delta {
        (w, h_from_w)
    } else {
        (w_from_h, h)
    }
}

/// Ensures the main editor window is always resizable (aspect lock does not apply to it).
pub(crate) fn ensure_main_window_resizable(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.set_resizable(true).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Applies aspect ratio lock only to the projector window (when lock is on: non-resizable, size snapped).
pub(crate) fn apply_projector_aspect_lock(
    app: &tauri::AppHandle,
    state: &SceneState,
) -> Result<(), String> {
    let project = state.get_project_snapshot();
    let ratio = resolve_main_window_ratio(&project);

    // Try native window (GPU path) first, then webview fallback.
    if let Some(win) = app.get_window("projector") {
        let size = win.inner_size().map_err(|e| e.to_string())?;
        return apply_projector_aspect_lock_impl(
            size.width,
            size.height,
            |resizable| win.set_resizable(resizable).map_err(|e| e.to_string()),
            |w, h| win.set_size(Size::Physical(PhysicalSize::new(w, h))).map_err(|e| e.to_string()),
            win.is_fullscreen().map_err(|e| e.to_string())?,
            ratio,
        );
    }
    if let Some(win) = app.get_webview_window("projector") {
        let size = win.inner_size().map_err(|e| e.to_string())?;
        return apply_projector_aspect_lock_impl(
            size.width,
            size.height,
            |resizable| win.set_resizable(resizable).map_err(|e| e.to_string()),
            |w, h| win.set_size(Size::Physical(PhysicalSize::new(w, h))).map_err(|e| e.to_string()),
            win.is_fullscreen().map_err(|e| e.to_string())?,
            ratio,
        );
    }
    Ok(())
}

fn apply_projector_aspect_lock_impl<F, G>(
    width: u32,
    height: u32,
    set_resizable: F,
    set_size: G,
    fullscreen: bool,
    ratio: Option<(u32, u32)>,
) -> Result<(), String>
where
    F: FnOnce(bool) -> Result<(), String>,
    G: FnOnce(u32, u32) -> Result<(), String>,
{
    set_resizable(ratio.is_none()).map_err(|e| e.to_string())?;

    if fullscreen {
        return Ok(());
    }

    let Some((rw, rh)) = ratio else {
        return Ok(());
    };

    let (target_w, target_h) = compute_locked_window_size(width, height, rw, rh);

    if target_w == width && target_h == height {
        return Ok(());
    }

    if PROJECTOR_RESIZE_ADJUSTING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(());
    }

    let set_result = set_size(target_w, target_h);
    PROJECTOR_RESIZE_ADJUSTING.store(false, Ordering::SeqCst);
    set_result
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
    state: State<'_, SceneState>,
) -> Result<(), String> {
    let projector_running = {
        let projector = app.state::<Arc<parking_lot::Mutex<GpuProjector>>>();
        let running = projector.lock().is_running();
        running
    };

    // Native projector window already exists.
    // - If renderer is running, just focus/show it (idempotent open).
    // - If renderer is stopped, this is a stale window; destroy and recreate.
    if let Some(win) = app.get_window("projector") {
        if projector_running {
            let _ = win.show();
            let _ = win.set_focus();
            emit_projector_window_state(&app);
            log::info!("GPU projector already running");
            return Ok(());
        }

        log::warn!("Found stale native projector window; recreating");
        win.destroy().map_err(|e| e.to_string())?;

        // Wait briefly for label release before recreating the window.
        for _ in 0..20 {
            if app.get_window("projector").is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        if app.get_window("projector").is_some() {
            return Err("Projector window is still closing; please try again.".to_string());
        }
    } else if projector_running {
        // Rare state drift: renderer reports running but no window exists.
        log::warn!("GPU projector marked running without a window; resetting state");
        let projector = app.state::<Arc<parking_lot::Mutex<GpuProjector>>>();
        projector.lock().stop();
    }

    // Also check for existing webview projector (fallback path)
    if let Some(win) = app.get_webview_window("projector") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        emit_projector_window_state(&app);
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
                    .title("FlexMap Projector Output [GPU]")
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

                // Apply aspect lock so projector opens with correct size/resizable when lock is on
                let scene_state = app_handle.state::<SceneState>();
                let _ = apply_projector_aspect_lock(&app_handle, &scene_state);

                // Listen for window resize / close events
                let resize_app = app_handle.clone();
                win.on_window_event(move |event| {
                    match event {
                        tauri::WindowEvent::Resized(size) => {
                            let scene_state = resize_app.state::<SceneState>();
                            let _ = apply_projector_aspect_lock(&resize_app, &scene_state);
                            let rs = resize_app.state::<Arc<RenderState>>();
                            let (w, h) = resize_app
                                .get_window("projector")
                                .and_then(|w| w.inner_size().ok())
                                .map(|s| (s.width.max(1), s.height.max(1)))
                                .unwrap_or((size.width.max(1), size.height.max(1)));
                            *rs.output_width.write() = w;
                            *rs.output_height.write() = h;
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
                            emit_projector_window_state(&resize_app);
                        }
                        _ => {}
                    }
                });

                emit_projector_window_state(&app_handle);
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
    let win = WebviewWindowBuilder::new(
        &app,
        "projector",
        WebviewUrl::App("index.html#/projector".into()),
    )
    .decorations(true)
    .fullscreen(false)
    .visible(true)
    .inner_size(960.0, 540.0)
    .title("FlexMap Projector Output")
    .build()
    .map_err(|e: tauri::Error| e.to_string())?;

    let resize_app = app.clone();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Resized(_) = event {
            let scene_state = resize_app.state::<SceneState>();
            let _ = apply_projector_aspect_lock(&resize_app, &scene_state);
        }
    });

    let _ = ensure_main_window_resizable(&app);
    let _ = apply_projector_aspect_lock(&app, &state);

    emit_projector_window_state(&app);
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

    // Wait briefly for the window to actually close before emitting state,
    // otherwise get_webview_window("projector") still returns Some and
    // the frontend receives a stale "open: true" event.
    for _ in 0..20 {
        if app.get_window("projector").is_none() && app.get_webview_window("projector").is_none() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    emit_projector_window_state(&app);
    Ok(())
}

#[tauri::command]
pub async fn get_projector_window_state(app: tauri::AppHandle) -> Result<ProjectorWindowState, String> {
    Ok(current_projector_window_state(&app))
}

#[tauri::command]
pub async fn set_projector_fullscreen(
    app: tauri::AppHandle,
    fullscreen: bool,
) -> Result<(), String> {
    if let Some(win) = app.get_window("projector") {
        win.set_fullscreen(fullscreen).map_err(|e| e.to_string())?;
        return Ok(());
    }
    if let Some(win) = app.get_webview_window("projector") {
        win.set_fullscreen(fullscreen).map_err(|e| e.to_string())?;
        return Ok(());
    }
    Err("Projector window not found".to_string())
}

#[tauri::command]
pub async fn get_projector_fullscreen(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(win) = app.get_window("projector") {
        return win.is_fullscreen().map_err(|e| e.to_string());
    }
    if let Some(win) = app.get_webview_window("projector") {
        return win.is_fullscreen().map_err(|e| e.to_string());
    }
    Ok(false)
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
pub async fn remove_layers(
    layer_ids: Vec<String>,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let result = state.remove_layers(&layer_ids);
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
pub async fn duplicate_layers(
    layer_ids: Vec<String>,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<Vec<Layer>, String> {
    let result = state.duplicate_layers(&layer_ids);
    if !result.is_empty() {
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
pub async fn set_layer_input_transform(
    layer_id: String,
    input_transform: InputTransform,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let result = state.set_layer_input_transform(&layer_id, input_transform);
    if result {
        sync_render_state(&state, &render);
    }
    Ok(result)
}

#[tauri::command]
pub async fn apply_layer_geometry_transform_delta(
    layer_id: String,
    dx: f64,
    dy: f64,
    d_rotation: f64,
    sx: f64,
    sy: f64,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<Option<LayerGeometry>, String> {
    let result = state.apply_layer_geometry_transform_delta(&layer_id, dx, dy, d_rotation, sx, sy);
    if result.is_some() {
        sync_render_state(&state, &render);
    }
    Ok(result)
}

#[tauri::command]
pub async fn update_layer_point(
    layer_id: String,
    point_index: usize,
    point: Point2D,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<Option<LayerGeometry>, String> {
    let result = state.update_layer_point(&layer_id, point_index, point);
    if result.is_some() {
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
    app: tauri::AppHandle,
) -> Result<ProjectFile, String> {
    let project = persistence::load_project(&PathBuf::from(&path))?;
    state.load_project(project.clone(), Some(path));
    sync_render_state(&state, &render);
    let _ = ensure_main_window_resizable(&app);
    let _ = apply_projector_aspect_lock(&app, &state);
    Ok(project)
}

#[tauri::command]
pub async fn new_project(
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
    app: tauri::AppHandle,
) -> Result<ProjectFile, String> {
    state.new_project("Untitled Project");
    sync_render_state(&state, &render);
    let _ = ensure_main_window_resizable(&app);
    let _ = apply_projector_aspect_lock(&app, &state);
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
    Ok(input.write().refresh_all_sources())
}

/// Sync installed shader descriptors (from local library) into the shader backend.
#[tauri::command]
pub async fn set_installed_shader_sources(
    sources: Vec<InstalledShaderSource>,
    input: State<'_, Arc<parking_lot::RwLock<crate::input::adapter::InputManager>>>,
) -> Result<usize, String> {
    Ok(input.write().set_installed_shaders(sources))
}

#[tauri::command]
pub async fn list_audio_input_devices(
    bpm: State<'_, Arc<parking_lot::Mutex<BpmEngine>>>,
) -> Result<Vec<AudioInputDevice>, String> {
    Ok(bpm.lock().list_input_devices())
}

#[tauri::command]
pub async fn set_audio_input_device(
    device_id: String,
    bpm: State<'_, Arc<parking_lot::Mutex<BpmEngine>>>,
) -> Result<BpmState, String> {
    bpm.lock().set_audio_input_device(&device_id)
}

#[tauri::command]
pub async fn set_bpm_config(
    config: BpmConfig,
    bpm: State<'_, Arc<parking_lot::Mutex<BpmEngine>>>,
) -> Result<BpmState, String> {
    bpm.lock().set_bpm_config(config)
}

#[tauri::command]
pub async fn get_bpm_state(
    bpm: State<'_, Arc<parking_lot::Mutex<BpmEngine>>>,
) -> Result<BpmState, String> {
    Ok(bpm.lock().get_bpm_state())
}

#[tauri::command]
pub async fn tap_tempo(
    bpm: State<'_, Arc<parking_lot::Mutex<BpmEngine>>>,
) -> Result<BpmState, String> {
    Ok(bpm.lock().tap_tempo())
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

        let message = if bridge_available {
            "Syphon is ready. Syphon servers should appear automatically.".to_string()
        } else {
            "Syphon.framework is bundled but could not be loaded. \
             Check the application log for details."
                .to_string()
        };

        log::debug!(
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

/// Try to reload Syphon.framework at runtime.
///
/// The framework is built at compile time by build.rs and bundled with the app.
/// This command just retries dlopen() in case it wasn't loaded on startup.
#[tauri::command]
pub async fn install_syphon_framework() -> Result<String, String> {
    #[cfg(all(target_os = "macos", feature = "input-syphon"))]
    {
        let loaded = crate::input::syphon::try_reload();
        if loaded {
            Ok("Syphon.framework loaded successfully. Refresh sources to see Syphon servers."
                .to_string())
        } else {
            Err("Syphon.framework could not be loaded. Check the application log for details."
                .to_string())
        }
    }

    #[cfg(not(all(target_os = "macos", feature = "input-syphon")))]
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
    app: tauri::AppHandle,
) -> Result<(), String> {
    *render.output_width.write() = config.width;
    *render.output_height.write() = config.height;
    state.set_output_config(config);
    render.request_redraw();
    let _ = ensure_main_window_resizable(&app);
    let _ = apply_projector_aspect_lock(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn set_project_ui_state(
    ui_state: serde_json::Value,
    state: State<'_, SceneState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    state.set_ui_state(ui_state);
    let _ = ensure_main_window_resizable(&app);
    let _ = apply_projector_aspect_lock(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn set_main_window_fullscreen(
    app: tauri::AppHandle,
    state: State<'_, SceneState>,
    fullscreen: bool,
) -> Result<(), String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    win.set_fullscreen(fullscreen).map_err(|e| e.to_string())?;
    if !fullscreen {
        let _ = ensure_main_window_resizable(&app);
        let _ = apply_projector_aspect_lock(&app, &state);
    }
    Ok(())
}

#[tauri::command]
pub async fn get_main_window_fullscreen(app: tauri::AppHandle) -> Result<bool, String> {
    let win = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    win.is_fullscreen().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sync_main_window_aspect(
    app: tauri::AppHandle,
    state: State<'_, SceneState>,
) -> Result<(), String> {
    ensure_main_window_resizable(&app)?;
    apply_projector_aspect_lock(&app, &state)?;
    Ok(())
}

// =============================================================================
// Frame preview — returns raw RGBA pixels for a layer's source
// =============================================================================

/// Max preview dimension — frames are downscaled to this before base64 encoding.
/// Keeps IPC payload small (~40KB instead of ~1.2MB per frame).
pub(crate) const PREVIEW_MAX_DIM: u32 = 96;

/// Response carrying a frame snapshot for the frontend to paint
#[derive(Serialize, Clone)]
pub struct FrameSnapshot {
    pub width: u32,
    pub height: u32,
    /// RGBA pixels as base64-encoded data
    pub data_b64: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct PreviewConsumers {
    pub editor: bool,
    pub projector_fallback: bool,
}

impl Default for PreviewConsumers {
    fn default() -> Self {
        Self {
            editor: false,
            projector_fallback: false,
        }
    }
}

#[derive(Serialize, Clone)]
pub struct PreviewDelta {
    pub cursor: u64,
    pub removed_layer_ids: Vec<String>,
    pub changed: std::collections::HashMap<String, Arc<FrameSnapshot>>,
}

/// Shared preview frame cache — populated by the frame pump thread,
/// read by poll_all_frames. Uses Arc<FrameSnapshot> so cloning the map
/// for IPC is a refcount bump (~16 bytes) instead of deep-cloning ~76KB
/// base64 strings per source.
pub struct PreviewCache {
    pub frames: parking_lot::RwLock<std::collections::HashMap<String, Arc<FrameSnapshot>>>,
    pub frame_versions: parking_lot::RwLock<std::collections::HashMap<String, u64>>,
    pub removed_versions: parking_lot::RwLock<std::collections::HashMap<String, u64>>,
    pub cursor: AtomicU64,
    pub consumers: parking_lot::RwLock<PreviewConsumers>,
}

impl PreviewCache {
    pub fn new() -> Self {
        Self {
            frames: parking_lot::RwLock::new(std::collections::HashMap::new()),
            frame_versions: parking_lot::RwLock::new(std::collections::HashMap::new()),
            removed_versions: parking_lot::RwLock::new(std::collections::HashMap::new()),
            cursor: AtomicU64::new(1),
            consumers: parking_lot::RwLock::new(PreviewConsumers::default()),
        }
    }

    pub fn has_consumers(&self) -> bool {
        let consumers = self.consumers.read();
        consumers.editor || consumers.projector_fallback
    }
}

/// Downsample RGBA frame using nearest-neighbor. Fast, no deps needed.
pub(crate) fn downsample_rgba(
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
pub(crate) fn preview_dims(w: u32, h: u32) -> (u32, u32) {
    if w <= PREVIEW_MAX_DIM && h <= PREVIEW_MAX_DIM {
        return (w, h);
    }
    let scale = PREVIEW_MAX_DIM as f32 / w.max(h) as f32;
    let nw = ((w as f32 * scale) as u32).max(1);
    let nh = ((h as f32 * scale) as u32).max(1);
    (nw, nh)
}

/// Encode a frame to a FrameSnapshot, downscaling for IPC efficiency.
///
/// BGRA frames are downsampled first (8MB → 57KB), then swizzled to RGBA
/// on the small preview buffer. This is ~140x cheaper than swizzling the
/// full-resolution source frame.
pub(crate) fn encode_frame(f: &crate::input::adapter::FramePacket) -> FrameSnapshot {
    use base64::Engine;
    use crate::input::adapter::PixelFormat;

    let (pw, ph) = preview_dims(f.width, f.height);
    let mut data = if pw == f.width && ph == f.height {
        f.data.clone()
    } else {
        // downsample_rgba works on any 4-byte-per-pixel layout (RGBA or BGRA)
        downsample_rgba(&f.data, f.width, f.height, pw, ph)
    };

    // BGRA→RGBA swizzle on the small preview buffer (57KB vs 8MB)
    if f.pixel_format == PixelFormat::Bgra8 {
        for chunk in data.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }
    }

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
/// Returns a map of layer_id -> FrameSnapshot.
///
/// This reads from the PreviewCache (populated by the frame pump thread)
/// instead of re-polling Metal/Syphon sources — eliminates the ~160ms
/// GPU readback that was making the editor preview lag at 5fps.
///
/// Uses Arc<FrameSnapshot> internally so cloning for IPC is a refcount
/// bump instead of deep-cloning ~76KB base64 strings per source.
#[tauri::command]
pub async fn poll_all_frames(
    cache: State<'_, Arc<PreviewCache>>,
) -> Result<std::collections::HashMap<String, Arc<FrameSnapshot>>, String> {
    let frames = cache.frames.read();
    Ok(frames.clone())
}

#[tauri::command]
pub async fn poll_all_frames_delta(
    cursor: u64,
    cache: State<'_, Arc<PreviewCache>>,
) -> Result<PreviewDelta, String> {
    let current_cursor = cache.cursor.load(Ordering::Acquire);
    let frames = cache.frames.read();
    let frame_versions = cache.frame_versions.read();
    let removed_versions = cache.removed_versions.read();

    let mut changed = std::collections::HashMap::new();
    for (layer_id, version) in frame_versions.iter() {
        if *version > cursor {
            if let Some(snapshot) = frames.get(layer_id) {
                changed.insert(layer_id.clone(), snapshot.clone());
            }
        }
    }

    let removed_layer_ids = removed_versions
        .iter()
        .filter_map(|(layer_id, version)| {
            if *version > cursor {
                Some(layer_id.clone())
            } else {
                None
            }
        })
        .collect();

    Ok(PreviewDelta {
        cursor: current_cursor,
        removed_layer_ids,
        changed,
    })
}

#[tauri::command]
pub async fn set_preview_consumers(
    editor: Option<bool>,
    projector_fallback: Option<bool>,
    cache: State<'_, Arc<PreviewCache>>,
) -> Result<PreviewConsumers, String> {
    {
        let mut consumers = cache.consumers.write();
        if let Some(v) = editor {
            consumers.editor = v;
        }
        if let Some(v) = projector_fallback {
            consumers.projector_fallback = v;
        }
    }

    // Keep frame/versions cache warm when consumers toggle off.
    // Stale entry cleanup is handled by the frame pump using current layer bindings.
    Ok(*cache.consumers.read())
}

#[derive(Serialize, Clone)]
pub struct ProjectSnapshotWithRevision {
    pub revision: u64,
    pub project: ProjectFile,
}

#[tauri::command]
pub async fn get_project_if_changed(
    revision: u64,
    state: State<'_, SceneState>,
) -> Result<Option<ProjectSnapshotWithRevision>, String> {
    let current = state.revision();
    if current <= revision {
        return Ok(None);
    }

    Ok(Some(ProjectSnapshotWithRevision {
        revision: current,
        project: state.get_project_snapshot(),
    }))
}

// =============================================================================
// Render stats (for StatusBar)
// =============================================================================

#[derive(Serialize)]
pub struct RenderStats {
    pub gpu_name: String,
    pub gpu_ready: bool,
    pub gpu_backend: String,
    pub gpu_driver: String,
    pub gpu_device_type: String,
    pub frame_pacing: String,
    pub texture_count: usize,
    pub buffer_cache_hits: u64,
    pub buffer_cache_misses: u64,
}

#[tauri::command]
pub async fn get_render_stats(
    app: tauri::AppHandle,
    render: State<'_, Arc<RenderState>>,
) -> Result<RenderStats, String> {
    let engine_state = app
        .try_state::<Arc<parking_lot::RwLock<crate::renderer::engine::RenderEngine>>>();

    match engine_state {
        Some(engine_lock) => {
            let engine = engine_lock.read();
            let info = engine.gpu.adapter.get_info();
            let pacing = render.frame_pacing.read();
            Ok(RenderStats {
                gpu_name: info.name.clone(),
                gpu_ready: true,
                gpu_backend: format!("{:?}", info.backend),
                gpu_driver: info.driver.clone(),
                gpu_device_type: format!("{:?}", info.device_type),
                frame_pacing: pacing.label().to_string(),
                texture_count: engine.texture_manager.source_texture_count(),
                buffer_cache_hits: engine.buffer_cache.stats.hits,
                buffer_cache_misses: engine.buffer_cache.stats.misses,
            })
        }
        None => Ok(RenderStats {
            gpu_name: "Initializing GPU...".to_string(),
            gpu_ready: false,
            gpu_backend: String::new(),
            gpu_driver: String::new(),
            gpu_device_type: String::new(),
            frame_pacing: String::new(),
            texture_count: 0,
            buffer_cache_hits: 0,
            buffer_cache_misses: 0,
        }),
    }
}

// =============================================================================
// Source diagnostics
// =============================================================================

#[derive(Serialize)]
pub struct SourceDiagnostics {
    pub source_id: String,
    pub name: String,
    pub protocol: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub layers_using: Vec<String>,
}

#[tauri::command]
pub async fn get_source_diagnostics(
    input: State<'_, Arc<parking_lot::RwLock<crate::input::adapter::InputManager>>>,
) -> Result<Vec<SourceDiagnostics>, String> {
    let mgr = input.read();
    let sources = mgr.list_all_sources();
    let bound_ids = mgr.bound_layer_ids();

    let diagnostics: Vec<SourceDiagnostics> = sources
        .into_iter()
        .map(|src| {
            let layers_using: Vec<String> = bound_ids
                .iter()
                .filter(|layer_id| mgr.get_binding(layer_id) == Some(&src.id))
                .cloned()
                .collect();

            SourceDiagnostics {
                source_id: src.id,
                name: src.name,
                protocol: src.protocol,
                width: src.width,
                height: src.height,
                fps: src.fps,
                layers_using,
            }
        })
        .collect();

    Ok(diagnostics)
}

// =============================================================================
// Frame pacing
// =============================================================================

#[tauri::command]
pub async fn set_frame_pacing(
    mode: crate::renderer::gpu::FramePacingMode,
    render: State<'_, Arc<RenderState>>,
) -> Result<(), String> {
    *render.frame_pacing.write() = mode;
    log::info!("Frame pacing set to {:?}", mode);
    Ok(())
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
// Mesh face operations (Phases 4, 5, 7, 8)
// =============================================================================

#[tauri::command]
pub async fn toggle_face_mask(
    layer_id: String,
    face_indices: Vec<usize>,
    masked: bool,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let ok = state.toggle_face_mask(&layer_id, face_indices, masked);
    if ok { sync_render_state(&state, &render); }
    Ok(ok)
}

#[tauri::command]
pub async fn create_face_group(
    layer_id: String,
    name: String,
    face_indices: Vec<usize>,
    color: String,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let ok = state.create_face_group(&layer_id, name, face_indices, color);
    if ok { sync_render_state(&state, &render); }
    Ok(ok)
}

#[tauri::command]
pub async fn remove_face_group(
    layer_id: String,
    group_index: usize,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let ok = state.remove_face_group(&layer_id, group_index);
    if ok { sync_render_state(&state, &render); }
    Ok(ok)
}

#[tauri::command]
pub async fn rename_face_group(
    layer_id: String,
    group_index: usize,
    name: String,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let ok = state.rename_face_group(&layer_id, group_index, name);
    if ok { sync_render_state(&state, &render); }
    Ok(ok)
}

#[tauri::command]
pub async fn set_calibration_target(
    target: Option<CalibrationTarget>,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<(), String> {
    state.set_calibration_target(target);
    sync_render_state(&state, &render);
    Ok(())
}

#[tauri::command]
pub async fn set_face_uv_override(
    layer_id: String,
    face_index: usize,
    adjustment: UvAdjustment,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let ok = state.set_face_uv_override(&layer_id, face_index, adjustment);
    if ok { sync_render_state(&state, &render); }
    Ok(ok)
}

#[tauri::command]
pub async fn clear_face_uv_override(
    layer_id: String,
    face_index: usize,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<bool, String> {
    let ok = state.clear_face_uv_override(&layer_id, face_index);
    if ok { sync_render_state(&state, &render); }
    Ok(ok)
}

#[tauri::command]
pub async fn subdivide_mesh(
    layer_id: String,
    state: State<'_, SceneState>,
    render: State<'_, Arc<RenderState>>,
) -> Result<Option<LayerGeometry>, String> {
    let new_geometry = state.subdivide_mesh(&layer_id);
    if new_geometry.is_some() { sync_render_state(&state, &render); }
    Ok(new_geometry)
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
