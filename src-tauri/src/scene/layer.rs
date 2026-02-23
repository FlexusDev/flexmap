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

/// A named group of face indices within a Mesh layer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FaceGroup {
    pub name: String,
    pub face_indices: Vec<usize>,
    pub color: String, // hex color for editor overlay
}

/// Per-face UV transform (applied on top of default grid UVs)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UvAdjustment {
    pub offset: [f64; 2],
    pub rotation: f64,
    pub scale: [f64; 2],
}

impl Default for UvAdjustment {
    fn default() -> Self {
        Self {
            offset: [0.0, 0.0],
            rotation: 0.0,
            scale: [1.0, 1.0],
        }
    }
}

/// Per-layer input transform (applied in UV/content space)
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InputTransform {
    pub offset: [f64; 2],
    pub rotation: f64,
    pub scale: [f64; 2],
}

impl Default for InputTransform {
    fn default() -> Self {
        Self {
            offset: [0.0, 0.0],
            rotation: 0.0,
            scale: [1.0, 1.0],
        }
    }
}

/// Layer shape types supported in MVP
#[derive(Debug, Clone, Serialize, PartialEq)]
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
        /// Named face groups for selective calibration / group operations
        #[serde(default)]
        face_groups: Vec<FaceGroup>,
        /// Faces to skip (render black) — stored as Vec for serde, converted to HashSet at render time
        #[serde(default)]
        masked_faces: Vec<usize>,
        /// Per-face UV transforms keyed by face index
        #[serde(default)]
        uv_overrides: std::collections::HashMap<usize, UvAdjustment>,
    },
    /// Ellipse mask (circle is a special case where radius_x == radius_y)
    Circle {
        center: Point2D,
        radius_x: f64,
        radius_y: f64,
        rotation: f64,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", content = "data")]
enum LayerGeometryDe {
    Quad {
        corners: [Point2D; 4],
    },
    Triangle {
        vertices: [Point2D; 3],
    },
    Mesh {
        cols: u32,
        rows: u32,
        #[serde(default)]
        points: Vec<Point2D>,
        #[serde(default)]
        face_groups: Vec<FaceGroup>,
        #[serde(default)]
        masked_faces: Vec<usize>,
        #[serde(default)]
        uv_overrides: std::collections::HashMap<usize, UvAdjustment>,
    },
    Circle {
        center: Point2D,
        #[serde(default)]
        radius_x: Option<f64>,
        #[serde(default)]
        radius_y: Option<f64>,
        #[serde(default)]
        rotation: f64,
        // Legacy fields (schema v1)
        #[serde(default)]
        radius: Option<f64>,
        #[serde(default)]
        bounds: Option<[Point2D; 4]>,
    },
}

impl<'de> Deserialize<'de> for LayerGeometry {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let de = LayerGeometryDe::deserialize(deserializer)?;
        Ok(match de {
            LayerGeometryDe::Quad { corners } => LayerGeometry::Quad { corners },
            LayerGeometryDe::Triangle { vertices } => LayerGeometry::Triangle { vertices },
            LayerGeometryDe::Mesh {
                cols,
                rows,
                points,
                face_groups,
                masked_faces,
                uv_overrides,
            } => LayerGeometry::Mesh {
                cols,
                rows,
                points,
                face_groups,
                masked_faces,
                uv_overrides,
            },
            LayerGeometryDe::Circle {
                center,
                radius_x,
                radius_y,
                rotation,
                radius,
                bounds,
            } => {
                let (mut rx, mut ry) = if let (Some(rx), Some(ry)) = (radius_x, radius_y) {
                    (rx, ry)
                } else if let Some(r) = radius {
                    (r, r)
                } else if let Some(bounds) = bounds {
                    let mut min_x = f64::INFINITY;
                    let mut min_y = f64::INFINITY;
                    let mut max_x = f64::NEG_INFINITY;
                    let mut max_y = f64::NEG_INFINITY;
                    for p in bounds {
                        min_x = min_x.min(p.x);
                        min_y = min_y.min(p.y);
                        max_x = max_x.max(p.x);
                        max_y = max_y.max(p.y);
                    }
                    ((max_x - min_x) * 0.5, (max_y - min_y) * 0.5)
                } else {
                    (0.3, 0.3)
                };

                // Keep radii sane for legacy and malformed data
                rx = rx.abs().max(0.000_1);
                ry = ry.abs().max(0.000_1);

                LayerGeometry::Circle {
                    center,
                    radius_x: rx,
                    radius_y: ry,
                    rotation,
                }
            }
        })
    }
}

impl PartialEq for UvAdjustment {
    fn eq(&self, other: &Self) -> bool {
        self.offset == other.offset
            && self.rotation == other.rotation
            && self.scale == other.scale
    }
}

impl PartialEq for FaceGroup {
    fn eq(&self, other: &Self) -> bool {
        self.name == other.name
            && self.face_indices == other.face_indices
            && self.color == other.color
    }
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
        LayerGeometry::Mesh {
            cols,
            rows,
            points,
            face_groups: Vec::new(),
            masked_faces: Vec::new(),
            uv_overrides: std::collections::HashMap::new(),
        }
    }

    /// Create a default circle
    pub fn default_circle() -> Self {
        LayerGeometry::Circle {
            center: Point2D::new(0.5, 0.5),
            radius_x: 0.3,
            radius_y: 0.3,
            rotation: 0.0,
        }
    }

    /// Get all mutable control points for this geometry
    pub fn control_points(&self) -> Vec<Point2D> {
        match self {
            LayerGeometry::Quad { corners } => corners.to_vec(),
            LayerGeometry::Triangle { vertices } => vertices.to_vec(),
            LayerGeometry::Mesh { points, .. } => points.clone(),
            LayerGeometry::Circle { center, .. } => vec![*center],
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
    #[serde(default)]
    pub input_transform: InputTransform,
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
            input_transform: InputTransform::default(),
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
            input_transform: InputTransform::default(),
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
            input_transform: InputTransform::default(),
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
            input_transform: InputTransform::default(),
            properties: LayerProperties::default(),
            blend_mode: BlendMode::default(),
        }
    }
}
