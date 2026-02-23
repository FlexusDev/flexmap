//! Buffer cache — avoids recreating vertex/index/uniform buffers every frame
//! when geometry and properties haven't changed.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use wgpu::util::DeviceExt;

use super::pipeline::{LayerUniforms, LayerVertex, generate_layer_mesh};
use super::texture_manager::TextureManager;
use crate::scene::layer::Layer;

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

/// Hash f32 slices by converting to bits (stable, no NaN issues for our data)
fn hash_f32_slice(state: &mut impl Hasher, slice: &[f32]) {
    for &v in slice {
        v.to_bits().hash(state);
    }
}

fn compute_geometry_hash(vertices: &[LayerVertex], indices: &[u16]) -> u64 {
    let mut hasher = std::hash::DefaultHasher::new();
    for v in vertices {
        hash_f32_slice(&mut hasher, &v.position);
        hash_f32_slice(&mut hasher, &v.tex_coord);
    }
    indices.hash(&mut hasher);
    hasher.finish()
}

fn compute_properties_hash(uniforms: &LayerUniforms) -> u64 {
    let mut hasher = std::hash::DefaultHasher::new();
    let bytes: &[u8] = bytemuck::bytes_of(uniforms);
    bytes.hash(&mut hasher);
    hasher.finish()
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
        bind_group_layout: &wgpu::BindGroupLayout,
        sampler: &wgpu::Sampler,
        texture_view: &wgpu::TextureView,
        texture_manager: &TextureManager,
        layer: &Layer,
    ) -> Option<&CachedLayerBuffers> {
        let (vertices, indices) = generate_layer_mesh(&layer.geometry);
        if vertices.is_empty() || indices.is_empty() {
            return None;
        }

        let geom_hash = compute_geometry_hash(&vertices, &indices);
        let uniforms = LayerUniforms::from(&layer.properties);
        let prop_hash = compute_properties_hash(&uniforms);

        // Get source generation to detect texture changes
        let source_gen = texture_manager
            .get_source_for_layer(&layer.id)
            .map(|sid| texture_manager.source_generation(sid))
            .unwrap_or(0);

        // Check if we have a valid cached entry
        if let Some(existing) = self.entries.get(&layer.id) {
            if existing.geometry_hash == geom_hash
                && existing.properties_hash == prop_hash
                && existing.source_gen == source_gen
            {
                self.stats.hits += 1;
                return self.entries.get(&layer.id);
            }
        }

        // Cache miss — rebuild
        self.stats.misses += 1;

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
            usage: wgpu::BufferUsages::UNIFORM,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
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
        });

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
