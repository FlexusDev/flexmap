use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use super::layer::Layer;

pub const SCHEMA_VERSION: u32 = 1;

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

/// Calibration state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationConfig {
    pub enabled: bool,
    pub pattern: CalibrationPattern,
}

impl Default for CalibrationConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            pattern: CalibrationPattern::Grid,
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
            ui_state: serde_json::Value::Null,
        }
    }

    /// Update the timestamp on modification
    pub fn touch(&mut self) {
        self.updated_at = Utc::now();
    }
}
