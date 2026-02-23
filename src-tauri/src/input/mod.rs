pub mod adapter;
pub mod media;
pub mod test_pattern;

#[cfg(feature = "input-spout")]
pub mod spout;

#[cfg(feature = "input-syphon")]
pub mod syphon;

#[cfg(feature = "input-ndi")]
pub mod ndi;

pub use adapter::*;
