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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledShaderSource {
    pub id: String,
    pub name: String,
    pub seed: u32,
    #[serde(default)]
    pub source_hash: Option<String>,
    #[serde(default)]
    pub installed_at: Option<String>,
    #[serde(default)]
    pub source_code: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BpmRuntimeSnapshot {
    pub bpm: f32,
    pub beat: f32,
    pub level: f32,
    pub phase: f32,
    pub phase_origin_ms: u64,
    pub multiplier: f32,
}

impl Default for BpmRuntimeSnapshot {
    fn default() -> Self {
        Self {
            bpm: 120.0,
            beat: 0.0,
            level: 0.0,
            phase: 0.0,
            phase_origin_ms: 0,
            multiplier: 1.0,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerBeatModulation {
    pub beat_reactive: bool,
    pub beat_amount: f32,
}

impl Default for LayerBeatModulation {
    fn default() -> Self {
        Self {
            beat_reactive: false,
            beat_amount: 0.0,
        }
    }
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

    /// Re-discover available sources. Default: no-op (for static backends).
    /// Backends with dynamic discovery (Syphon, Spout, NDI) should override.
    fn refresh(&mut self) {}

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

    /// Replace currently installed shader sources for backends that support it.
    /// Default: no-op.
    fn set_installed_sources(&mut self, _sources: Vec<InstalledShaderSource>) {}

    /// Push per-source modulation values (beat/bpm driven).
    /// Default: no-op.
    fn set_frame_modulation(
        &mut self,
        _source_id: &str,
        _bpm: BpmRuntimeSnapshot,
        _layer: LayerBeatModulation,
    ) {
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
    layer_modulation: HashMap<String, LayerBeatModulation>,
    bpm_snapshot: BpmRuntimeSnapshot,
}

impl InputManager {
    pub fn new() -> Self {
        let mut backends: Vec<Box<dyn InputBackend>> = Vec::new();

        // Test pattern backend is always available
        backends.push(Box::new(super::test_pattern::TestPatternBackend::new()));
        log::info!("Test pattern input backend registered");

        // Built-in shader backend (procedural effects)
        backends.push(Box::new(super::shader::ShaderPatternBackend::new()));
        log::info!("Shader input backend registered");

        // Media file backend is always available (loads images as sources)
        backends.push(Box::new(super::media::MediaFileBackend::new()));
        log::info!("Media file input backend registered");

        #[cfg(all(target_os = "macos", feature = "input-syphon"))]
        {
            let syphon = super::syphon::SyphonBackend::new();
            backends.push(Box::new(syphon));
            log::info!("Syphon input backend registered (macOS Metal)");
        }

        #[cfg(all(windows, feature = "input-spout"))]
        {
            let spout = super::spout::SpoutBackend::new();
            backends.push(Box::new(spout));
            log::info!("Spout input backend registered (Windows D3D11)");
        }

        Self {
            backends,
            layer_bindings: HashMap::new(),
            layer_modulation: HashMap::new(),
            bpm_snapshot: BpmRuntimeSnapshot::default(),
        }
    }

    pub fn available_protocols(&self) -> Vec<String> {
        self.backends
            .iter()
            .map(|b| b.protocol_name().to_string())
            .collect()
    }

    /// Trigger re-discovery on all backends, then return updated source list.
    pub fn refresh_all_sources(&mut self) -> Vec<SourceInfo> {
        for backend in &mut self.backends {
            backend.refresh();
        }
        self.backends
            .iter()
            .flat_map(|b| b.list_sources())
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
    pub fn connect_source(&mut self, layer_id: &str, source_id: &str) -> Result<(), InputError> {
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
                            log::info!(
                                "Auto-disconnected unused source {} (layer {} rebinding)",
                                old_source,
                                layer_id
                            );
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
        log::info!("Layer {} bound to source {}", layer_id, source_id);
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
        self.layer_modulation.remove(layer_id);
    }

    /// Poll a frame for a specific layer (based on its binding).
    /// Returns None if the layer has no source or no new frame.
    pub fn poll_frame_for_layer(&mut self, layer_id: &str) -> Option<FramePacket> {
        let source_id = self.layer_bindings.get(layer_id)?.clone();
        let modulation = self
            .layer_modulation
            .get(layer_id)
            .copied()
            .unwrap_or_default();

        for backend in &mut self.backends {
            if backend.is_source_active(&source_id) {
                backend.set_frame_modulation(&source_id, self.bpm_snapshot, modulation);
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
            self.layer_modulation.remove(&layer_id);
            log::info!(
                "Auto-unbound layer {} from removed source {}",
                layer_id,
                source_id
            );
        }

        for backend in &mut self.backends {
            if backend.protocol_name() == "media" {
                return backend.remove_source(source_id);
            }
        }
        false
    }

    /// Sync installed shader source list into the shader backend.
    pub fn set_installed_shaders(&mut self, sources: Vec<InstalledShaderSource>) -> usize {
        let count = sources.len();
        log::info!("Shader backend sync: {} installed source(s)", count);
        for backend in &mut self.backends {
            if backend.protocol_name() == "shader" {
                backend.set_installed_sources(sources.clone());
            }
        }

        // Drop bindings to sources that no longer exist.
        let available: std::collections::HashSet<String> = self
            .backends
            .iter()
            .flat_map(|b| b.list_sources())
            .map(|s| s.id)
            .collect();
        self.layer_bindings
            .retain(|_, source_id| available.contains(source_id));
        self.layer_modulation
            .retain(|layer_id, _| self.layer_bindings.contains_key(layer_id));

        count
    }

    pub fn set_bpm_snapshot(&mut self, snapshot: BpmRuntimeSnapshot) {
        self.bpm_snapshot = snapshot;
    }

    pub fn set_layer_modulation(&mut self, layer_id: &str, modulation: LayerBeatModulation) {
        self.layer_modulation
            .insert(layer_id.to_string(), modulation);
    }

    /// Check if any layer bindings point to sources that are not currently active.
    /// Used for a cheap read-lock pre-check before taking the expensive write lock
    /// for reconnection.
    pub fn has_stale_bindings(&self) -> bool {
        self.layer_bindings
            .values()
            .any(|source_id| !self.backends.iter().any(|b| b.is_source_active(source_id)))
    }

    /// Attempt to reconnect bound sources that are discoverable but not actively
    /// connected. Returns a list of source_ids that were successfully reconnected.
    pub fn try_reconnect_stale(&mut self) -> Vec<String> {
        let mut recovered = Vec::new();

        // Collect bindings to check
        let bindings: Vec<(String, String)> = self
            .layer_bindings
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        for (_layer_id, source_id) in &bindings {
            // Skip if already recovered this source in this pass
            if recovered.contains(source_id) {
                continue;
            }

            // Check if any backend has this source active
            let already_active = self.backends.iter().any(|b| b.is_source_active(source_id));
            if already_active {
                continue;
            }

            // Check if any backend can discover this source
            for backend in &mut self.backends {
                let discoverable = backend.list_sources().iter().any(|s| s.id == *source_id);

                if discoverable {
                    match backend.connect(source_id) {
                        Ok(()) => {
                            log::info!("Auto-reconnected stale source: {}", source_id);
                            recovered.push(source_id.clone());
                        }
                        Err(e) => {
                            log::debug!("Auto-reconnect failed for source {}: {}", source_id, e);
                        }
                    }
                    break;
                }
            }
        }

        recovered
    }
}

impl Default for InputManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_manager_empty_bindings() {
        let mgr = InputManager::new();
        assert!(mgr.bound_layer_ids().is_empty());
    }

    #[test]
    fn available_protocols_not_empty() {
        let mgr = InputManager::new();
        let protocols = mgr.available_protocols();
        assert!(!protocols.is_empty());
        assert!(protocols.contains(&"test".to_string()));
    }

    #[test]
    fn list_all_sources_includes_test_patterns() {
        let mgr = InputManager::new();
        let sources = mgr.list_all_sources();
        // Test pattern backend should always have sources
        assert!(sources.iter().any(|s| s.protocol == "test"));
    }

    #[test]
    fn connect_and_disconnect_source() {
        let mut mgr = InputManager::new();
        let sources = mgr.list_all_sources();
        let test_source = sources.iter().find(|s| s.protocol == "test").unwrap();

        let result = mgr.connect_source("layer1", &test_source.id);
        assert!(result.is_ok());
        assert_eq!(mgr.get_binding("layer1"), Some(test_source.id.as_str()));

        mgr.disconnect_source("layer1");
        assert!(mgr.get_binding("layer1").is_none());
    }

    #[test]
    fn connect_nonexistent_returns_error() {
        let mut mgr = InputManager::new();
        let result = mgr.connect_source("layer1", "nonexistent_source_id");
        assert!(result.is_err());
    }
}
