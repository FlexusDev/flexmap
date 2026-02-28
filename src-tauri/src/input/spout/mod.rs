//! Spout 2 input backend for Windows.
//!
//! Pure-Rust implementation of the Spout2 shared-memory protocol:
//!   1. Sender discovery — reads "SpoutSenderNames" shared-memory map
//!   2. Per-sender info — reads each sender's texture metadata (width, height, DXGI handle)
//!   3. Frame capture — opens the DXGI shared handle via D3D11, copies to staging, reads RGBA8
//!
//! No external Spout DLLs required — only Win32 + D3D11 system APIs.
//!
//! Multi-source: multiple senders can be active simultaneously (one per layer).

use super::adapter::*;
use std::collections::{HashMap, HashSet};

use windows::{
    core::PCSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE, HMODULE},
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_11_0},
            Direct3D11::*,
            Dxgi::Common::*,
        },
        System::Memory::*,
    },
};

// ─── Spout2 shared memory constants ─────────────────────────────────────────

/// Maximum number of simultaneous Spout senders.
const SPOUT_MAX_SENDERS: usize = 10;

/// Each sender name slot is 256 bytes (null-padded ASCII).
const SPOUT_SENDER_NAME_LEN: usize = 256;

/// Name of the shared memory map that contains the list of sender names.
const SENDER_NAMES_MAP: &[u8] = b"SpoutSenderNames\0";

// ─── Per-sender shared texture info ─────────────────────────────────────────

/// Layout of the per-sender shared-memory struct.
/// Must match Spout2's `SharedTextureInfo` byte-for-byte.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct SharedTextureInfo {
    /// DXGI shared texture handle (32-bit index, not a pointer)
    share_handle: u32,
    /// Texture width in pixels
    width: u32,
    /// Texture height in pixels
    height: u32,
    /// DXGI_FORMAT value (e.g. 87 = DXGI_FORMAT_B8G8R8A8_UNORM)
    format: u32,
    /// Usage flags (typically 0)
    usage: u32,
    /// Wide-char description (128 wchar_t = 256 bytes)
    description: [u16; 128],
    /// Partner process ID
    partner_id: u32,
}

/// Snapshot of a discovered Spout sender.
#[derive(Clone, Debug)]
struct SenderSnapshot {
    name: String,
    width: u32,
    height: u32,
    share_handle: u32,
    format: u32,
}

// ─── D3D11 receiver ─────────────────────────────────────────────────────────

/// Manages a D3D11 device for opening shared textures and reading pixels back.
struct D3D11Receiver {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    /// Cached staging texture — reused across frames if dimensions match.
    staging: Option<StagingTexture>,
}

struct StagingTexture {
    texture: ID3D11Texture2D,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
}

impl D3D11Receiver {
    fn new() -> Result<Self, String> {
        unsafe {
            let mut device = None;
            let mut context = None;

            D3D11CreateDevice(
                None,                                           // default adapter
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE(std::ptr::null_mut()),                  // no software rasterizer
                D3D11_CREATE_DEVICE_FLAG(0),                    // no special flags
                Some(&[D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(|e| format!("D3D11CreateDevice failed: {}", e))?;

            Ok(Self {
                device: device.ok_or("D3D11 device is None after creation")?,
                context: context.ok_or("D3D11 context is None after creation")?,
                staging: None,
            })
        }
    }

    /// Ensure the staging texture matches the required dimensions and format.
    /// Recreates only if the size or format changed.
    fn ensure_staging(
        &mut self,
        width: u32,
        height: u32,
        format: DXGI_FORMAT,
    ) -> Result<(), String> {
        let needs_recreate = match &self.staging {
            Some(s) => s.width != width || s.height != height || s.format != format,
            None => true,
        };

        if needs_recreate {
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: format,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };

            let texture = unsafe {
                let mut tex: Option<ID3D11Texture2D> = None;
                self.device
                    .CreateTexture2D(&desc, None, Some(&mut tex))
                    .map_err(|e| format!("CreateTexture2D (staging) failed: {}", e))?;
                tex.ok_or_else(|| "CreateTexture2D returned None".to_string())?
            };

            log::debug!(
                "Spout: created staging texture {}x{} format={}",
                width,
                height,
                format.0
            );

            self.staging = Some(StagingTexture {
                texture,
                width,
                height,
                format,
            });
        }

        Ok(())
    }

    /// Capture a frame from a Spout sender's shared DXGI texture.
    /// Returns RGBA8 pixel data.
    fn capture_frame(&mut self, info: &SenderSnapshot) -> Result<CachedFrame, String> {
        if info.share_handle == 0 || info.width == 0 || info.height == 0 {
            return Err("Invalid sender info (zero handle or dimensions)".into());
        }

        // windows 0.61: DXGI_FORMAT wraps i32
        let format = DXGI_FORMAT(info.format as i32);

        unsafe {
            // Open the DXGI shared texture handle from the sender process.
            // windows 0.61: HANDLE wraps *mut c_void; OpenSharedResource uses out-pointer.
            let handle = HANDLE(info.share_handle as usize as *mut core::ffi::c_void);
            let mut shared_tex: Option<ID3D11Texture2D> = None;
            if let Err(e) = self.device.OpenSharedResource(handle, &mut shared_tex) {
                log::warn!(
                    "[spout] OpenSharedResource failed for '{}' (handle=0x{:x}, fmt={}): {}",
                    info.name, info.share_handle, info.format, e
                );
                return Err(format!("OpenSharedResource failed: {}", e));
            }
            let shared_tex = match shared_tex {
                Some(t) => t,
                None => {
                    log::warn!("[spout] OpenSharedResource returned None for '{}'", info.name);
                    return Err("OpenSharedResource returned None".into());
                }
            };

            // Ensure staging texture is the right size
            if let Err(e) = self.ensure_staging(info.width, info.height, format) {
                log::warn!("[spout] ensure_staging failed for '{}': {}", info.name, e);
                return Err(e);
            }
            let staging = self.staging.as_ref().unwrap();

            // GPU-side copy: shared texture → staging texture
            self.context
                .CopyResource(&staging.texture, &shared_tex);

            // Map the staging texture for CPU read.
            // windows 0.61: Map uses an out-pointer for D3D11_MAPPED_SUBRESOURCE.
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            if let Err(e) = self.context.Map(&staging.texture, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) {
                log::warn!("[spout] Map staging texture failed for '{}': {}", info.name, e);
                return Err(format!("Map staging texture failed: {}", e));
            }

            let row_pitch = mapped.RowPitch as usize;
            let src_ptr = mapped.pData as *const u8;
            let pixel_row_bytes = info.width as usize * 4;
            let total_pixels = (info.width * info.height) as usize;
            let mut rgba_data = vec![0u8; total_pixels * 4];

            // Spout typically uses DXGI_FORMAT_B8G8R8A8_UNORM (87) or _SRGB (91).
            // We need to swizzle BGRA → RGBA for our pipeline.
            let is_bgra = info.format == 87 || info.format == 91;

            for y in 0..info.height as usize {
                let src_row = std::slice::from_raw_parts(
                    src_ptr.add(y * row_pitch),
                    pixel_row_bytes,
                );
                let dst_offset = y * pixel_row_bytes;

                if is_bgra {
                    // BGRA → RGBA swizzle
                    for x in 0..info.width as usize {
                        let si = x * 4;
                        let di = dst_offset + x * 4;
                        rgba_data[di] = src_row[si + 2];     // R ← B
                        rgba_data[di + 1] = src_row[si + 1]; // G ← G
                        rgba_data[di + 2] = src_row[si];     // B ← R
                        rgba_data[di + 3] = src_row[si + 3]; // A ← A
                    }
                } else {
                    // Already RGBA or similar — straight copy
                    rgba_data[dst_offset..dst_offset + pixel_row_bytes]
                        .copy_from_slice(src_row);
                }
            }

            self.context.Unmap(&staging.texture, 0);

            Ok(CachedFrame {
                width: info.width,
                height: info.height,
                rgba_data,
            })
        }
    }
}

// ─── Shared memory helpers ──────────────────────────────────────────────────

/// Read the list of active Spout senders from the shared memory map.
/// Returns empty if no Spout applications are running.
fn discover_senders() -> Vec<SenderSnapshot> {
    unsafe {
        let map_name = PCSTR::from_raw(SENDER_NAMES_MAP.as_ptr());

        // Open the existing shared memory (created by Spout senders).
        // Fails gracefully if no Spout apps are running.
        let handle = match OpenFileMappingA(FILE_MAP_READ.0, false, map_name) {
            Ok(h) => h,
            Err(_) => return Vec::new(),
        };

        let view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
        if view.Value.is_null() {
            let _ = CloseHandle(handle);
            return Vec::new();
        }

        let base = view.Value as *const u8;
        let mut senders = Vec::new();

        for i in 0..SPOUT_MAX_SENDERS {
            let name_ptr = base.add(i * SPOUT_SENDER_NAME_LEN);
            if *name_ptr == 0 {
                continue; // Empty slot
            }

            let name_bytes =
                std::slice::from_raw_parts(name_ptr, SPOUT_SENDER_NAME_LEN);
            let name_len = name_bytes
                .iter()
                .position(|&b| b == 0)
                .unwrap_or(SPOUT_SENDER_NAME_LEN);
            let name = String::from_utf8_lossy(&name_bytes[..name_len]).to_string();

            if let Some(info) = read_sender_info(&name) {
                senders.push(info);
            }
        }

        let _ = UnmapViewOfFile(view);
        let _ = CloseHandle(handle);

        senders
    }
}

/// Read a sender's texture metadata from its per-sender shared memory.
fn read_sender_info(name: &str) -> Option<SenderSnapshot> {
    unsafe {
        let mut map_name_buf = name.as_bytes().to_vec();
        map_name_buf.push(0); // null-terminate

        let handle = OpenFileMappingA(
            FILE_MAP_READ.0,
            false,
            PCSTR::from_raw(map_name_buf.as_ptr()),
        )
        .ok()?;

        let view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
        if view.Value.is_null() {
            let _ = CloseHandle(handle);
            return None;
        }

        let info_ptr = view.Value as *const SharedTextureInfo;
        let info = std::ptr::read_unaligned(info_ptr);

        let _ = UnmapViewOfFile(view);
        let _ = CloseHandle(handle);

        if info.width == 0 || info.height == 0 {
            return None;
        }

        Some(SenderSnapshot {
            name: name.to_string(),
            width: info.width,
            height: info.height,
            share_handle: info.share_handle,
            format: info.format,
        })
    }
}

// ─── Cached frame ───────────────────────────────────────────────────────────

struct CachedFrame {
    width: u32,
    height: u32,
    rgba_data: Vec<u8>,
}

// ─── InputBackend implementation ────────────────────────────────────────────

pub struct SpoutBackend {
    /// D3D11 device for shared texture access (None if init failed).
    d3d11: Option<D3D11Receiver>,
    /// Last-known source list (refreshed periodically).
    sources: Vec<SourceInfo>,
    /// Currently active (connected) source IDs.
    active_sources: HashSet<String>,
    /// Most recent captured frame per source (fallback if sender drops briefly).
    frame_cache: HashMap<String, CachedFrame>,
    /// Per-source frame sequence counters.
    sequence_counters: HashMap<String, u64>,
    /// Timestamp of last sender discovery scan.
    last_discovery: std::time::Instant,
}

// D3D11Receiver contains COM pointers which aren't Send/Sync by default,
// but SpoutBackend is only accessed through RwLock<InputManager> so a single
// thread touches D3D11 at any given time. This is safe.
unsafe impl Send for SpoutBackend {}
unsafe impl Sync for SpoutBackend {}

impl SpoutBackend {
    pub fn new() -> Self {
        let d3d11 = match D3D11Receiver::new() {
            Ok(r) => {
                log::info!("Spout D3D11 receiver initialized");
                Some(r)
            }
            Err(e) => {
                log::warn!(
                    "Spout D3D11 init failed: {}. Frame capture will be unavailable.",
                    e
                );
                None
            }
        };

        let mut backend = Self {
            d3d11,
            sources: Vec::new(),
            active_sources: HashSet::new(),
            frame_cache: HashMap::new(),
            sequence_counters: HashMap::new(),
            // Force immediate discovery on first list_sources / connect
            last_discovery: std::time::Instant::now()
                - std::time::Duration::from_secs(10),
        };

        backend.refresh_sources();
        backend
    }

    /// Scan Spout shared memory for available senders.
    fn refresh_sources(&mut self) {
        self.last_discovery = std::time::Instant::now();
        let senders = discover_senders();

        self.sources = senders
            .iter()
            .map(|s| SourceInfo {
                id: format!("spout:{}", s.name),
                name: s.name.clone(),
                protocol: "spout".to_string(),
                width: Some(s.width),
                height: Some(s.height),
                fps: None,
            })
            .collect();

        if !self.sources.is_empty() {
            log::debug!(
                "Spout: {} sender(s) found: {}",
                self.sources.len(),
                self.sources
                    .iter()
                    .map(|s| format!("{} ({}x{})", s.name, s.width.unwrap_or(0), s.height.unwrap_or(0)))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
    }
}

impl InputBackend for SpoutBackend {
    fn protocol_name(&self) -> &str {
        "spout"
    }

    fn list_sources(&self) -> Vec<SourceInfo> {
        self.sources.clone()
    }

    fn connect(&mut self, source_id: &str) -> Result<(), InputError> {
        if self.d3d11.is_none() {
            return Err(InputError::ConnectionFailed(
                "D3D11 not available — Spout capture requires DirectX 11".into(),
            ));
        }

        // Refresh to pick up the latest senders
        self.refresh_sources();

        if !self.sources.iter().any(|s| s.id == source_id) {
            return Err(InputError::SourceNotFound(source_id.to_string()));
        }

        self.active_sources.insert(source_id.to_string());
        log::info!(
            "Spout source connected: {} (active: {})",
            source_id,
            self.active_sources.len()
        );
        Ok(())
    }

    fn disconnect(&mut self) {
        self.active_sources.clear();
        self.frame_cache.clear();
        self.sequence_counters.clear();
        log::info!("All Spout sources disconnected");
    }

    fn disconnect_source(&mut self, source_id: &str) {
        self.active_sources.remove(source_id);
        self.frame_cache.remove(source_id);
        self.sequence_counters.remove(source_id);
        log::info!(
            "Spout source disconnected: {} (active: {})",
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

        // Periodically refresh sender list (every 2s)
        if self.last_discovery.elapsed() > std::time::Duration::from_secs(2) {
            self.refresh_sources();
        }

        let sender_name = source_id.strip_prefix("spout:")?;

        // Read current sender info from shared memory
        let sender_info = match read_sender_info(sender_name) {
            Some(info) => info,
            None => {
                // Sender gone — return last cached frame if we have one
                return self.return_cached_frame(source_id);
            }
        };

        // Capture frame via D3D11
        let d3d11 = self.d3d11.as_mut()?;
        match d3d11.capture_frame(&sender_info) {
            Ok(frame) => {
                let counter = self
                    .sequence_counters
                    .entry(source_id.to_string())
                    .or_insert(0);
                *counter += 1;
                let seq = *counter;

                let packet = FramePacket {
                    width: frame.width,
                    height: frame.height,
                    pixel_format: PixelFormat::Rgba8,
                    data: frame.rgba_data.clone(),
                    timestamp: None,
                    sequence: Some(seq),
                };

                self.frame_cache.insert(source_id.to_string(), frame);
                Some(packet)
            }
            Err(e) => {
                log::warn!("[spout] capture_frame failed for '{}': {}", sender_name, e);
                self.return_cached_frame(source_id)
            }
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

    fn refresh(&mut self) {
        self.refresh_sources();
    }
}

impl SpoutBackend {
    /// Return the last cached frame for a source (fallback when capture fails).
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

impl Default for SpoutBackend {
    fn default() -> Self {
        Self::new()
    }
}
