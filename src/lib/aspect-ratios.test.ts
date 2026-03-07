import { describe, it, expect } from "vitest";
import {
  COMMON_ASPECT_RATIOS,
  DEFAULT_ASPECT_RATIO_ID,
  getAspectRatioById,
  findAspectRatioByDimensions,
  inferAspectRatioId,
  computeHeightFromWidth,
  computeWidthFromHeight,
  resolveAspectRatioUiState,
  resolveProjectUiState,
  withAspectRatioUiState,
  fitAspectViewport,
} from "./aspect-ratios";

describe("COMMON_ASPECT_RATIOS", () => {
  it("is a non-empty array", () => {
    expect(COMMON_ASPECT_RATIOS.length).toBeGreaterThan(0);
  });

  it("includes 16:9", () => {
    expect(COMMON_ASPECT_RATIOS.some((r) => r.id === "16:9")).toBe(true);
  });
});

describe("DEFAULT_ASPECT_RATIO_ID", () => {
  it("is 16:9", () => {
    expect(DEFAULT_ASPECT_RATIO_ID).toBe("16:9");
  });
});

describe("getAspectRatioById", () => {
  it("returns the ratio for a valid id", () => {
    const ratio = getAspectRatioById("16:9");
    expect(ratio).not.toBeNull();
    expect(ratio!.width).toBe(16);
    expect(ratio!.height).toBe(9);
  });

  it("returns null for unknown id", () => {
    expect(getAspectRatioById("99:1")).toBeNull();
  });

  it("returns null for null", () => {
    expect(getAspectRatioById(null)).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(getAspectRatioById(undefined)).toBeNull();
  });
});

describe("findAspectRatioByDimensions", () => {
  it("finds 16:9 for 1920x1080", () => {
    const ratio = findAspectRatioByDimensions(1920, 1080);
    expect(ratio).not.toBeNull();
    expect(ratio!.id).toBe("16:9");
  });

  it("finds 4:3 for 1024x768", () => {
    const ratio = findAspectRatioByDimensions(1024, 768);
    expect(ratio).not.toBeNull();
    expect(ratio!.id).toBe("4:3");
  });

  it("finds 1:1 for square dimensions", () => {
    const ratio = findAspectRatioByDimensions(500, 500);
    expect(ratio).not.toBeNull();
    expect(ratio!.id).toBe("1:1");
  });

  it("returns null for non-standard ratio", () => {
    expect(findAspectRatioByDimensions(1000, 777)).toBeNull();
  });
});

describe("inferAspectRatioId", () => {
  it("returns 16:9 for 1920x1080", () => {
    expect(inferAspectRatioId(1920, 1080)).toBe("16:9");
  });

  it("returns default for non-standard dimensions", () => {
    expect(inferAspectRatioId(1000, 777)).toBe(DEFAULT_ASPECT_RATIO_ID);
  });
});

describe("computeHeightFromWidth", () => {
  it("computes 1080 for width=1920 at 16:9", () => {
    expect(computeHeightFromWidth(1920, "16:9")).toBe(1080);
  });

  it("computes 1440 for width=1920 at 4:3", () => {
    expect(computeHeightFromWidth(1920, "4:3")).toBe(1440);
  });

  it("computes square for 1:1", () => {
    expect(computeHeightFromWidth(800, "1:1")).toBe(800);
  });
});

describe("computeWidthFromHeight", () => {
  it("computes 1920 for height=1080 at 16:9", () => {
    expect(computeWidthFromHeight(1080, "16:9")).toBe(1920);
  });

  it("computes 1440 for height=1080 at 4:3", () => {
    expect(computeWidthFromHeight(1080, "4:3")).toBe(1440);
  });
});

describe("resolveAspectRatioUiState", () => {
  const output = { width: 1920, height: 1080 };

  it("returns defaults when uiState is null", () => {
    const result = resolveAspectRatioUiState(null, output);
    expect(result.lockEnabled).toBe(true);
    expect(result.ratioId).toBe("16:9");
  });

  it("reads lockEnabled and ratioId from uiState", () => {
    const uiState = {
      aspectRatio: { lockEnabled: false, ratioId: "4:3" },
    };
    const result = resolveAspectRatioUiState(uiState, output);
    expect(result.lockEnabled).toBe(false);
    expect(result.ratioId).toBe("4:3");
  });

  it("ignores invalid ratioId", () => {
    const uiState = {
      aspectRatio: { lockEnabled: true, ratioId: "bogus" },
    };
    const result = resolveAspectRatioUiState(uiState, output);
    // Should fall back to inferred ratio from output
    expect(result.ratioId).toBe("16:9");
  });
});

describe("resolveProjectUiState", () => {
  const output = { width: 1920, height: 1080 };

  it("returns object with aspectRatio when uiState is null", () => {
    const result = resolveProjectUiState(null, output);
    expect(result.aspectRatio).toBeDefined();
    expect(result.aspectRatio!.ratioId).toBe("16:9");
  });

  it("preserves extra properties from uiState", () => {
    const uiState = { customProp: 42 };
    const result = resolveProjectUiState(uiState, output);
    expect((result as Record<string, unknown>).customProp).toBe(42);
    expect(result.aspectRatio).toBeDefined();
  });
});

describe("withAspectRatioUiState", () => {
  it("returns object with aspectRatio set", () => {
    const result = withAspectRatioUiState(null, {
      lockEnabled: true,
      ratioId: "4:3",
    });
    expect(result).toEqual({ aspectRatio: { lockEnabled: true, ratioId: "4:3" } });
  });

  it("preserves existing properties", () => {
    const result = withAspectRatioUiState(
      { customProp: "hello" },
      { lockEnabled: false, ratioId: "16:9" }
    ) as Record<string, unknown>;
    expect(result.customProp).toBe("hello");
    expect(result.aspectRatio).toEqual({ lockEnabled: false, ratioId: "16:9" });
  });
});

describe("fitAspectViewport", () => {
  it("returns full container when lock is disabled", () => {
    const vp = fitAspectViewport(1920, 1080, 16, 9, false);
    expect(vp.x).toBe(0);
    expect(vp.y).toBe(0);
    expect(vp.w).toBe(1920);
    expect(vp.h).toBe(1080);
  });

  it("fits 16:9 content in a 16:9 container perfectly", () => {
    const vp = fitAspectViewport(1920, 1080, 16, 9, true);
    expect(vp.w).toBe(1920);
    expect(vp.h).toBe(1080);
    expect(vp.x).toBe(0);
    expect(vp.y).toBe(0);
  });

  it("letterboxes when container is wider than content", () => {
    // Container is 32:9, content is 16:9 => should pillarbox (bars on sides)
    const vp = fitAspectViewport(3200, 900, 16, 9, true);
    expect(vp.h).toBe(900);
    expect(vp.w).toBeLessThan(3200);
    expect(vp.x).toBeGreaterThan(0);
    expect(vp.y).toBe(0);
  });

  it("pillarboxes when container is taller than content", () => {
    // Container is 16:16 (square), content is 16:9 => bars on top/bottom
    const vp = fitAspectViewport(1600, 1600, 16, 9, true);
    expect(vp.w).toBe(1600);
    expect(vp.h).toBeLessThan(1600);
    expect(vp.x).toBe(0);
    expect(vp.y).toBeGreaterThan(0);
  });
});
