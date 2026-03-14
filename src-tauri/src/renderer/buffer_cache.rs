//! Buffer cache — avoids recreating vertex/index/uniform buffers every frame.
//! Geometry and uniforms are tracked separately so transform/property changes
//! can update uniform buffers without rebuilding mesh buffers.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use wgpu::util::DeviceExt;

use super::pipeline::{generate_layer_mesh, BpmRenderSnapshot, LayerUniforms};
use super::texture_manager::TextureManager;
use crate::scene::group::LayerGroup;
use crate::scene::layer::{Layer, LayerGeometry};

/// Cached GPU buffers for a single layer
pub struct CachedLayerBuffers {
    pub vertex_buffer: wgpu::Buffer,
    pub index_buffer: wgpu::Buffer,
    pub index_count: u32,
    pub uniform_buffer: wgpu::Buffer,
    pub bind_group: wgpu::BindGroup,
    geometry_hash: u64,
    properties_hash: u64,
    source_gen: u64,
}

/// Per-frame diagnostics counters
pub struct CacheStats {
    pub hits: u64,
    pub misses: u64,
}

pub struct BufferCache {
    pub entries: HashMap<String, CachedLayerBuffers>,
    pub stats: CacheStats,
}

/// Hash f64 by converting to bits (stable, no NaN issues for our data)
fn hash_f64(state: &mut impl Hasher, v: f64) {
    v.to_bits().hash(state);
}

/// Hash the LayerGeometry struct directly — avoids generating the full mesh
/// just to compute a cache key on the hot path.
fn compute_geometry_hash(geometry: &LayerGeometry) -> u64 {
    let mut hasher = std::hash::DefaultHasher::new();
    std::mem::discriminant(geometry).hash(&mut hasher);
    match geometry {
        LayerGeometry::Quad { corners } => {
            for p in corners {
                hash_f64(&mut hasher, p.x);
                hash_f64(&mut hasher, p.y);
            }
        }
        LayerGeometry::Triangle { vertices } => {
            for p in vertices {
                hash_f64(&mut hasher, p.x);
                hash_f64(&mut hasher, p.y);
            }
        }
        LayerGeometry::Mesh {
            cols, rows, points, ..
        } => {
            cols.hash(&mut hasher);
            rows.hash(&mut hasher);
            for p in points {
                hash_f64(&mut hasher, p.x);
                hash_f64(&mut hasher, p.y);
            }
        }
        LayerGeometry::Circle {
            center,
            radius_x,
            radius_y,
            rotation,
        } => {
            hash_f64(&mut hasher, center.x);
            hash_f64(&mut hasher, center.y);
            hash_f64(&mut hasher, *radius_x);
            hash_f64(&mut hasher, *radius_y);
            hash_f64(&mut hasher, *rotation);
        }
    }
    hasher.finish()
}

fn compute_properties_hash(uniforms: &LayerUniforms) -> u64 {
    let mut hasher = std::hash::DefaultHasher::new();
    let bytes: &[u8] = bytemuck::bytes_of(uniforms);
    bytes.hash(&mut hasher);
    hasher.finish()
}

fn create_bind_group(
    device: &wgpu::Device,
    bind_group_layout: &wgpu::BindGroupLayout,
    sampler: &wgpu::Sampler,
    texture_view: &wgpu::TextureView,
    uniform_buffer: &wgpu::Buffer,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("Cached Layer Bind Group"),
        layout: bind_group_layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::TextureView(texture_view),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::Sampler(sampler),
            },
            wgpu::BindGroupEntry {
                binding: 2,
                resource: uniform_buffer.as_entire_binding(),
            },
        ],
    })
}

fn build_layer_uniforms(
    layer: &Layer,
    layers: &[Layer],
    groups: &[LayerGroup],
    bpm: BpmRenderSnapshot,
    now_ms: u64,
) -> LayerUniforms {
    let shared_input = super::pipeline::resolve_shared_input_for_layer(layer, groups);
    let opacity =
        super::pipeline::compute_effective_opacity_at_time(layer, layers, groups, bpm, now_ms);
    LayerUniforms::from_layer(layer, shared_input, opacity, bpm)
}

impl BufferCache {
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
            stats: CacheStats { hits: 0, misses: 0 },
        }
    }

    /// Prepare cached buffers for a layer. Returns None if the layer has empty geometry.
    /// If the cache entry is valid (hashes match), returns it directly (cache hit).
    /// Otherwise rebuilds buffers (cache miss).
    pub fn prepare_layer(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        bind_group_layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        texture_view: &wgpu::TextureView,
        texture_manager: &TextureManager,
        layers: &[Layer],
        layer: &Layer,
        groups: &[LayerGroup],
        bpm: BpmRenderSnapshot,
        dimmer_now_ms: u64,
    ) -> Option<&CachedLayerBuffers> {
        // Hash geometry struct directly — avoids allocating Vec<LayerVertex> + Vec<u16>
        // on every cache hit (60fps × N layers).
        let geom_hash = compute_geometry_hash(&layer.geometry);
        let uniforms = build_layer_uniforms(layer, layers, groups, bpm, dimmer_now_ms);
        let prop_hash = compute_properties_hash(&uniforms);

        // Get source generation to detect texture changes
        let source_gen = texture_manager
            .get_source_for_layer(&layer.id)
            .map(|sid| texture_manager.source_generation(sid))
            .unwrap_or(0);

        // Fast path: geometry unchanged. Update uniforms and/or texture binding in place.
        if let Some(existing) = self.entries.get_mut(&layer.id) {
            if existing.geometry_hash == geom_hash {
                if existing.properties_hash != prop_hash {
                    queue.write_buffer(&existing.uniform_buffer, 0, bytemuck::bytes_of(&uniforms));
                    existing.properties_hash = prop_hash;
                }

                if existing.source_gen != source_gen {
                    existing.bind_group = create_bind_group(
                        device,
                        bind_group_layout,
                        sampler,
                        texture_view,
                        &existing.uniform_buffer,
                    );
                    existing.source_gen = source_gen;
                }

                self.stats.hits += 1;
                return self.entries.get(&layer.id);
            }
        }

        // Cache miss — geometry changed or no entry, rebuild mesh buffers.
        self.stats.misses += 1;

        let (vertices, indices) = generate_layer_mesh(&layer.geometry);
        if vertices.is_empty() || indices.is_empty() {
            return None;
        }

        let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Cached Vertex Buffer"),
            contents: bytemuck::cast_slice(&vertices),
            usage: wgpu::BufferUsages::VERTEX,
        });

        let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Cached Index Buffer"),
            contents: bytemuck::cast_slice(&indices),
            usage: wgpu::BufferUsages::INDEX,
        });

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Cached Uniform Buffer"),
            contents: bytemuck::cast_slice(&[uniforms]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let bind_group = create_bind_group(
            device,
            bind_group_layout,
            sampler,
            texture_view,
            &uniform_buffer,
        );

        let cached = CachedLayerBuffers {
            vertex_buffer,
            index_buffer,
            index_count: indices.len() as u32,
            uniform_buffer,
            bind_group,
            geometry_hash: geom_hash,
            properties_hash: prop_hash,
            source_gen,
        };

        self.entries.insert(layer.id.clone(), cached);
        self.entries.get(&layer.id)
    }

    pub fn refresh_dynamic_uniforms(
        &mut self,
        queue: &wgpu::Queue,
        layers: &[Layer],
        groups: &[LayerGroup],
        bpm: BpmRenderSnapshot,
        now_ms: u64,
    ) {
        for layer in layers.iter() {
            if !self.entries.contains_key(&layer.id) {
                continue;
            }
            let uniforms = build_layer_uniforms(layer, layers, groups, bpm, now_ms);
            let prop_hash = compute_properties_hash(&uniforms);
            if let Some(existing) = self.entries.get_mut(&layer.id) {
                if existing.properties_hash == prop_hash {
                    continue;
                }
                queue.write_buffer(&existing.uniform_buffer, 0, bytemuck::bytes_of(&uniforms));
                existing.properties_hash = prop_hash;
            }
        }
    }

    /// Invalidate the cache for a specific layer
    pub fn invalidate(&mut self, layer_id: &str) {
        self.entries.remove(layer_id);
    }

    /// Clear all cached entries
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Remove entries for layers that no longer exist
    pub fn retain_layers(&mut self, layer_ids: &[String]) {
        let id_set: std::collections::HashSet<&String> = layer_ids.iter().collect();
        self.entries.retain(|k, _| id_set.contains(k));
    }

    /// Reset stats counters (call once per frame or per stats poll)
    pub fn reset_stats(&mut self) {
        self.stats.hits = 0;
        self.stats.misses = 0;
    }
}

impl Default for BufferCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scene::layer::{DimmerCurve, DimmerEffect, PixelMapEffect};

    #[test]
    fn layer_uniforms_change_when_dimmer_phase_advances() {
        let mut layer = Layer::new_quad("Q", 0);
        layer.dimmer_fx = Some(DimmerEffect {
            curve: DimmerCurve::Square,
            duty_cycle: 0.5,
            ..DimmerEffect::default()
        });

        let early = build_layer_uniforms(
            &layer,
            &[layer.clone()],
            &[],
            BpmRenderSnapshot {
                bpm: 120.0,
                phase: 0.0,
                multiplier: 1.0,
                phase_origin_ms: 1_000,
            },
            1_250,
        );
        let late = build_layer_uniforms(
            &layer,
            &[layer.clone()],
            &[],
            BpmRenderSnapshot {
                bpm: 120.0,
                phase: 0.0,
                multiplier: 1.0,
                phase_origin_ms: 1_000,
            },
            1_500,
        );

        assert_ne!(
            compute_properties_hash(&early),
            compute_properties_hash(&late)
        );
    }

    #[test]
    fn layer_uniforms_change_when_pixel_map_phase_advances() {
        let mut layer = Layer::new_quad("Q", 0);
        layer.pixel_map = Some(PixelMapEffect::default());

        let early = build_layer_uniforms(
            &layer,
            &[layer.clone()],
            &[],
            BpmRenderSnapshot {
                bpm: 120.0,
                phase: 0.1,
                multiplier: 1.0,
                phase_origin_ms: 1_000,
            },
            1_000,
        );
        let late = build_layer_uniforms(
            &layer,
            &[layer.clone()],
            &[],
            BpmRenderSnapshot {
                bpm: 120.0,
                phase: 0.6,
                multiplier: 1.0,
                phase_origin_ms: 1_000,
            },
            1_000,
        );

        assert_ne!(
            compute_properties_hash(&early),
            compute_properties_hash(&late)
        );
    }
}
