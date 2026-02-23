/**
 * Syphon framework C bridge for Rust FFI.
 *
 * Wraps Syphon's Objective-C API into plain C functions that Rust can call
 * via extern "C". Compiled by the `cc` crate in build.rs.
 *
 * Requires: Syphon.framework installed at /Library/Frameworks/
 *           (download from https://syphon.info)
 */

#ifndef SYPHON_BRIDGE_H
#define SYPHON_BRIDGE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Metadata for a single Syphon server (sender). */
typedef struct {
    char name[256];       /**< Server name (e.g. "Main Output") */
    char app_name[256];   /**< Application name (e.g. "Resolume Arena") */
    char uuid[256];       /**< Unique identifier for this server */
} SyphonServerInfo;

/** Opaque handle to a Syphon Metal client. */
typedef void* SyphonClientHandle;

/**
 * Enumerate available Syphon servers.
 *
 * @param out_servers  Caller-allocated array to fill with server info.
 * @param max_servers  Maximum number of entries in out_servers.
 * @return Number of servers found (clamped to max_servers), or 0 if none.
 */
int32_t syphon_list_servers(SyphonServerInfo* out_servers, int32_t max_servers);

/**
 * Create a SyphonMetalClient connected to a specific server.
 *
 * @param server_uuid  UUID string from SyphonServerInfo.uuid.
 * @return Opaque handle, or NULL on failure.
 */
SyphonClientHandle syphon_create_client(const char* server_uuid);

/**
 * Check if the client has received a new frame since last read.
 *
 * @return 1 if new frame available, 0 otherwise.
 */
int32_t syphon_has_new_frame(SyphonClientHandle client);

/**
 * Get the current frame dimensions.
 *
 * @param out_width   Pointer to receive width (0 if no frame yet).
 * @param out_height  Pointer to receive height (0 if no frame yet).
 * @param out_is_bgra Pointer to receive 1 if BGRA format, 0 if RGBA.
 */
void syphon_get_frame_info(SyphonClientHandle client,
                           uint32_t* out_width,
                           uint32_t* out_height,
                           int32_t* out_is_bgra);

/**
 * Copy the latest frame pixels into a CPU buffer.
 *
 * The buffer must be at least (width * height * 4) bytes.
 * Pixel format is the native texture format (typically BGRA8).
 * The Rust side handles BGRA→RGBA swizzle.
 *
 * @param out_buffer   Caller-allocated pixel buffer.
 * @param buffer_size  Size of out_buffer in bytes.
 * @return 1 on success, 0 if no frame available, -1 if buffer too small.
 */
int32_t syphon_copy_frame_pixels(SyphonClientHandle client,
                                 uint8_t* out_buffer,
                                 uint32_t buffer_size);

/**
 * Disconnect and release a Syphon client.
 */
void syphon_destroy_client(SyphonClientHandle client);

/**
 * Check if Syphon.framework is available at runtime.
 * @return 1 if available, 0 if not.
 */
int32_t syphon_is_available(void);

#ifdef __cplusplus
}
#endif

#endif /* SYPHON_BRIDGE_H */
