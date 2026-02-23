// Syphon input backend for macOS
// This module provides the Syphon protocol adapter behind the InputBackend trait.
//
// Implementation requires linking against the Syphon framework via FFI.
// For MVP, this is a placeholder that will be filled in with actual
// Syphon framework bindings (via objc2/cocoa FFI or a dedicated syphon-rust crate).

use super::adapter::*;

pub struct SyphonBackend {
    state: SourceState,
    sources: Vec<SourceInfo>,
    connected_source: Option<SourceInfo>,
}

impl SyphonBackend {
    pub fn new() -> Result<Self, InputError> {
        log::info!("Initializing Syphon backend");
        Ok(Self {
            state: SourceState::Disconnected,
            sources: Vec::new(),
            connected_source: None,
        })
    }

    /// Refresh the list of available Syphon servers
    fn refresh_sources(&mut self) {
        // TODO: Use SyphonServerDirectory to enumerate available servers
        // This requires Objective-C FFI to the Syphon framework
        log::debug!("Syphon: refreshing source list");
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
        log::info!("Syphon: connecting to source {}", source_id);
        // TODO: Create SyphonClient and connect to the named server
        // For now, return an error since we don't have real Syphon bindings yet
        Err(InputError::ConnectionFailed(
            "Syphon bindings not yet implemented".to_string(),
        ))
    }

    fn disconnect(&mut self) {
        self.state = SourceState::Disconnected;
        self.connected_source = None;
        log::info!("Syphon: disconnected");
    }

    fn poll_frame(&mut self) -> Option<FramePacket> {
        // TODO: Pull latest frame from SyphonClient
        None
    }

    fn state(&self) -> SourceState {
        self.state
    }

    fn connected_source(&self) -> Option<&SourceInfo> {
        self.connected_source.as_ref()
    }
}
