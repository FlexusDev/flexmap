use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// 2D point in normalized coordinates (0.0 - 1.0)
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct Point2D {
    pub x: f64,
    pub y: f64,
}

impl Point2D {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
}

/// Layer shape types supported in MVP
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", content = "data")]
pub enum LayerGeometry {
    /// 4-point warp (projective/homography transform)
    Quad {
        corners: [Point2D; 4], // TL, TR, BR, BL
    },
    /// 3-point warp (affine transform)
    Triangle {
        vertices: [Point2D; 3],
    },
    /// Subdivided grid mesh for complex surfaces
    Mesh {
        cols: u32,
        rows: u32,
        /// Flattened grid of (rows+1) * (cols+1) control points
        points: Vec<Point2D>,
    },
    /// Circle mask (rendered as masked quad)
    Circle {
        center: Point2D,
        radius: f64,
        /// Underlying quad for texture mapping
        bounds: [Point2D; 4],
    },
}

impl LayerGeometry {
    /// Create a default quad covering the full canvas
    pub fn default_quad() -> Self {
        LayerGeometry::Quad {
            corners: [
                Point2D::new(0.1, 0.1),
                Point2D::new(0.9, 0.1),
                Point2D::new(0.9, 0.9),
                Point2D::new(0.1, 0.9),
            ],
        }
    }

    /// Create a default triangle
    pub fn default_triangle() -> Self {
        LayerGeometry::Triangle {
            vertices: [
                Point2D::new(0.5, 0.1),
                Point2D::new(0.9, 0.9),
                Point2D::new(0.1, 0.9),
            ],
        }
    }

    /// Create a default grid mesh with the given subdivision
    pub fn default_mesh(cols: u32, rows: u32) -> Self {
        let mut points = Vec::with_capacity(((rows + 1) * (cols + 1)) as usize);
        for r in 0..=rows {
            for c in 0..=cols {
                let x = 0.1 + 0.8 * (c as f64 / cols as f64);
                let y = 0.1 + 0.8 * (r as f64 / rows as f64);
                points.push(Point2D::new(x, y));
            }
        }
        LayerGeometry::Mesh { cols, rows, points }
    }

    /// Create a default circle
    pub fn default_circle() -> Self {
        LayerGeometry::Circle {
            center: Point2D::new(0.5, 0.5),
            radius: 0.3,
            bounds: [
                Point2D::new(0.2, 0.2),
                Point2D::new(0.8, 0.2),
                Point2D::new(0.8, 0.8),
                Point2D::new(0.2, 0.8),
            ],
        }
    }

    /// Get all mutable control points for this geometry
    pub fn control_points(&self) -> Vec<Point2D> {
        match self {
            LayerGeometry::Quad { corners } => corners.to_vec(),
            LayerGeometry::Triangle { vertices } => vertices.to_vec(),
            LayerGeometry::Mesh { points, .. } => points.clone(),
            LayerGeometry::Circle { center, bounds, .. } => {
                let mut pts = vec![*center];
                pts.extend_from_slice(bounds);
                pts
            }
        }
    }
}

/// Per-layer post-processing properties
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayerProperties {
    pub brightness: f64,
    pub contrast: f64,
    pub gamma: f64,
    pub opacity: f64,
    pub feather: f64,
}

impl Default for LayerProperties {
    fn default() -> Self {
        Self {
            brightness: 1.0,
            contrast: 1.0,
            gamma: 1.0,
            opacity: 1.0,
            feather: 0.0,
        }
    }
}

/// Blend mode for compositing layers
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum BlendMode {
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    SoftLight,
    HardLight,
    Difference,
    Exclusion,
    Additive,
}

impl Default for BlendMode {
    fn default() -> Self {
        BlendMode::Normal
    }
}

/// Source assignment for a layer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceAssignment {
    pub protocol: String,
    pub source_id: String,
    pub display_name: String,
}

/// A single mapping layer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Layer {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub layer_type: String,
    pub visible: bool,
    pub locked: bool,
    #[serde(rename = "zIndex")]
    pub z_index: i32,
    pub source: Option<SourceAssignment>,
    pub geometry: LayerGeometry,
    pub properties: LayerProperties,
    #[serde(default)]
    pub blend_mode: BlendMode,
}

impl Layer {
    pub fn new_quad(name: &str, z_index: i32) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            layer_type: "quad".to_string(),
            visible: true,
            locked: false,
            z_index,
            source: None,
            geometry: LayerGeometry::default_quad(),
            properties: LayerProperties::default(),
            blend_mode: BlendMode::default(),
        }
    }

    pub fn new_triangle(name: &str, z_index: i32) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            layer_type: "triangle".to_string(),
            visible: true,
            locked: false,
            z_index,
            source: None,
            geometry: LayerGeometry::default_triangle(),
            properties: LayerProperties::default(),
            blend_mode: BlendMode::default(),
        }
    }

    pub fn new_mesh(name: &str, z_index: i32, cols: u32, rows: u32) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            layer_type: "mesh".to_string(),
            visible: true,
            locked: false,
            z_index,
            source: None,
            geometry: LayerGeometry::default_mesh(cols, rows),
            properties: LayerProperties::default(),
            blend_mode: BlendMode::default(),
        }
    }

    pub fn new_circle(name: &str, z_index: i32) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            layer_type: "circle".to_string(),
            visible: true,
            locked: false,
            z_index,
            source: None,
            geometry: LayerGeometry::default_circle(),
            properties: LayerProperties::default(),
            blend_mode: BlendMode::default(),
        }
    }
}
