use super::layer::{DimmerEffect, PixelMapEffect, SharedInputMapping};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

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
    #[serde(default, rename = "dimmerFx")]
    pub dimmer_fx: Option<DimmerEffect>,
    #[serde(default, rename = "sharedInput")]
    pub shared_input: Option<SharedInputMapping>,
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
            dimmer_fx: None,
            shared_input: None,
        }
    }
}
