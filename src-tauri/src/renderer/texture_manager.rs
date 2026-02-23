use std::collections::HashMap;
use crate::input::adapter::{FramePacket, PixelFormat};

/// Manages GPU textures for layer source frames (correctness-first approach)
pub struct TextureManager {
    textures: HashMap<String, ManagedTexture>,
}

pub struct ManagedTexture {
    pub texture: wgpu::Texture,
    pub view: wgpu::TextureView,
    pub width: u32,
    pub height: u32,
}

impl TextureManager {
    pub fn new() -> Self {
        Self {
            textures: HashMap::new(),
        }
    }

    /// Create or recreate a texture for a given layer ID
    pub fn ensure_texture(
        &mut self,
        device: &wgpu::Device,
        layer_id: &str,
        width: u32,
        height: u32,
    ) -> &ManagedTexture {
        let needs_create = match self.textures.get(layer_id) {
            Some(t) => t.width != width || t.height != height,
            None => true,
        };

        if needs_create {
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some(&format!("layer_texture_{}", layer_id)),
                size: wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: wgpu::TextureFormat::Rgba8UnormSrgb,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            });

            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());

            self.textures.insert(
                layer_id.to_string(),
                ManagedTexture {
                    texture,
                    view,
                    width,
                    height,
                },
            );
        }

        self.textures.get(layer_id).unwrap()
    }

    /// Upload RGBA frame data to a layer's texture (correctness-first: CPU copy)
    pub fn upload_frame(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        layer_id: &str,
        frame: &FramePacket,
    ) {
        // Ensure we have the right RGBA data
        let rgba_data = match frame.pixel_format {
            PixelFormat::Rgba8 => frame.data.clone(),
            PixelFormat::Bgra8 => {
                // Convert BGRA to RGBA
                let mut rgba = frame.data.clone();
                for chunk in rgba.chunks_exact_mut(4) {
                    chunk.swap(0, 2); // Swap B and R
                }
                rgba
            }
            PixelFormat::Rgb8 => {
                // Convert RGB to RGBA
                let mut rgba = Vec::with_capacity((frame.width * frame.height * 4) as usize);
                for chunk in frame.data.chunks_exact(3) {
                    rgba.extend_from_slice(chunk);
                    rgba.push(255); // Alpha = 1.0
                }
                rgba
            }
        };

        let managed = self.ensure_texture(device, layer_id, frame.width, frame.height);

        let bytes_per_row = 4 * frame.width;

        queue.write_texture(
            managed.texture.as_image_copy(),
            &rgba_data,
            wgpu::ImageDataLayout {
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
    }

    /// Get the texture view for a layer (for binding in render pass)
    pub fn get_texture_view(&self, layer_id: &str) -> Option<&wgpu::TextureView> {
        self.textures.get(layer_id).map(|t| &t.view)
    }

    /// Remove texture for a deleted layer
    pub fn remove(&mut self, layer_id: &str) {
        self.textures.remove(layer_id);
    }

    /// Clear all textures
    pub fn clear(&mut self) {
        self.textures.clear();
    }
}

impl Default for TextureManager {
    fn default() -> Self {
        Self::new()
    }
}
