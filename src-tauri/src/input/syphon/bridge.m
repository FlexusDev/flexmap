/**
 * Syphon framework C bridge — runtime-loaded Objective-C implementation.
 *
 * Instead of linking against Syphon.framework at build time, this bridge
 * uses dlopen() and the ObjC runtime to load Syphon classes dynamically.
 * This means:
 *   - The bridge ALWAYS compiles (no Syphon headers/framework needed)
 *   - At runtime, it tries to load Syphon.framework from standard paths
 *   - If the user installs the framework later, syphon_try_load() can be
 *     called to pick it up without restarting the app
 */

#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#import <objc/runtime.h>
#import <dlfcn.h>
#include "bridge.h"

// ─── Dynamic Syphon state ────────────────────────────────────────────────────

static BOOL g_syphon_loaded = NO;
static void *g_syphon_handle = NULL;

// Dynamically resolved Syphon classes
static Class g_SyphonServerDirectory = Nil;
static Class g_SyphonMetalClient = Nil;

// Dynamically resolved Syphon string constants
static NSString *g_SyphonServerDescriptionNameKey = nil;
static NSString *g_SyphonServerDescriptionAppNameKey = nil;
static NSString *g_SyphonServerDescriptionUUIDKey = nil;

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

// ─── Dynamic framework loading ──────────────────────────────────────────────

static BOOL try_dlopen(const char *path) {
    void *handle = dlopen(path, RTLD_LAZY | RTLD_GLOBAL);
    if (!handle) {
        return NO;
    }

    // Resolve classes
    Class serverDir = NSClassFromString(@"SyphonServerDirectory");
    Class metalClient = NSClassFromString(@"SyphonMetalClient");

    if (!serverDir || !metalClient) {
        NSLog(@"[Syphon bridge]   -> loaded but classes not found (serverDir=%p metalClient=%p)",
              serverDir, metalClient);
        dlclose(handle);
        return NO;
    }

    // Resolve string constants via dlsym.
    // dlsym returns a pointer to the symbol storage (i.e. NSString **).
    // Under ARC we cannot use NSString** directly, so we read through CFTypeRef*.
    CFTypeRef *nameKeyPtr = (CFTypeRef *)dlsym(handle, "SyphonServerDescriptionNameKey");
    CFTypeRef *appNameKeyPtr = (CFTypeRef *)dlsym(handle, "SyphonServerDescriptionAppNameKey");
    CFTypeRef *uuidKeyPtr = (CFTypeRef *)dlsym(handle, "SyphonServerDescriptionUUIDKey");

    if (!nameKeyPtr || !appNameKeyPtr || !uuidKeyPtr) {
        NSLog(@"[Syphon bridge]   -> loaded but dictionary keys not found");
        dlclose(handle);
        return NO;
    }

    // Success — store everything
    g_syphon_handle = handle;
    g_SyphonServerDirectory = serverDir;
    g_SyphonMetalClient = metalClient;
    g_SyphonServerDescriptionNameKey = (__bridge NSString *)*nameKeyPtr;
    g_SyphonServerDescriptionAppNameKey = (__bridge NSString *)*appNameKeyPtr;
    g_SyphonServerDescriptionUUIDKey = (__bridge NSString *)*uuidKeyPtr;
    g_syphon_loaded = YES;

    NSLog(@"[Syphon bridge] Successfully loaded Syphon from: %s", path);
    return YES;
}

/// Try to load Syphon from a framework directory path (e.g. ".../Syphon.framework").
/// Tries multiple possible dylib locations within the framework bundle.
static BOOL try_load_framework(NSString *frameworkDir) {
    // Check if the .framework directory exists at all
    BOOL isDir = NO;
    if (![[NSFileManager defaultManager] fileExistsAtPath:frameworkDir isDirectory:&isDir] || !isDir) {
        return NO;
    }

    NSLog(@"[Syphon bridge] Found framework dir: %@, trying to dlopen...", frameworkDir);

    // Try multiple possible dylib locations within the framework bundle:
    // 1. Modern flat layout: Syphon.framework/Syphon
    // 2. Versioned layout: Syphon.framework/Versions/A/Syphon
    // 3. Versioned Current symlink: Syphon.framework/Versions/Current/Syphon
    NSArray<NSString *> *candidates = @[
        [frameworkDir stringByAppendingPathComponent:@"Syphon"],
        [frameworkDir stringByAppendingPathComponent:@"Versions/A/Syphon"],
        [frameworkDir stringByAppendingPathComponent:@"Versions/Current/Syphon"],
    ];

    for (NSString *candidate in candidates) {
        NSLog(@"[Syphon bridge]   trying: %@", candidate);
        if (try_dlopen(candidate.UTF8String)) {
            NSLog(@"[Syphon bridge]   -> SUCCESS");
            return YES;
        }
        NSLog(@"[Syphon bridge]   -> dlopen failed: %s", dlerror());
    }

    return NO;
}

static void try_load_syphon(void) {
    if (g_syphon_loaded) return;

    // Search for Syphon.framework in priority order
    NSString *home = NSHomeDirectory();
    NSArray<NSString *> *searchPaths = @[
        [home stringByAppendingPathComponent:@"Library/Frameworks/Syphon.framework"],
        @"/Library/Frameworks/Syphon.framework",
        @"/Applications/Synesthesia.app/Contents/Frameworks/Syphon.framework",
        @"/Applications/Resolume Arena.app/Contents/Frameworks/Syphon.framework",
        @"/Applications/Resolume Avenue.app/Contents/Frameworks/Syphon.framework",
        @"/Applications/VDMX5.app/Contents/Frameworks/Syphon.framework",
        @"/Applications/MadMapper.app/Contents/Frameworks/Syphon.framework",
        @"/Applications/Millumin3.app/Contents/Frameworks/Syphon.framework",
    ];

    for (NSString *path in searchPaths) {
        if (try_load_framework(path)) {
            return;
        }
    }

    NSLog(@"[Syphon bridge] Syphon.framework not found in any search path");
}

// Auto-load on library init
__attribute__((constructor))
static void syphon_bridge_init(void) {
    try_load_syphon();
}

// ─── Per-client wrapper ─────────────────────────────────────────────────────

// We store the SyphonMetalClient as an id (since we don't have the header)
@interface SyphonBridgeClient : NSObject
@property (nonatomic, strong) id client;  // SyphonMetalClient*
@property (nonatomic, assign) BOOL hasNewFrame;
@property (nonatomic, strong) id<MTLBuffer> stagingBuffer;
@property (nonatomic, assign) uint32_t stagingWidth;
@property (nonatomic, assign) uint32_t stagingHeight;
@end

@implementation SyphonBridgeClient
@end

// ─── Public API ─────────────────────────────────────────────────────────────

int32_t syphon_is_available(void) {
    return g_syphon_loaded ? 1 : 0;
}

// Allow re-trying load after framework install (called from Rust)
int32_t syphon_try_load(void) {
    if (g_syphon_loaded) return 1;
    try_load_syphon();
    return g_syphon_loaded ? 1 : 0;
}

int32_t syphon_list_servers(SyphonServerInfo* out_servers, int32_t max_servers) {
    if (!g_syphon_loaded || !out_servers || max_servers <= 0) return 0;

    @autoreleasepool {
        // [SyphonServerDirectory sharedDirectory]
        id directory = [g_SyphonServerDirectory performSelector:@selector(sharedDirectory)];
        if (!directory) {
            NSLog(@"[Syphon bridge] sharedDirectory returned nil");
            return 0;
        }

        // .servers
        NSArray *servers = [directory performSelector:@selector(servers)];
        if (!servers) {
            NSLog(@"[Syphon bridge] servers returned nil");
            return 0;
        }

        int32_t count = (int32_t)MIN(servers.count, (NSUInteger)max_servers);

        for (int32_t i = 0; i < count; i++) {
            NSDictionary *desc = servers[i];

            NSString *name    = desc[g_SyphonServerDescriptionNameKey]    ?: @"";
            NSString *appName = desc[g_SyphonServerDescriptionAppNameKey] ?: @"";
            NSString *uuid    = desc[g_SyphonServerDescriptionUUIDKey]    ?: @"";

            memset(&out_servers[i], 0, sizeof(SyphonServerInfo));
            strlcpy(out_servers[i].name,     name.UTF8String,    sizeof(out_servers[i].name));
            strlcpy(out_servers[i].app_name, appName.UTF8String, sizeof(out_servers[i].app_name));
            strlcpy(out_servers[i].uuid,     uuid.UTF8String,    sizeof(out_servers[i].uuid));
        }

        return count;
    }
}

SyphonClientHandle syphon_create_client(const char* server_uuid) {
    if (!g_syphon_loaded || !server_uuid) return NULL;
    if (!ensure_metal()) return NULL;

    @autoreleasepool {
        NSString *targetUUID = [NSString stringWithUTF8String:server_uuid];

        // Find the server description matching this UUID
        id directory = [g_SyphonServerDirectory performSelector:@selector(sharedDirectory)];
        NSArray *servers = [directory performSelector:@selector(servers)];
        NSDictionary *targetDesc = nil;

        for (NSDictionary *desc in servers) {
            NSString *uuid = desc[g_SyphonServerDescriptionUUIDKey];
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

        // Create SyphonMetalClient using alloc/init with selector
        // initWithServerDescription:device:options:newFrameHandler:
        __weak SyphonBridgeClient *weakWrapper = wrapper;

        // We need to use NSInvocation because the init method has 4 parameters
        SEL initSel = @selector(initWithServerDescription:device:options:newFrameHandler:);
        NSMethodSignature *sig = [g_SyphonMetalClient instanceMethodSignatureForSelector:initSel];
        if (!sig) {
            NSLog(@"[Syphon bridge] SyphonMetalClient doesn't respond to initWithServerDescription:device:options:newFrameHandler:");
            return NULL;
        }

        id client = [g_SyphonMetalClient alloc];
        NSInvocation *inv = [NSInvocation invocationWithMethodSignature:sig];
        [inv setTarget:client];
        [inv setSelector:initSel];

        NSDictionary *desc = targetDesc;
        id<MTLDevice> device = g_mtl_device;
        NSDictionary *options = nil;

        // The new frame handler block
        void (^handler)(id) = ^(id __unused _client) {
            SyphonBridgeClient *strong = weakWrapper;
            if (strong) {
                strong.hasNewFrame = YES;
            }
        };

        [inv setArgument:&desc atIndex:2];
        [inv setArgument:&device atIndex:3];
        [inv setArgument:&options atIndex:4];
        [inv setArgument:&handler atIndex:5];
        [inv invoke];

        id result = nil;
        [inv getReturnValue:&result];

        if (!result) {
            NSLog(@"[Syphon bridge] SyphonMetalClient creation failed");
            return NULL;
        }

        wrapper.client = result;

        NSLog(@"[Syphon bridge] Connected to server: %@ (%@)",
              targetDesc[g_SyphonServerDescriptionNameKey],
              targetDesc[g_SyphonServerDescriptionAppNameKey]);

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

        // [client newFrameImage] returns id<MTLTexture>
        id<MTLTexture> tex = [wrapper.client performSelector:@selector(newFrameImage)];

        if (!tex) {
            if (out_width)   *out_width  = 0;
            if (out_height)  *out_height = 0;
            if (out_is_bgra) *out_is_bgra = 1;
            return;
        }

        if (out_width)  *out_width  = (uint32_t)tex.width;
        if (out_height) *out_height = (uint32_t)tex.height;

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

        id<MTLTexture> tex = [wrapper.client performSelector:@selector(newFrameImage)];
        if (!tex) return 0;

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

        memcpy(out_buffer, wrapper.stagingBuffer.contents, totalBytes);

        return 1;
    }
}

void syphon_destroy_client(SyphonClientHandle handle) {
    if (!handle) return;

    @autoreleasepool {
        SyphonBridgeClient *wrapper = CFBridgingRelease(handle);
        if (wrapper.client) {
            [wrapper.client performSelector:@selector(stop)];
        }
        wrapper.client = nil;
        wrapper.stagingBuffer = nil;
        NSLog(@"[Syphon bridge] Client destroyed");
    }
}
