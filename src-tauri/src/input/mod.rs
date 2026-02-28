pub mod adapter;
pub mod media;
pub mod shader;
pub mod test_pattern;

#[cfg(all(windows, feature = "input-spout"))]
pub mod spout;

#[cfg(all(target_os = "macos", feature = "input-syphon"))]
pub mod syphon;

pub use adapter::*;
