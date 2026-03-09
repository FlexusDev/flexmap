use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use super::group::LayerGroup;
use super::layer::Layer;

pub const SCHEMA_VERSION: u32 = 2;

/// Output configuration for the projector
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutputConfig {
    pub width: u32,
    pub height: u32,
    pub framerate: u32,
    /// Monitor name/identifier preference (falls back if not found)
    pub monitor_preference: Option<String>,
}

impl Default for OutputConfig {
    fn default() -> Self {
        Self {
            width: 3840,
            height: 2160,
            framerate: 60,
            monitor_preference: None,
        }
    }
}

/// Target for layer-level calibration overlay
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CalibrationTarget {
    pub layer_id: String,
    // face_indices removed — calibration targets the whole layer
}

/// Calibration state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationConfig {
    pub enabled: bool,
    pub pattern: CalibrationPattern,
    /// When Some, calibration pattern is rendered only on this layer (rest of scene normal)
    #[serde(default)]
    pub target_layer: Option<CalibrationTarget>,
}

impl Default for CalibrationConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            pattern: CalibrationPattern::Grid,
            target_layer: None,
        }
    }
}

/// Available calibration test patterns
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum CalibrationPattern {
    Grid,
    Crosshair,
    Checkerboard,
    FullWhite,
    ColorBars,
    Black,
}

/// The complete project file structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectFile {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "projectName")]
    pub project_name: String,
    #[serde(rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
    pub output: OutputConfig,
    pub calibration: CalibrationConfig,
    pub layers: Vec<Layer>,
    #[serde(default)]
    pub groups: Vec<LayerGroup>,
    /// Non-critical editor UI state (viewport zoom, scroll position, etc.)
    #[serde(rename = "uiState", default)]
    pub ui_state: serde_json::Value,
}

impl ProjectFile {
    pub fn new(name: &str) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            project_name: name.to_string(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            output: OutputConfig::default(),
            calibration: CalibrationConfig::default(),
            layers: Vec::new(),
            groups: Vec::new(),
            ui_state: serde_json::Value::Null,
        }
    }

    /// Update the timestamp on modification
    pub fn touch(&mut self) {
        self.updated_at = Utc::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_project_defaults() {
        let proj = ProjectFile::new("Test");
        assert_eq!(proj.project_name, "Test");
        assert_eq!(proj.schema_version, SCHEMA_VERSION);
        assert!(proj.layers.is_empty());
        assert_eq!(proj.output.width, 3840);
        assert_eq!(proj.output.height, 2160);
        assert_eq!(proj.output.framerate, 60);
    }

    #[test]
    fn touch_updates_timestamp() {
        let mut proj = ProjectFile::new("Test");
        let before = proj.updated_at;
        // Small sleep to ensure timestamp differs
        std::thread::sleep(std::time::Duration::from_millis(2));
        proj.touch();
        assert!(proj.updated_at >= before);
    }

    #[test]
    fn calibration_defaults_disabled() {
        let proj = ProjectFile::new("Test");
        assert!(!proj.calibration.enabled);
        assert_eq!(proj.calibration.pattern, CalibrationPattern::Grid);
        assert!(proj.calibration.target_layer.is_none());
    }
}
