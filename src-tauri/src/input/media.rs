// Media file input backend — loads image files (PNG, JPEG, GIF, BMP, WebP)
// as layer sources. Decodes once on connect, caches in memory, returns the
// same frame on each poll (static content).
//
// Multi-source: each registered file is a separate source that can be bound
// to different layers simultaneously.

use super::adapter::*;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Cached decoded image data
struct CachedImage {
    width: u32,
    height: u32,
    rgba_data: Vec<u8>,
}

/// A registered media file source
struct MediaSource {
    info: SourceInfo,
    path: PathBuf,
}

pub struct MediaFileBackend {
    /// All registered media file sources
    sources: Vec<MediaSource>,
    /// Currently active (connected) source IDs
    active_sources: HashSet<String>,
    /// Decoded pixel cache: source_id -> CachedImage
    cache: HashMap<String, CachedImage>,
    /// Per-source sequence counters
    source_counters: HashMap<String, u64>,
}

impl MediaFileBackend {
    pub fn new() -> Self {
        Self {
            sources: Vec::new(),
            active_sources: HashSet::new(),
            cache: HashMap::new(),
            source_counters: HashMap::new(),
        }
    }

    /// Register a media file as an available source.
    /// Reads dimensions from the file header (fast, no full decode).
    /// Returns the SourceInfo on success.
    pub fn register_file(&mut self, path: &Path) -> Result<SourceInfo, InputError> {
        // Validate file exists
        if !path.exists() {
            return Err(InputError::ConnectionFailed(format!(
                "File not found: {}",
                path.display()
            )));
        }

        // Generate source ID from filename
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("unknown");
        let source_id = format!("media:{}", filename);

        // Check if already registered
        if self.sources.iter().any(|s| s.info.id == source_id) {
            // Already registered — return existing info
            let existing = self.sources.iter().find(|s| s.info.id == source_id).unwrap();
            return Ok(existing.info.clone());
        }

        // Read image dimensions without full decode
        let reader = image::ImageReader::open(path)
            .map_err(|e| InputError::ConnectionFailed(format!("Cannot open image: {}", e)))?;
        let reader = reader.with_guessed_format()
            .map_err(|e| InputError::ConnectionFailed(format!("Cannot detect format: {}", e)))?;

        // We need to decode to get dimensions reliably across formats
        let img = reader
            .decode()
            .map_err(|e| InputError::ConnectionFailed(format!("Cannot decode image: {}", e)))?;

        let width = img.width();
        let height = img.height();

        // Pre-cache the decoded data since we already decoded it
        let rgba = img.to_rgba8();
        self.cache.insert(
            source_id.clone(),
            CachedImage {
                width,
                height,
                rgba_data: rgba.into_raw(),
            },
        );

        let info = SourceInfo {
            id: source_id.clone(),
            name: filename.to_string(),
            protocol: "media".to_string(),
            width: Some(width),
            height: Some(height),
            fps: None, // static image
        };

        self.sources.push(MediaSource {
            info: info.clone(),
            path: path.to_path_buf(),
        });

        log::info!(
            "Media file registered: {} ({}x{}) from {}",
            filename,
            width,
            height,
            path.display()
        );

        Ok(info)
    }

    /// Remove a registered media file source.
    pub fn remove_file(&mut self, source_id: &str) -> bool {
        let before = self.sources.len();
        self.sources.retain(|s| s.info.id != source_id);
        self.active_sources.remove(source_id);
        self.cache.remove(source_id);
        self.source_counters.remove(source_id);
        self.sources.len() < before
    }

    /// Decode an image file to RGBA8 pixels.
    fn decode_image(path: &Path) -> Result<CachedImage, InputError> {
        let img = image::ImageReader::open(path)
            .map_err(|e| InputError::FrameError(format!("Cannot open: {}", e)))?
            .with_guessed_format()
            .map_err(|e| InputError::FrameError(format!("Cannot detect format: {}", e)))?
            .decode()
            .map_err(|e| InputError::FrameError(format!("Decode failed: {}", e)))?;

        let rgba = img.to_rgba8();
        Ok(CachedImage {
            width: img.width(),
            height: img.height(),
            rgba_data: rgba.into_raw(),
        })
    }
}

impl InputBackend for MediaFileBackend {
    fn protocol_name(&self) -> &str {
        "media"
    }

    fn list_sources(&self) -> Vec<SourceInfo> {
        self.sources.iter().map(|s| s.info.clone()).collect()
    }

    fn connect(&mut self, source_id: &str) -> Result<(), InputError> {
        // Find the source
        let source = self
            .sources
            .iter()
            .find(|s| s.info.id == source_id)
            .ok_or_else(|| InputError::SourceNotFound(source_id.to_string()))?;

        let path = source.path.clone();
        let name = source.info.name.clone();

        // Decode and cache if not already cached
        if !self.cache.contains_key(source_id) {
            let cached = Self::decode_image(&path)?;
            self.cache.insert(source_id.to_string(), cached);
        }

        self.active_sources.insert(source_id.to_string());
        log::info!(
            "Media file connected: {} (active: {})",
            name,
            self.active_sources.len()
        );
        Ok(())
    }

    fn disconnect(&mut self) {
        self.active_sources.clear();
        log::info!("All media file sources disconnected");
    }

    fn disconnect_source(&mut self, source_id: &str) {
        self.active_sources.remove(source_id);
        log::info!(
            "Media file disconnected: {} (active: {})",
            source_id,
            self.active_sources.len()
        );
    }

    fn poll_frame(&mut self) -> Option<FramePacket> {
        // Return frame for first active source
        let first_active = self.active_sources.iter().next()?.clone();
        self.poll_frame_for_source(&first_active)
    }

    fn poll_frame_for_source(&mut self, source_id: &str) -> Option<FramePacket> {
        if !self.active_sources.contains(source_id) {
            return None;
        }

        let cached = self.cache.get(source_id)?;

        // Increment sequence counter
        let counter = self
            .source_counters
            .entry(source_id.to_string())
            .or_insert(0);
        *counter += 1;
        let seq = *counter;

        Some(FramePacket {
            width: cached.width,
            height: cached.height,
            pixel_format: PixelFormat::Rgba8,
            data: cached.rgba_data.clone(),
            timestamp: None,
            sequence: Some(seq),
        })
    }

    fn state(&self) -> SourceState {
        if self.active_sources.is_empty() {
            SourceState::Disconnected
        } else {
            SourceState::Connected
        }
    }

    fn connected_source(&self) -> Option<&SourceInfo> {
        // Multi-source backend: return None (use is_source_active instead)
        None
    }

    fn is_source_active(&self, source_id: &str) -> bool {
        self.active_sources.contains(source_id)
    }

    fn register_source(&mut self, path: &std::path::Path) -> Result<SourceInfo, InputError> {
        self.register_file(path)
    }

    fn remove_source(&mut self, source_id: &str) -> bool {
        self.remove_file(source_id)
    }
}

impl Default for MediaFileBackend {
    fn default() -> Self {
        Self::new()
    }
}
