// NDI input backend (optional integration path)
// Isolated behind the `input-ndi` feature gate due to SDK licensing constraints.
//
// The NDI SDK must be installed separately by the user.
// This module will not be compiled unless the `input-ndi` feature is enabled.

use super::adapter::*;

pub struct NdiBackend {
    state: SourceState,
    sources: Vec<SourceInfo>,
    connected_source: Option<SourceInfo>,
}

impl NdiBackend {
    pub fn new() -> Result<Self, InputError> {
        log::info!("Initializing NDI backend (optional)");
        // TODO: Check for NDI runtime availability
        Ok(Self {
            state: SourceState::Disconnected,
            sources: Vec::new(),
            connected_source: None,
        })
    }
}

impl InputBackend for NdiBackend {
    fn protocol_name(&self) -> &str {
        "ndi"
    }

    fn list_sources(&self) -> Vec<SourceInfo> {
        self.sources.clone()
    }

    fn connect(&mut self, source_id: &str) -> Result<(), InputError> {
        log::info!("NDI: connecting to source {}", source_id);
        Err(InputError::ConnectionFailed(
            "NDI bindings not yet implemented".to_string(),
        ))
    }

    fn disconnect(&mut self) {
        self.state = SourceState::Disconnected;
        self.connected_source = None;
    }

    fn poll_frame(&mut self) -> Option<FramePacket> {
        None
    }

    fn state(&self) -> SourceState {
        self.state
    }

    fn connected_source(&self) -> Option<&SourceInfo> {
        self.connected_source.as_ref()
    }
}
