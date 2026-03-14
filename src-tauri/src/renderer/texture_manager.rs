use crate::input::adapter::{FramePacket, PixelFormat};
use std::collections::HashMap;

/// Manages GPU textures keyed by source_id (not layer_id).
/// Multiple layers sharing the same source share a single GPU texture upload.
pub struct TextureManager {
    /// One GPU texture per unique source
    source_textures: HashMap<String, ManagedTexture>,
    /// Maps layer_id -> source_id for lookups
    layer_to_source: HashMap<String, String>,
    /// Generation counter — incremented on each upload (used by buffer cache)
    source_generation: HashMap<String, u64>,
}

pub struct ManagedTexture {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub width: u32,
    pub height: u32,
    pub format: wgpu::TextureFormat,
}

impl TextureManager {
    pub fn new() -> Self {
        Self {
            source_textures: HashMap::new(),
            layer_to_source: HashMap::new(),
            source_generation: HashMap::new(),
        }
    }

    /// Bind a layer to a source. The layer's texture view will resolve through this mapping.
    pub fn bind_layer_to_source(&mut self, layer_id: &str, source_id: &str) {
        self.layer_to_source
            .insert(layer_id.to_string(), source_id.to_string());
    }

    /// Unbind a layer from its source.
    pub fn unbind_layer(&mut self, layer_id: &str) {
        self.layer_to_source.remove(layer_id);
    }

    /// Get the source_id bound to a layer, if any.
    pub fn get_source_for_layer(&self, layer_id: &str) -> Option<&str> {
        self.layer_to_source.get(layer_id).map(|s| s.as_str())
    }

    /// Get the generation counter for a source (used by buffer cache to detect texture changes).
    pub fn source_generation(&self, source_id: &str) -> u64 {
        self.source_generation.get(source_id).copied().unwrap_or(0)
    }

    /// Create or recreate a texture for a given source ID.
    /// Uses the pixel format from the frame to choose the GPU texture format:
    /// - BGRA sources → Bgra8Unorm (universally supported for TEXTURE_BINDING + COPY_DST on DX12/Metal/Vulkan)
    /// - RGBA sources → Rgba8Unorm
    fn ensure_source_texture(
        &mut self,
        device: &wgpu::Device,
        source_id: &str,
        width: u32,
        height: u32,
        gpu_format: wgpu::TextureFormat,
    ) -> &ManagedTexture {
        let needs_create = match self.source_textures.get(source_id) {
            Some(t) => t.width != width || t.height != height || t.format != gpu_format,
            None => true,
        };

        if needs_create {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some(&format!("source_texture_{}", source_id)),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: gpu_format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });

            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

            self.source_textures.insert(
                source_id.to_string(),
                ManagedTexture {
                    texture,
                    view,
                    width,
                    height,
                    format: gpu_format,
                },
            );
        }

        self.source_textures.get(source_id).unwrap()
    }

    /// Upload a frame for a specific source (not layer).
    /// All layers bound to this source will share the texture.
    ///
    /// BGRA and RGBA frames are uploaded directly — no CPU swizzle needed.
    /// Non-sRGB (Unorm) variants are used for universal TEXTURE_BINDING + COPY_DST
    /// support on DX12/Metal/Vulkan; sRGB variants can fail silently on some DX12 drivers.
    pub fn upload_frame_for_source(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        source_id: &str,
        frame: &FramePacket,
    ) {
        // Choose GPU format and upload data based on pixel format.
        // BGRA and RGBA write directly — no clone, no swizzle.
        let (gpu_format, upload_data) = match frame.pixel_format {
            PixelFormat::Bgra8 => (
                wgpu::TextureFormat::Bgra8Unorm,
                std::borrow::Cow::Borrowed(&frame.data[..]),
            ),
            PixelFormat::Rgba8 => (
                wgpu::TextureFormat::Rgba8Unorm,
                std::borrow::Cow::Borrowed(&frame.data[..]),
            ),
            PixelFormat::Rgb8 => {
                // Convert RGB to RGBA (only format that needs conversion)
                let mut rgba = Vec::with_capacity((frame.width * frame.height * 4) as usize);
                for chunk in frame.data.chunks_exact(3) {
                    rgba.extend_from_slice(chunk);
                    rgba.push(255);
                }
                (
                    wgpu::TextureFormat::Rgba8Unorm,
                    std::borrow::Cow::Owned(rgba),
                )
            }
        };

        let managed =
            self.ensure_source_texture(device, source_id, frame.width, frame.height, gpu_format);

        let bytes_per_row = 4 * frame.width;

        queue.write_texture(
            managed.texture.as_image_copy(),
            &upload_data,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(bytes_per_row),
                rows_per_image: Some(frame.height),
            },
            wgpu::Extent3d {
                width: frame.width,
                height: frame.height,
                depth_or_array_layers: 1,
            },
        );

        // Bump generation counter
        let gen = self
            .source_generation
            .entry(source_id.to_string())
            .or_insert(0);
        *gen += 1;
    }

    /// Legacy: upload a frame keyed by layer_id (for backwards compatibility).
    /// Internally maps to source-keyed storage using layer_id as source_id.
    pub fn upload_frame(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        layer_id: &str,
        frame: &FramePacket,
    ) {
        // If the layer has a source binding, use the source_id; otherwise use layer_id
        let source_id = self
            .layer_to_source
            .get(layer_id)
            .cloned()
            .unwrap_or_else(|| layer_id.to_string());

        self.upload_frame_for_source(device, queue, &source_id, frame);

        // Ensure this layer is bound to that source
        if !self.layer_to_source.contains_key(layer_id) {
            self.layer_to_source.insert(layer_id.to_string(), source_id);
        }
    }

    /// Get the texture view for a layer (resolves through layer_to_source → source_textures).
    /// Unchanged external signature.
    pub fn get_texture_view(&self, layer_id: &str) -> Option<&wgpu::TextureView> {
        let source_id = self.layer_to_source.get(layer_id)?;
        self.source_textures.get(source_id).map(|t| &t.view)
    }

    /// Remove texture for a deleted layer. Only removes the source texture
    /// if no other layers reference it.
    pub fn remove(&mut self, layer_id: &str) {
        if let Some(source_id) = self.layer_to_source.remove(layer_id) {
            // Check if any other layer still uses this source
            let still_used = self.layer_to_source.values().any(|v| v == &source_id);
            if !still_used {
                self.source_textures.remove(&source_id);
                self.source_generation.remove(&source_id);
            }
        }
    }

    /// Remove source textures that have no bound layers (garbage collection).
    pub fn remove_unused_sources(&mut self) {
        let used_sources: std::collections::HashSet<&String> =
            self.layer_to_source.values().collect();
        self.source_textures
            .retain(|source_id, _| used_sources.contains(source_id));
        self.source_generation
            .retain(|source_id, _| used_sources.contains(source_id));
    }

    /// Get the number of unique source textures (for diagnostics).
    pub fn source_texture_count(&self) -> usize {
        self.source_textures.len()
    }

    /// Clear all textures and bindings
    pub fn clear(&mut self) {
        self.source_textures.clear();
        self.layer_to_source.clear();
        self.source_generation.clear();
    }
}

impl Default for TextureManager {
    fn default() -> Self {
        Self::new()
    }
}
