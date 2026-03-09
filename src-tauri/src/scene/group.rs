use serde::{Deserialize, Serialize};
use uuid::Uuid;
use super::layer::PixelMapEffect;

/// A named group of layers that share a pixel mapping effect
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerGroup {
    pub id: String,
    pub name: String,
    pub layer_ids: Vec<String>,
    pub visible: bool,
    pub locked: bool,
    pub pixel_map: Option<PixelMapEffect>,
}

impl LayerGroup {
    pub fn new(name: &str, layer_ids: Vec<String>) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            layer_ids,
            visible: true,
            locked: false,
            pixel_map: None,
        }
    }
}
