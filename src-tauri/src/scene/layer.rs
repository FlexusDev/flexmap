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
    },
    /// Ellipse mask (circle is a special case where radius_x == radius_y)
    Circle {
        center: Point2D,
        radius_x: f64,
        radius_y: f64,
        rotation: f64,
    },
}

#[allow(dead_code)] // Legacy fields kept for backward-compat deserialization
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
        /// Legacy fields — accepted for backward compat, ignored at runtime
        #[serde(default)]
        face_groups: Vec<serde_json::Value>,
        #[serde(default)]
        masked_faces: Vec<serde_json::Value>,
        #[serde(default)]
        uv_overrides: serde_json::Value,
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
        let geom = match de {
            LayerGeometryDe::Quad { corners } => LayerGeometry::Quad { corners },
            LayerGeometryDe::Triangle { vertices } => LayerGeometry::Triangle { vertices },
            LayerGeometryDe::Mesh {
                cols,
                rows,
                points,
                ..  // ignore legacy face_groups / masked_faces / uv_overrides
            } => LayerGeometry::Mesh {
                cols,
                rows,
                points,
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
        };
        Ok(geom.normalize())
    }
}

impl LayerGeometry {
    /// Create a default quad covering the full canvas (returns a 1x1 Mesh)
    pub fn default_quad() -> Self {
        Self::quad_to_mesh([
            Point2D::new(0.1, 0.1),
            Point2D::new(0.9, 0.1),
            Point2D::new(0.9, 0.9),
            Point2D::new(0.1, 0.9),
        ])
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
        }
    }

    /// Create a default circle (returns a 1x1 Mesh of the oriented bbox)
    pub fn default_circle() -> Self {
        Self::circle_to_mesh(Point2D::new(0.5, 0.5), 0.3, 0.3, 0.0)
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

    /// Convert a Quad geometry to a 1x1 Mesh.
    /// Grid layout: row0=[TL,TR], row1=[BL,BR] (row-major, [TL,TR,BL,BR])
    fn quad_to_mesh(corners: [Point2D; 4]) -> Self {
        // corners order: TL=0, TR=1, BR=2, BL=3
        // Mesh points row-major: [TL, TR, BL, BR]
        LayerGeometry::Mesh {
            cols: 1,
            rows: 1,
            points: vec![corners[0], corners[1], corners[3], corners[2]],
        }
    }

    /// Convert a Circle geometry to a 1x1 Mesh (4 oriented bbox corners).
    fn circle_to_mesh(center: Point2D, radius_x: f64, radius_y: f64, rotation: f64) -> Self {
        let cx = center.x;
        let cy = center.y;
        let rx = radius_x;
        let ry = radius_y;
        let c = rotation.cos();
        let s = rotation.sin();
        // TL, TR, BR, BL corners of the oriented bounding box
        let corners = [
            Point2D::new(cx + (-rx) * c - (-ry) * s, cy + (-rx) * s + (-ry) * c),
            Point2D::new(cx + rx * c - (-ry) * s,     cy + rx * s + (-ry) * c),
            Point2D::new(cx + rx * c - ry * s,         cy + rx * s + ry * c),
            Point2D::new(cx + (-rx) * c - ry * s,     cy + (-rx) * s + ry * c),
        ];
        // Mesh points row-major: [TL, TR, BL, BR]
        LayerGeometry::Mesh {
            cols: 1,
            rows: 1,
            points: vec![corners[0], corners[1], corners[3], corners[2]],
        }
    }

    /// Normalize geometry: convert Quad/Circle to 1x1 Mesh.
    /// Triangle and Mesh pass through unchanged.
    pub fn normalize(self) -> Self {
        match self {
            LayerGeometry::Quad { corners } => Self::quad_to_mesh(corners),
            LayerGeometry::Circle { center, radius_x, radius_y, rotation } => {
                Self::circle_to_mesh(center, radius_x, radius_y, rotation)
            }
            other => other,
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
    #[serde(default, rename = "beatReactive", alias = "beat_reactive")]
    pub beat_reactive: bool,
    #[serde(
        default = "default_beat_amount",
        rename = "beatAmount",
        alias = "beat_amount"
    )]
    pub beat_amount: f64,
}

fn default_beat_amount() -> f64 {
    0.0
}

impl Default for LayerProperties {
    fn default() -> Self {
        Self {
            brightness: 1.0,
            contrast: 1.0,
            gamma: 1.0,
            opacity: 1.0,
            feather: 0.0,
            beat_reactive: false,
            beat_amount: 0.0,
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

/// Pattern type for pixel mapping effect
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PixelMapPattern {
    Chase,
    Stripes,
    Gradient,
    Wave,
    Strobe,
    Radial,
}

impl Default for PixelMapPattern {
    fn default() -> Self {
        PixelMapPattern::Chase
    }
}

/// Coordinate mode for pixel mapping pattern
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PatternCoordMode {
    PerShape,
    WorldSpace,
}

impl Default for PatternCoordMode {
    fn default() -> Self {
        PatternCoordMode::PerShape
    }
}

/// Pixel mapping effect — B&W pattern that modulates layer opacity
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PixelMapEffect {
    pub enabled: bool,
    pub pattern: PixelMapPattern,
    pub coord_mode: PatternCoordMode,
    /// BPM-relative speed multiplier
    pub speed: f64,
    /// Band width / frequency (0.0-1.0)
    pub width: f64,
    /// Effect strength (0.0-1.0)
    pub intensity: f64,
    /// Direction angle in degrees
    pub direction: f64,
    pub invert: bool,
    // Per-shape transform
    pub offset_x: f64,
    pub offset_y: f64,
    pub scale_x: f64,
    pub scale_y: f64,
    // World-space box (normalized projection coords)
    pub world_box: [f64; 4],
}

impl Default for PixelMapEffect {
    fn default() -> Self {
        Self {
            enabled: true,
            pattern: PixelMapPattern::default(),
            coord_mode: PatternCoordMode::default(),
            speed: 1.0,
            width: 0.5,
            intensity: 1.0,
            direction: 0.0,
            invert: false,
            offset_x: 0.0,
            offset_y: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
            world_box: [0.0, 0.0, 1.0, 1.0],
        }
    }
}

/// Shared source sampling for a layer group.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SharedInputMapping {
    pub enabled: bool,
    pub r#box: [f64; 4],
    pub offset_x: f64,
    pub offset_y: f64,
    pub rotation: f64,
    pub scale_x: f64,
    pub scale_y: f64,
}

impl Default for SharedInputMapping {
    fn default() -> Self {
        Self {
            enabled: true,
            r#box: [0.0, 0.0, 1.0, 1.0],
            offset_x: 0.0,
            offset_y: 0.0,
            rotation: 0.0,
            scale_x: 1.0,
            scale_y: 1.0,
        }
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
    #[serde(default, rename = "pixelMap")]
    pub pixel_map: Option<PixelMapEffect>,
    #[serde(default, rename = "groupId")]
    pub group_id: Option<String>,
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
            pixel_map: None,
            group_id: None,
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
            pixel_map: None,
            group_id: None,
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
            pixel_map: None,
            group_id: None,
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
            pixel_map: None,
            group_id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_quad_is_mesh_with_4_points() {
        let layer = Layer::new_quad("Q", 0);
        // default_quad() returns a 1x1 Mesh (quad_to_mesh)
        if let LayerGeometry::Mesh { cols, rows, points, .. } = &layer.geometry {
            assert_eq!(*cols, 1);
            assert_eq!(*rows, 1);
            assert_eq!(points.len(), 4); // (1+1)*(1+1)
        } else {
            panic!("Expected Mesh geometry from new_quad");
        }
    }

    #[test]
    fn new_triangle_has_3_vertices() {
        let layer = Layer::new_triangle("T", 0);
        if let LayerGeometry::Triangle { vertices } = &layer.geometry {
            assert_eq!(vertices.len(), 3);
        } else {
            panic!("Expected Triangle geometry");
        }
    }

    #[test]
    fn new_mesh_dimensions_correct() {
        let layer = Layer::new_mesh("M", 0, 3, 2);
        if let LayerGeometry::Mesh { cols, rows, points, .. } = &layer.geometry {
            assert_eq!(*cols, 3);
            assert_eq!(*rows, 2);
            assert_eq!(points.len(), (3 + 1) * (2 + 1)); // 12
        } else {
            panic!("Expected Mesh geometry");
        }
    }

    #[test]
    fn new_circle_is_mesh() {
        // default_circle() converts to a 1x1 Mesh via circle_to_mesh
        let layer = Layer::new_circle("C", 0);
        if let LayerGeometry::Mesh { cols, rows, points, .. } = &layer.geometry {
            assert_eq!(*cols, 1);
            assert_eq!(*rows, 1);
            assert_eq!(points.len(), 4);
        } else {
            panic!("Expected Mesh geometry from new_circle");
        }
    }

    #[test]
    fn default_properties() {
        let layer = Layer::new_quad("Q", 0);
        assert_eq!(layer.properties.opacity, 1.0);
        assert!(layer.visible);
        assert!(!layer.locked);
    }

    #[test]
    fn control_points_count() {
        let quad = Layer::new_quad("Q", 0);
        assert_eq!(quad.geometry.control_points().len(), 4);

        let tri = Layer::new_triangle("T", 0);
        assert_eq!(tri.geometry.control_points().len(), 3);

        let mesh = Layer::new_mesh("M", 0, 4, 3);
        assert_eq!(mesh.geometry.control_points().len(), 5 * 4); // 20
    }

    #[test]
    fn unique_ids() {
        let a = Layer::new_quad("A", 0);
        let b = Layer::new_quad("B", 1);
        assert_ne!(a.id, b.id);
    }

    #[test]
    fn default_blend_mode_normal() {
        let layer = Layer::new_quad("Q", 0);
        assert_eq!(layer.blend_mode, BlendMode::Normal);
    }

    #[test]
    fn point2d_new() {
        let p = Point2D::new(0.5, 0.75);
        assert_eq!(p.x, 0.5);
        assert_eq!(p.y, 0.75);
    }
}
