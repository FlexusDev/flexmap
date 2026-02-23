//! Syphon input backend for macOS.
//!
//! Uses an Objective-C bridge (bridge.m) compiled by build.rs to call the
//! Syphon framework's SyphonServerDirectory and SyphonMetalClient APIs.
//!
//! If Syphon.framework is not installed, the backend compiles but reports
//! no available sources at runtime.
//!
//! Multi-source: multiple Syphon servers can be active simultaneously.

use super::adapter::*;
use std::collections::{HashMap, HashSet};

// ─── FFI declarations (match bridge.h) ──────────────────────────────────────

#[cfg(has_syphon_bridge)]
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

#[cfg(has_syphon_bridge)]
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

#[cfg(has_syphon_bridge)]
fn discover_servers() -> Vec<ServerSnapshot> {
    const MAX: i32 = 32;
    let mut buf = Vec::with_capacity(MAX as usize);
    // Zero-init the structs
    for _ in 0..MAX {
        buf.push(ffi::SyphonServerInfo {
            name: [0; 256],
            app_name: [0; 256],
            uuid: [0; 256],
        });
    }

    let count = unsafe { ffi::syphon_list_servers(buf.as_mut_ptr(), MAX) };
    let count = count.max(0) as usize;

    buf.truncate(count);
    buf.iter()
        .map(|s| ServerSnapshot {
            name: c_chars_to_string(&s.name),
            app_name: c_chars_to_string(&s.app_name),
            uuid: c_chars_to_string(&s.uuid),
        })
        .filter(|s| !s.uuid.is_empty())
        .collect()
}

#[cfg(not(has_syphon_bridge))]
fn discover_servers() -> Vec<ServerSnapshot> {
    Vec::new() // No bridge linked
}

// ─── Per-source client state ────────────────────────────────────────────────

struct ActiveClient {
    #[cfg(has_syphon_bridge)]
    handle: ffi::SyphonClientHandle,
    uuid: String,
    width: u32,
    height: u32,
    is_bgra: bool,
    pixel_buf: Vec<u8>,
}

impl Drop for ActiveClient {
    fn drop(&mut self) {
        #[cfg(has_syphon_bridge)]
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

struct CachedFrame {
    width: u32,
    height: u32,
    rgba_data: Vec<u8>,
}

// SyphonBackend holds raw pointers that are accessed only through RwLock<InputManager>
unsafe impl Send for SyphonBackend {}
unsafe impl Sync for SyphonBackend {}

impl SyphonBackend {
    pub fn new() -> Self {
        let bridge_available;
        #[cfg(has_syphon_bridge)]
        {
            bridge_available = unsafe { ffi::syphon_is_available() } != 0;
        }
        #[cfg(not(has_syphon_bridge))]
        {
            bridge_available = false;
        }

        if bridge_available {
            log::info!("Syphon bridge loaded — Metal client ready");
        } else {
            log::info!(
                "Syphon bridge not available (framework not installed). \
                 Syphon sources will not be discovered."
            );
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

        if !self.bridge_available {
            return;
        }

        let servers = discover_servers();

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
                    width: None,  // dimensions unknown until connected
                    height: None,
                    fps: None,
                }
            })
            .collect();

        if !self.sources.is_empty() {
            log::debug!(
                "Syphon: {} server(s) found: {}",
                self.sources.len(),
                self.sources
                    .iter()
                    .map(|s| s.name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
    }

    #[cfg(has_syphon_bridge)]
    fn ensure_client(&mut self, source_id: &str) -> bool {
        if self.clients.contains_key(source_id) {
            return true;
        }

        let uuid = match source_id.strip_prefix("syphon:") {
            Some(u) => u,
            None => return false,
        };

        // Create null-terminated C string
        let c_uuid = std::ffi::CString::new(uuid).unwrap_or_default();
        let handle = unsafe { ffi::syphon_create_client(c_uuid.as_ptr()) };

        if handle.is_null() {
            log::warn!("Syphon: failed to create client for {}", source_id);
            return false;
        }

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

    #[cfg(not(has_syphon_bridge))]
    fn ensure_client(&mut self, _source_id: &str) -> bool {
        false
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
        if !self.bridge_available {
            return Err(InputError::ConnectionFailed(
                "Syphon.framework not installed — download from https://syphon.info"
                    .into(),
            ));
        }

        self.refresh_sources();

        if !self.sources.iter().any(|s| s.id == source_id) {
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
            "Syphon source connected: {} (active: {})",
            source_id,
            self.active_sources.len()
        );
        Ok(())
    }

    fn disconnect(&mut self) {
        self.active_sources.clear();
        self.clients.clear(); // Drop triggers syphon_destroy_client
        self.frame_cache.clear();
        self.sequence_counters.clear();
        log::info!("All Syphon sources disconnected");
    }

    fn disconnect_source(&mut self, source_id: &str) {
        self.active_sources.remove(source_id);
        self.clients.remove(source_id); // Drop triggers cleanup
        self.frame_cache.remove(source_id);
        self.sequence_counters.remove(source_id);
        log::info!(
            "Syphon source disconnected: {} (active: {})",
            source_id,
            self.active_sources.len()
        );
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

        #[cfg(has_syphon_bridge)]
        {
            // Ensure client exists
            if !self.ensure_client(source_id) {
                return self.return_cached_frame(source_id);
            }

            let client = match self.clients.get_mut(source_id) {
                Some(c) => c,
                None => return self.return_cached_frame(source_id),
            };

            // Check for new frame
            let has_new = unsafe { ffi::syphon_has_new_frame(client.handle) } != 0;
            if !has_new {
                return self.return_cached_frame(source_id);
            }

            // Get frame dimensions
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
                return self.return_cached_frame(source_id);
            }

            client.width = width;
            client.height = height;
            client.is_bgra = is_bgra != 0;

            // Allocate pixel buffer
            let total_bytes = (width * height * 4) as usize;
            client.pixel_buf.resize(total_bytes, 0);

            // Copy frame pixels
            let result = unsafe {
                ffi::syphon_copy_frame_pixels(
                    client.handle,
                    client.pixel_buf.as_mut_ptr(),
                    total_bytes as u32,
                )
            };

            if result != 1 {
                return self.return_cached_frame(source_id);
            }

            // BGRA → RGBA swizzle if needed
            let mut rgba_data = client.pixel_buf.clone();
            if client.is_bgra {
                for chunk in rgba_data.chunks_exact_mut(4) {
                    chunk.swap(0, 2); // swap R and B
                }
            }

            let counter = self
                .sequence_counters
                .entry(source_id.to_string())
                .or_insert(0);
            *counter += 1;
            let seq = *counter;

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

            return Some(packet);
        }

        #[cfg(not(has_syphon_bridge))]
        {
            None
        }
    }

    fn state(&self) -> SourceState {
        if self.active_sources.is_empty() {
            SourceState::Disconnected
        } else {
            SourceState::Connected
        }
    }

    fn connected_source(&self) -> Option<&SourceInfo> {
        None // Multi-source backend
    }

    fn is_source_active(&self, source_id: &str) -> bool {
        self.active_sources.contains(source_id)
    }
}

impl SyphonBackend {
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

impl Default for SyphonBackend {
    fn default() -> Self {
        Self::new()
    }
}
