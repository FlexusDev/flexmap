/**
 * Syphon framework C bridge — Objective-C implementation.
 *
 * Wraps SyphonServerDirectory and SyphonMetalClient into plain C functions.
 * Compiled by build.rs via the `cc` crate when `input-syphon` feature is enabled
 * and Syphon.framework is found at /Library/Frameworks/.
 */

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <Syphon/Syphon.h>
#include "bridge.h"

// ─── Global Metal state (lazily initialized) ────────────────────────────────

static id<MTLDevice>       g_mtl_device        = nil;
static id<MTLCommandQueue> g_mtl_command_queue  = nil;
static BOOL                g_metal_initialized  = NO;

static BOOL ensure_metal(void) {
    if (g_metal_initialized) return (g_mtl_device != nil);

    g_metal_initialized = YES;
    g_mtl_device = MTLCreateSystemDefaultDevice();
    if (!g_mtl_device) {
        NSLog(@"[Syphon bridge] MTLCreateSystemDefaultDevice() failed");
        return NO;
    }
    g_mtl_command_queue = [g_mtl_device newCommandQueue];
    if (!g_mtl_command_queue) {
        NSLog(@"[Syphon bridge] newCommandQueue failed");
        g_mtl_device = nil;
        return NO;
    }
    return YES;
}

// ─── Per-client wrapper ─────────────────────────────────────────────────────

@interface SyphonBridgeClient : NSObject
@property (nonatomic, strong) SyphonMetalClient *client;
@property (nonatomic, assign) BOOL hasNewFrame;
@property (nonatomic, strong) id<MTLBuffer> stagingBuffer;
@property (nonatomic, assign) uint32_t stagingWidth;
@property (nonatomic, assign) uint32_t stagingHeight;
@end

@implementation SyphonBridgeClient
@end

// ─── Server discovery ───────────────────────────────────────────────────────

int32_t syphon_list_servers(SyphonServerInfo* out_servers, int32_t max_servers) {
    if (!out_servers || max_servers <= 0) return 0;

    @autoreleasepool {
        NSArray *servers = [[SyphonServerDirectory sharedDirectory] servers];
        int32_t count = (int32_t)MIN(servers.count, (NSUInteger)max_servers);

        for (int32_t i = 0; i < count; i++) {
            NSDictionary *desc = servers[i];

            NSString *name    = desc[SyphonServerDescriptionNameKey]    ?: @"";
            NSString *appName = desc[SyphonServerDescriptionAppNameKey] ?: @"";
            NSString *uuid    = desc[SyphonServerDescriptionUUIDKey]    ?: @"";

            memset(&out_servers[i], 0, sizeof(SyphonServerInfo));
            strlcpy(out_servers[i].name,     name.UTF8String,    sizeof(out_servers[i].name));
            strlcpy(out_servers[i].app_name, appName.UTF8String, sizeof(out_servers[i].app_name));
            strlcpy(out_servers[i].uuid,     uuid.UTF8String,    sizeof(out_servers[i].uuid));
        }

        return count;
    }
}

// ─── Client lifecycle ───────────────────────────────────────────────────────

SyphonClientHandle syphon_create_client(const char* server_uuid) {
    if (!server_uuid) return NULL;
    if (!ensure_metal()) return NULL;

    @autoreleasepool {
        NSString *targetUUID = [NSString stringWithUTF8String:server_uuid];

        // Find the server description matching this UUID
        NSArray *servers = [[SyphonServerDirectory sharedDirectory] servers];
        NSDictionary *targetDesc = nil;

        for (NSDictionary *desc in servers) {
            NSString *uuid = desc[SyphonServerDescriptionUUIDKey];
            if ([uuid isEqualToString:targetUUID]) {
                targetDesc = desc;
                break;
            }
        }

        if (!targetDesc) {
            NSLog(@"[Syphon bridge] Server UUID not found: %@", targetUUID);
            return NULL;
        }

        // Create wrapper
        SyphonBridgeClient *wrapper = [[SyphonBridgeClient alloc] init];
        wrapper.hasNewFrame = NO;

        // Create SyphonMetalClient with new-frame callback
        __weak SyphonBridgeClient *weakWrapper = wrapper;
        wrapper.client = [[SyphonMetalClient alloc]
            initWithServerDescription:targetDesc
                               device:g_mtl_device
                              options:nil
                      newFrameHandler:^(SyphonMetalClient * _Nonnull client) {
            SyphonBridgeClient *strong = weakWrapper;
            if (strong) {
                strong.hasNewFrame = YES;
            }
        }];

        if (!wrapper.client) {
            NSLog(@"[Syphon bridge] SyphonMetalClient creation failed");
            return NULL;
        }

        NSLog(@"[Syphon bridge] Connected to server: %@ (%@)",
              targetDesc[SyphonServerDescriptionNameKey],
              targetDesc[SyphonServerDescriptionAppNameKey]);

        // Transfer ownership to the caller via CFBridgingRetain
        return (SyphonClientHandle)CFBridgingRetain(wrapper);
    }
}

int32_t syphon_has_new_frame(SyphonClientHandle handle) {
    if (!handle) return 0;
    SyphonBridgeClient *wrapper = (__bridge SyphonBridgeClient *)handle;
    return wrapper.hasNewFrame ? 1 : 0;
}

void syphon_get_frame_info(SyphonClientHandle handle,
                           uint32_t* out_width,
                           uint32_t* out_height,
                           int32_t* out_is_bgra) {
    if (!handle) {
        if (out_width)   *out_width  = 0;
        if (out_height)  *out_height = 0;
        if (out_is_bgra) *out_is_bgra = 1;
        return;
    }

    @autoreleasepool {
        SyphonBridgeClient *wrapper = (__bridge SyphonBridgeClient *)handle;
        id<MTLTexture> tex = [wrapper.client newFrameImage];

        if (!tex) {
            if (out_width)   *out_width  = 0;
            if (out_height)  *out_height = 0;
            if (out_is_bgra) *out_is_bgra = 1;
            return;
        }

        if (out_width)  *out_width  = (uint32_t)tex.width;
        if (out_height) *out_height = (uint32_t)tex.height;

        // Check pixel format
        if (out_is_bgra) {
            MTLPixelFormat fmt = tex.pixelFormat;
            *out_is_bgra = (fmt == MTLPixelFormatBGRA8Unorm ||
                            fmt == MTLPixelFormatBGRA8Unorm_sRGB) ? 1 : 0;
        }
    }
}

int32_t syphon_copy_frame_pixels(SyphonClientHandle handle,
                                 uint8_t* out_buffer,
                                 uint32_t buffer_size) {
    if (!handle || !out_buffer) return 0;

    @autoreleasepool {
        SyphonBridgeClient *wrapper = (__bridge SyphonBridgeClient *)handle;

        // Get the latest frame texture
        id<MTLTexture> tex = [wrapper.client newFrameImage];
        if (!tex) return 0;

        // Reset new-frame flag
        wrapper.hasNewFrame = NO;

        uint32_t width  = (uint32_t)tex.width;
        uint32_t height = (uint32_t)tex.height;
        uint32_t bytesPerRow = width * 4;
        uint32_t totalBytes  = bytesPerRow * height;

        if (buffer_size < totalBytes) return -1;
        if (width == 0 || height == 0) return 0;

        // For shared/managed textures, read directly
        MTLStorageMode storage = tex.storageMode;
        if (storage == MTLStorageModeShared || storage == MTLStorageModeManaged) {
            [tex getBytes:out_buffer
              bytesPerRow:bytesPerRow
               fromRegion:MTLRegionMake2D(0, 0, width, height)
              mipmapLevel:0];
            return 1;
        }

        // For private textures, blit to a staging buffer
        // Ensure staging buffer is large enough
        if (!wrapper.stagingBuffer ||
            wrapper.stagingWidth != width ||
            wrapper.stagingHeight != height) {

            wrapper.stagingBuffer = [g_mtl_device
                newBufferWithLength:totalBytes
                            options:MTLResourceStorageModeShared];
            wrapper.stagingWidth  = width;
            wrapper.stagingHeight = height;

            if (!wrapper.stagingBuffer) {
                NSLog(@"[Syphon bridge] Failed to allocate staging buffer (%u bytes)", totalBytes);
                return 0;
            }
        }

        id<MTLCommandBuffer> cmdBuf = [g_mtl_command_queue commandBuffer];
        if (!cmdBuf) return 0;

        id<MTLBlitCommandEncoder> blit = [cmdBuf blitCommandEncoder];
        if (!blit) return 0;

        [blit copyFromTexture:tex
                  sourceSlice:0
                  sourceLevel:0
                 sourceOrigin:MTLOriginMake(0, 0, 0)
                   sourceSize:MTLSizeMake(width, height, 1)
                     toBuffer:wrapper.stagingBuffer
            destinationOffset:0
       destinationBytesPerRow:bytesPerRow
     destinationBytesPerImage:totalBytes];

        [blit endEncoding];
        [cmdBuf commit];
        [cmdBuf waitUntilCompleted];

        // Copy from staging buffer to caller's buffer
        memcpy(out_buffer, wrapper.stagingBuffer.contents, totalBytes);

        return 1;
    }
}

void syphon_destroy_client(SyphonClientHandle handle) {
    if (!handle) return;

    @autoreleasepool {
        SyphonBridgeClient *wrapper = CFBridgingRelease(handle);
        [wrapper.client stop];
        wrapper.client = nil;
        wrapper.stagingBuffer = nil;
        NSLog(@"[Syphon bridge] Client destroyed");
    }
}

int32_t syphon_is_available(void) {
    // If this code is running, Syphon.framework was linked successfully
    return 1;
}
