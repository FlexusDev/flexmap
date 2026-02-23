use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;

/// Normalized frame descriptor — protocol-agnostic representation of a video frame
#[derive(Debug, Clone)]
pub struct FramePacket {
    pub width: u32,
    pub height: u32,
    pub pixel_format: PixelFormat,
    pub data: Vec<u8>,
    pub timestamp: Option<u64>,
    pub sequence: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PixelFormat {
    Rgba8,
    Bgra8,
    Rgb8,
}

impl PixelFormat {
    pub fn bytes_per_pixel(&self) -> u32 {
        match self {
            PixelFormat::Rgba8 | PixelFormat::Bgra8 => 4,
            PixelFormat::Rgb8 => 3,
        }
    }
}

/// Source metadata exposed to the UI
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceInfo {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
}

/// Source connection state
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceState {
    Connected,
    Disconnected,
    Missing,
    Error,
}

impl fmt::Display for SourceState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SourceState::Connected => write!(f, "connected"),
            SourceState::Disconnected => write!(f, "disconnected"),
            SourceState::Missing => write!(f, "missing"),
            SourceState::Error => write!(f, "error"),
        }
    }
}

/// Input error type
#[derive(Debug, thiserror::Error)]
pub enum InputError {
    #[error("Source not found: {0}")]
    SourceNotFound(String),
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),
    #[error("Protocol unavailable: {0}")]
    ProtocolUnavailable(String),
    #[error("Frame capture error: {0}")]
    FrameError(String),
}

/// Trait all input backends must implement.
///
/// Backends that support multiple simultaneous sources (like test patterns)
/// should override `poll_frame_for_source`, `disconnect_source`, and
/// `is_source_active`.
pub trait InputBackend: Send + Sync {
    /// Protocol name (e.g. "spout", "syphon", "ndi", "test")
    fn protocol_name(&self) -> &str;

    /// Discover currently available sources
    fn list_sources(&self) -> Vec<SourceInfo>;

    /// Connect to a specific source by ID
    fn connect(&mut self, source_id: &str) -> Result<(), InputError>;

    /// Disconnect all sources
    fn disconnect(&mut self);

    /// Disconnect a specific source. Default: calls disconnect().
    fn disconnect_source(&mut self, _source_id: &str) {
        self.disconnect();
    }

    /// Poll the latest frame from the connected source.
    /// Returns None if no new frame is available.
    fn poll_frame(&mut self) -> Option<FramePacket>;

    /// Poll a frame for a specific source_id. Backends that support multiple
    /// simultaneous connections override this. Default: falls back to poll_frame()
    /// if the backend is connected to this source.
    fn poll_frame_for_source(&mut self, source_id: &str) -> Option<FramePacket> {
        if self.is_source_active(source_id) {
            return self.poll_frame();
        }
        None
    }

    /// Current connection state
    fn state(&self) -> SourceState;

    /// Currently connected source info (for single-source backends)
    fn connected_source(&self) -> Option<&SourceInfo>;

    /// Check if a specific source is currently active. Default: checks
    /// connected_source().
    fn is_source_active(&self, source_id: &str) -> bool {
        self.connected_source()
            .map(|s| s.id == source_id)
            .unwrap_or(false)
    }

    /// Register a source from an external path (e.g. media file).
    /// Default: not supported. Override in backends that accept external files.
    fn register_source(&mut self, _path: &std::path::Path) -> Result<SourceInfo, InputError> {
        Err(InputError::ProtocolUnavailable(
            "This backend does not support external source registration".into(),
        ))
    }

    /// Remove a previously registered source.
    /// Default: not supported.
    fn remove_source(&mut self, _source_id: &str) -> bool {
        false
    }
}

/// Manages all available input backends and active connections.
///
/// `layer_bindings` maps layer_id -> source_id for layers that have a source assigned.
/// The frame pump uses these bindings to know which backends to poll for which layers.
pub struct InputManager {
    backends: Vec<Box<dyn InputBackend>>,
    /// Maps layer_id -> source_id
    layer_bindings: HashMap<String, String>,
}

impl InputManager {
    pub fn new() -> Self {
        let mut backends: Vec<Box<dyn InputBackend>> = Vec::new();

        // Test pattern backend is always available
        backends.push(Box::new(super::test_pattern::TestPatternBackend::new()));
        log::info!("Test pattern input backend registered");

        // Media file backend is always available (loads images as sources)
        backends.push(Box::new(super::media::MediaFileBackend::new()));
        log::info!("Media file input backend registered");

        #[cfg(feature = "input-syphon")]
        {
            log::info!("Syphon input backend available");
        }

        #[cfg(feature = "input-spout")]
        {
            let spout = super::spout::SpoutBackend::new();
            backends.push(Box::new(spout));
            log::info!("Spout input backend registered (Windows D3D11)");
        }

        #[cfg(feature = "input-ndi")]
        {
            log::info!("NDI input backend available (optional)");
        }

        Self {
            backends,
            layer_bindings: HashMap::new(),
        }
    }

    pub fn available_protocols(&self) -> Vec<String> {
        self.backends
            .iter()
            .map(|b| b.protocol_name().to_string())
            .collect()
    }

    pub fn list_all_sources(&self) -> Vec<SourceInfo> {
        self.backends
            .iter()
            .flat_map(|b| b.list_sources())
            .collect()
    }

    /// Bind a source to a layer. Connects the backend if not already connected.
    /// If the layer was already bound to a different source, the old source is
    /// disconnected (unless other layers still use it).
    pub fn connect_source(
        &mut self,
        layer_id: &str,
        source_id: &str,
    ) -> Result<(), InputError> {
        // If this layer was already bound to a DIFFERENT source, clean up the old one
        if let Some(old_source) = self.layer_bindings.get(layer_id).cloned() {
            if old_source != source_id {
                // Remove old binding first
                self.layer_bindings.remove(layer_id);

                // If no other layer uses the old source, disconnect it
                let still_used = self.layer_bindings.values().any(|v| v == &old_source);
                if !still_used {
                    for backend in &mut self.backends {
                        if backend.is_source_active(&old_source) {
                            backend.disconnect_source(&old_source);
                            log::info!("Auto-disconnected unused source {} (layer {} rebinding)", old_source, layer_id);
                            break;
                        }
                    }
                }
            }
        }

        // Find the backend that owns the new source
        let backend = self
            .backends
            .iter_mut()
            .find(|b| b.list_sources().iter().any(|s| s.id == source_id));

        let backend = match backend {
            Some(b) => b,
            None => return Err(InputError::SourceNotFound(source_id.to_string())),
        };

        // Connect the backend to this source (backends that support multi-source
        // will add it to their active set; single-source backends will switch)
        if !backend.is_source_active(source_id) {
            backend.connect(source_id)?;
        }

        self.layer_bindings
            .insert(layer_id.to_string(), source_id.to_string());
        log::info!(
            "Layer {} bound to source {}",
            layer_id,
            source_id
        );
        Ok(())
    }

    /// Unbind a source from a layer.
    pub fn disconnect_source(&mut self, layer_id: &str) {
        if let Some(source_id) = self.layer_bindings.remove(layer_id) {
            log::info!("Layer {} unbound from source {}", layer_id, source_id);

            // If no other layer is using this source, disconnect it from the backend
            let still_used = self.layer_bindings.values().any(|v| v == &source_id);
            if !still_used {
                for backend in &mut self.backends {
                    if backend.is_source_active(&source_id) {
                        backend.disconnect_source(&source_id);
                        break;
                    }
                }
            }
        }
    }

    /// Poll a frame for a specific layer (based on its binding).
    /// Returns None if the layer has no source or no new frame.
    pub fn poll_frame_for_layer(&mut self, layer_id: &str) -> Option<FramePacket> {
        let source_id = self.layer_bindings.get(layer_id)?.clone();

        for backend in &mut self.backends {
            if backend.is_source_active(&source_id) {
                return backend.poll_frame_for_source(&source_id);
            }
        }
        None
    }

    /// Get all layer IDs that have active source bindings.
    pub fn bound_layer_ids(&self) -> Vec<String> {
        self.layer_bindings.keys().cloned().collect()
    }

    /// Get the source ID bound to a given layer.
    pub fn get_binding(&self, layer_id: &str) -> Option<&str> {
        self.layer_bindings.get(layer_id).map(|s| s.as_str())
    }

    /// Register a media file as a source. Delegates to the first backend
    /// that supports external source registration (the media backend).
    pub fn register_media_file(
        &mut self,
        path: &std::path::Path,
    ) -> Result<SourceInfo, InputError> {
        for backend in &mut self.backends {
            if backend.protocol_name() == "media" {
                return backend.register_source(path);
            }
        }
        Err(InputError::ProtocolUnavailable(
            "Media file backend not available".into(),
        ))
    }

    /// Remove a registered media file source.
    pub fn remove_media_file(&mut self, source_id: &str) -> bool {
        // First disconnect any layers using this source
        let affected_layers: Vec<String> = self
            .layer_bindings
            .iter()
            .filter(|(_, v)| v.as_str() == source_id)
            .map(|(k, _)| k.clone())
            .collect();

        for layer_id in affected_layers {
            self.layer_bindings.remove(&layer_id);
            log::info!("Auto-unbound layer {} from removed source {}", layer_id, source_id);
        }

        for backend in &mut self.backends {
            if backend.protocol_name() == "media" {
                return backend.remove_source(source_id);
            }
        }
        false
    }
}

impl Default for InputManager {
    fn default() -> Self {
        Self::new()
    }
}
