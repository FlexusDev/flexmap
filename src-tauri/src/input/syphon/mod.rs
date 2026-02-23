//! Syphon input backend for macOS.
//!
//! Uses an Objective-C bridge (bridge.m) that dynamically loads Syphon.framework
//! at runtime via dlopen(). No framework is needed at build time.
//!
//! If Syphon.framework is not installed, the backend reports no sources.
//! Users can install the framework from the UI, then call `try_reload()`
//! to pick it up without restarting the app.

use super::adapter::*;
use std::collections::{HashMap, HashSet};

// ─── FFI declarations (match bridge.h) ──────────────────────────────────────

mod ffi {
    use std::os::raw::c_char;

    /// Must match SyphonServerInfo in bridge.h
    #[repr(C)]
    pub struct SyphonServerInfo {
        pub name: [c_char; 256],
        pub app_name: [c_char; 256],
        pub uuid: [c_char; 256],
    }

    /// Opaque handle to a SyphonMetalClient wrapper.
    pub type SyphonClientHandle = *mut std::ffi::c_void;

    extern "C" {
        pub fn syphon_is_available() -> i32;
        pub fn syphon_try_load() -> i32;
        pub fn syphon_list_servers(out: *mut SyphonServerInfo, max: i32) -> i32;
        pub fn syphon_create_client(uuid: *const c_char) -> SyphonClientHandle;
        pub fn syphon_has_new_frame(client: SyphonClientHandle) -> i32;
        pub fn syphon_get_frame_info(
            client: SyphonClientHandle,
            width: *mut u32,
            height: *mut u32,
            is_bgra: *mut i32,
        );
        pub fn syphon_copy_frame_pixels(
            client: SyphonClientHandle,
            out_buffer: *mut u8,
            buffer_size: u32,
        ) -> i32;
        pub fn syphon_destroy_client(client: SyphonClientHandle);
    }
}

// ─── Helper: C string → Rust String ─────────────────────────────────────────

fn c_chars_to_string(buf: &[std::os::raw::c_char]) -> String {
    let bytes: Vec<u8> = buf
        .iter()
        .take_while(|&&b| b != 0)
        .map(|&b| b as u8)
        .collect();
    String::from_utf8_lossy(&bytes).to_string()
}

// ─── Syphon server snapshot ─────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct ServerSnapshot {
    name: String,
    app_name: String,
    uuid: String,
}

fn discover_servers() -> Vec<ServerSnapshot> {
    if unsafe { ffi::syphon_is_available() } == 0 {
        log::debug!("Syphon: framework not loaded — cannot discover servers");
        return Vec::new();
    }

    log::info!("Syphon: scanning for servers via SyphonServerDirectory...");
    const MAX: i32 = 32;
    let mut buf = Vec::with_capacity(MAX as usize);
    for _ in 0..MAX {
        buf.push(ffi::SyphonServerInfo {
            name: [0; 256],
            app_name: [0; 256],
            uuid: [0; 256],
        });
    }

    let count = unsafe { ffi::syphon_list_servers(buf.as_mut_ptr(), MAX) };
    log::info!("Syphon: syphon_list_servers returned {} server(s)", count);
    let count = count.max(0) as usize;

    buf.truncate(count);
    let servers: Vec<ServerSnapshot> = buf
        .iter()
        .map(|s| {
            let snap = ServerSnapshot {
                name: c_chars_to_string(&s.name),
                app_name: c_chars_to_string(&s.app_name),
                uuid: c_chars_to_string(&s.uuid),
            };
            log::info!(
                "Syphon: found server name={:?} app={:?} uuid={:?}",
                snap.name,
                snap.app_name,
                snap.uuid
            );
            snap
        })
        .filter(|s| !s.uuid.is_empty())
        .collect();
    servers
}

// ─── Per-source client state ────────────────────────────────────────────────

struct ActiveClient {
    handle: ffi::SyphonClientHandle,
    #[allow(dead_code)]
    uuid: String,
    #[allow(dead_code)]
    width: u32,
    #[allow(dead_code)]
    height: u32,
    #[allow(dead_code)]
    is_bgra: bool,
    #[allow(dead_code)]
    pixel_buf: Vec<u8>,
}

impl Drop for ActiveClient {
    fn drop(&mut self) {
        log::info!("Syphon: destroying client for uuid={}", self.uuid);
        unsafe {
            if !self.handle.is_null() {
                ffi::syphon_destroy_client(self.handle);
            }
        }
    }
}

// ─── InputBackend implementation ────────────────────────────────────────────

pub struct SyphonBackend {
    sources: Vec<SourceInfo>,
    active_sources: HashSet<String>,
    clients: HashMap<String, ActiveClient>,
    frame_cache: HashMap<String, CachedFrame>,
    sequence_counters: HashMap<String, u64>,
    last_discovery: std::time::Instant,
    bridge_available: bool,
}

#[allow(dead_code)]
struct CachedFrame {
    width: u32,
    height: u32,
    rgba_data: Vec<u8>,
}

// SyphonBackend holds raw pointers that are accessed only through RwLock<InputManager>
unsafe impl Send for SyphonBackend {}
unsafe impl Sync for SyphonBackend {}

/// Check whether the Syphon framework is loaded at runtime.
pub fn is_bridge_available() -> bool {
    unsafe { ffi::syphon_is_available() != 0 }
}

/// Try to (re-)load Syphon.framework at runtime.
/// Call this after the user installs the framework.
/// Returns true if Syphon is now available.
pub fn try_reload() -> bool {
    let result = unsafe { ffi::syphon_try_load() } != 0;
    if result {
        log::info!("Syphon: framework loaded successfully via try_reload()");
    } else {
        log::warn!("Syphon: try_reload() — framework still not available");
    }
    result
}

/// Return a list of framework search paths (for diagnostics).
pub fn framework_search_paths() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    vec![
        format!("{}/Library/Frameworks/Syphon.framework", home),
        "/Library/Frameworks/Syphon.framework".to_string(),
        "/Applications/Synesthesia.app/Contents/Frameworks/Syphon.framework".to_string(),
        "/Applications/Resolume Arena.app/Contents/Frameworks/Syphon.framework".to_string(),
        "/Applications/VDMX5.app/Contents/Frameworks/Syphon.framework".to_string(),
        "/Applications/MadMapper.app/Contents/Frameworks/Syphon.framework".to_string(),
    ]
}

impl SyphonBackend {
    pub fn new() -> Self {
        let bridge_available = is_bridge_available();

        if bridge_available {
            log::info!("Syphon: framework loaded — Metal client ready");
        } else {
            log::warn!(
                "Syphon: framework NOT loaded. Install Syphon.framework and click 'Install Syphon' in the app."
            );

            // Log which paths we checked
            for path in framework_search_paths() {
                let exists = std::path::Path::new(&path).exists();
                log::info!("Syphon: search path {:?} exists={}", path, exists);
            }
        }

        let mut backend = Self {
            sources: Vec::new(),
            active_sources: HashSet::new(),
            clients: HashMap::new(),
            frame_cache: HashMap::new(),
            sequence_counters: HashMap::new(),
            last_discovery: std::time::Instant::now()
                - std::time::Duration::from_secs(10),
            bridge_available,
        };

        backend.refresh_sources();
        backend
    }

    fn refresh_sources(&mut self) {
        self.last_discovery = std::time::Instant::now();

        // If bridge wasn't available before, try again (maybe user just installed it)
        if !self.bridge_available {
            self.bridge_available = is_bridge_available();
            if !self.bridge_available {
                log::debug!("Syphon: skipping refresh — framework not loaded");
                return;
            }
            log::info!("Syphon: framework became available!");
        }

        let servers = discover_servers();
        log::info!(
            "Syphon: refresh complete — {} server(s) discovered",
            servers.len()
        );

        self.sources = servers
            .iter()
            .map(|s| {
                let display = if s.app_name.is_empty() {
                    s.name.clone()
                } else if s.name.is_empty() {
                    s.app_name.clone()
                } else {
                    format!("{} — {}", s.app_name, s.name)
                };

                SourceInfo {
                    id: format!("syphon:{}", s.uuid),
                    name: display,
                    protocol: "syphon".to_string(),
                    width: None,
                    height: None,
                    fps: None,
                }
            })
            .collect();

        for src in &self.sources {
            log::info!(
                "Syphon: source available: id={} name={:?}",
                src.id,
                src.name
            );
        }
    }

    fn ensure_client(&mut self, source_id: &str) -> bool {
        if self.clients.contains_key(source_id) {
            return true;
        }

        let uuid = match source_id.strip_prefix("syphon:") {
            Some(u) => u,
            None => {
                log::warn!("Syphon: invalid source_id format: {}", source_id);
                return false;
            }
        };

        log::info!("Syphon: creating Metal client for uuid={}", uuid);
        let c_uuid = std::ffi::CString::new(uuid).unwrap_or_default();
        let handle = unsafe { ffi::syphon_create_client(c_uuid.as_ptr()) };

        if handle.is_null() {
            log::error!(
                "Syphon: syphon_create_client returned NULL for uuid={}",
                uuid
            );
            return false;
        }

        log::info!("Syphon: Metal client created successfully for uuid={}", uuid);
        self.clients.insert(
            source_id.to_string(),
            ActiveClient {
                handle,
                uuid: uuid.to_string(),
                width: 0,
                height: 0,
                is_bgra: true,
                pixel_buf: Vec::new(),
            },
        );
        true
    }

    fn return_cached_frame(&self, source_id: &str) -> Option<FramePacket> {
        let cached = self.frame_cache.get(source_id)?;
        let seq = self.sequence_counters.get(source_id).copied().unwrap_or(0);
        Some(FramePacket {
            width: cached.width,
            height: cached.height,
            pixel_format: PixelFormat::Rgba8,
            data: cached.rgba_data.clone(),
            timestamp: None,
            sequence: Some(seq),
        })
    }
}

impl InputBackend for SyphonBackend {
    fn protocol_name(&self) -> &str {
        "syphon"
    }

    fn list_sources(&self) -> Vec<SourceInfo> {
        self.sources.clone()
    }

    fn connect(&mut self, source_id: &str) -> Result<(), InputError> {
        log::info!("Syphon: connect requested for {}", source_id);

        if !self.bridge_available {
            // One more try — maybe it was just installed
            self.bridge_available = try_reload();
        }

        if !self.bridge_available {
            log::error!("Syphon: cannot connect — framework not loaded");
            return Err(InputError::ConnectionFailed(
                "Syphon.framework not installed. Use the Install Syphon button in Sources panel."
                    .into(),
            ));
        }

        self.refresh_sources();

        if !self.sources.iter().any(|s| s.id == source_id) {
            log::error!(
                "Syphon: source {} not found in {} available sources",
                source_id,
                self.sources.len()
            );
            return Err(InputError::SourceNotFound(source_id.to_string()));
        }

        if !self.ensure_client(source_id) {
            return Err(InputError::ConnectionFailed(format!(
                "Failed to create SyphonMetalClient for {}",
                source_id
            )));
        }

        self.active_sources.insert(source_id.to_string());
        log::info!(
            "Syphon: source connected: {} (active count: {})",
            source_id,
            self.active_sources.len()
        );
        Ok(())
    }

    fn disconnect(&mut self) {
        log::info!(
            "Syphon: disconnecting all ({} active)",
            self.active_sources.len()
        );
        self.active_sources.clear();
        self.clients.clear();
        self.frame_cache.clear();
        self.sequence_counters.clear();
    }

    fn disconnect_source(&mut self, source_id: &str) {
        log::info!("Syphon: disconnecting source {}", source_id);
        self.active_sources.remove(source_id);
        self.clients.remove(source_id);
        self.frame_cache.remove(source_id);
        self.sequence_counters.remove(source_id);
    }

    fn poll_frame(&mut self) -> Option<FramePacket> {
        let first = self.active_sources.iter().next()?.clone();
        self.poll_frame_for_source(&first)
    }

    fn poll_frame_for_source(&mut self, source_id: &str) -> Option<FramePacket> {
        if !self.active_sources.contains(source_id) {
            return None;
        }

        if self.last_discovery.elapsed() > std::time::Duration::from_secs(2) {
            self.refresh_sources();
        }

        if !self.ensure_client(source_id) {
            return self.return_cached_frame(source_id);
        }

        let client = match self.clients.get_mut(source_id) {
            Some(c) => c,
            None => return self.return_cached_frame(source_id),
        };

        let has_new = unsafe { ffi::syphon_has_new_frame(client.handle) } != 0;
        if !has_new {
            return self.return_cached_frame(source_id);
        }

        let mut width: u32 = 0;
        let mut height: u32 = 0;
        let mut is_bgra: i32 = 1;
        unsafe {
            ffi::syphon_get_frame_info(
                client.handle,
                &mut width,
                &mut height,
                &mut is_bgra,
            );
        }

        if width == 0 || height == 0 {
            log::debug!("Syphon: frame has zero dimensions for {}", source_id);
            return self.return_cached_frame(source_id);
        }

        client.width = width;
        client.height = height;
        client.is_bgra = is_bgra != 0;

        let total_bytes = (width * height * 4) as usize;
        client.pixel_buf.resize(total_bytes, 0);

        let result = unsafe {
            ffi::syphon_copy_frame_pixels(
                client.handle,
                client.pixel_buf.as_mut_ptr(),
                total_bytes as u32,
            )
        };

        if result != 1 {
            log::debug!(
                "Syphon: syphon_copy_frame_pixels returned {} for {}",
                result,
                source_id
            );
            return self.return_cached_frame(source_id);
        }

        // BGRA → RGBA swizzle if needed
        let mut rgba_data = client.pixel_buf.clone();
        if client.is_bgra {
            for chunk in rgba_data.chunks_exact_mut(4) {
                chunk.swap(0, 2);
            }
        }

        let counter = self
            .sequence_counters
            .entry(source_id.to_string())
            .or_insert(0);
        *counter += 1;
        let seq = *counter;

        // Log first frame details
        if seq == 1 {
            log::info!(
                "Syphon: first frame from {} — {}x{} bgra={} ({} bytes)",
                source_id,
                width,
                height,
                client.is_bgra,
                total_bytes
            );
        }

        let packet = FramePacket {
            width,
            height,
            pixel_format: PixelFormat::Rgba8,
            data: rgba_data.clone(),
            timestamp: None,
            sequence: Some(seq),
        };

        self.frame_cache.insert(
            source_id.to_string(),
            CachedFrame {
                width,
                height,
                rgba_data,
            },
        );

        Some(packet)
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
}

impl Default for SyphonBackend {
    fn default() -> Self {
        Self::new()
    }
}
