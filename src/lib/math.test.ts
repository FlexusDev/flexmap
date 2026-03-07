import { describe, it, expect } from "vitest";
import { vec2 } from "gl-matrix";
import {
  clamp,
  distance,
  hashPoints,
  compose2DTransform,
  computeHomography,
  transformPoint,
} from "./math";

describe("clamp", () => {
  it("returns value when within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("clamps to min when value is below", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  it("clamps to max when value is above", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("returns min when min equals max", () => {
    expect(clamp(5, 3, 3)).toBe(3);
  });

  it("handles negative ranges", () => {
    expect(clamp(-5, -10, -1)).toBe(-5);
    expect(clamp(0, -10, -1)).toBe(-1);
    expect(clamp(-20, -10, -1)).toBe(-10);
  });
});

describe("distance", () => {
  it("returns 0 for same point", () => {
    expect(distance({ x: 3, y: 4 }, { x: 3, y: 4 })).toBe(0);
  });

  it("calculates distance on x axis", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(3);
  });

  it("calculates distance on y axis", () => {
    expect(distance({ x: 0, y: 0 }, { x: 0, y: 4 })).toBe(4);
  });

  it("calculates diagonal distance (3-4-5 triangle)", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("is commutative", () => {
    const a = { x: 1, y: 2 };
    const b = { x: 4, y: 6 };
    expect(distance(a, b)).toBe(distance(b, a));
  });
});

describe("hashPoints", () => {
  it("returns a number", () => {
    const h = hashPoints([{ x: 0, y: 0 }]);
    expect(typeof h).toBe("number");
  });

  it("returns the same hash for the same points", () => {
    const points = [
      { x: 0.1, y: 0.2 },
      { x: 0.3, y: 0.4 },
    ];
    expect(hashPoints(points)).toBe(hashPoints(points));
  });

  it("returns different hashes for different points", () => {
    const h1 = hashPoints([{ x: 0.1, y: 0.2 }]);
    const h2 = hashPoints([{ x: 0.3, y: 0.4 }]);
    expect(h1).not.toBe(h2);
  });

  it("returns unsigned 32-bit integer (>= 0)", () => {
    const h = hashPoints([
      { x: -1, y: -2 },
      { x: 3, y: 4 },
    ]);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });

  it("returns a consistent hash for empty array", () => {
    // FNV-1a offset basis with no iterations
    expect(hashPoints([])).toBe(0x811c9dc5);
  });
});

describe("compose2DTransform", () => {
  it("returns identity for no transform", () => {
    const m = compose2DTransform({ tx: 0, ty: 0, rotationRad: 0, sx: 1, sy: 1 });
    // Identity matrix in column-major: [1,0,0, 0,1,0, 0,0,1]
    expect(m[0]).toBeCloseTo(1);
    expect(m[1]).toBeCloseTo(0);
    expect(m[3]).toBeCloseTo(0);
    expect(m[4]).toBeCloseTo(1);
    expect(m[6]).toBeCloseTo(0);
    expect(m[7]).toBeCloseTo(0);
  });

  it("applies translation", () => {
    const m = compose2DTransform({ tx: 2, ty: 3, rotationRad: 0, sx: 1, sy: 1 });
    // Translation is in m[6] and m[7] for column-major mat3
    expect(m[6]).toBeCloseTo(2);
    expect(m[7]).toBeCloseTo(3);
  });

  it("applies scale", () => {
    const m = compose2DTransform({ tx: 0, ty: 0, rotationRad: 0, sx: 2, sy: 3 });
    expect(m[0]).toBeCloseTo(2);
    expect(m[4]).toBeCloseTo(3);
  });

  it("applies rotation (90 degrees)", () => {
    const m = compose2DTransform({ tx: 0, ty: 0, rotationRad: Math.PI / 2, sx: 1, sy: 1 });
    // After 90 degree rotation: cos=0, sin=1
    expect(m[0]).toBeCloseTo(0);
    expect(m[1]).toBeCloseTo(1);
    expect(m[3]).toBeCloseTo(-1);
    expect(m[4]).toBeCloseTo(0);
  });
});

describe("computeHomography", () => {
  it("returns a matrix for unit square destination", () => {
    const dst: [vec2, vec2, vec2, vec2] = [
      vec2.fromValues(0, 0),
      vec2.fromValues(1, 0),
      vec2.fromValues(1, 1),
      vec2.fromValues(0, 1),
    ];
    const H = computeHomography(dst);
    expect(H).not.toBeNull();
  });

  it("returns a matrix for arbitrary quad", () => {
    const dst: [vec2, vec2, vec2, vec2] = [
      vec2.fromValues(0.1, 0.1),
      vec2.fromValues(0.9, 0.2),
      vec2.fromValues(0.8, 0.9),
      vec2.fromValues(0.2, 0.8),
    ];
    const H = computeHomography(dst);
    expect(H).not.toBeNull();
  });

  it("returns null for degenerate (collinear) points", () => {
    const dst: [vec2, vec2, vec2, vec2] = [
      vec2.fromValues(0, 0),
      vec2.fromValues(1, 0),
      vec2.fromValues(2, 0), // collinear
      vec2.fromValues(3, 0), // collinear
    ];
    const H = computeHomography(dst);
    expect(H).toBeNull();
  });
});

describe("transformPoint", () => {
  it("returns same point with identity matrix", () => {
    const identity = compose2DTransform({ tx: 0, ty: 0, rotationRad: 0, sx: 1, sy: 1 });
    const p = vec2.fromValues(0.5, 0.5);
    const result = transformPoint(identity, p);
    expect(result[0]).toBeCloseTo(0.5);
    expect(result[1]).toBeCloseTo(0.5);
  });

  it("applies translation from homography", () => {
    const m = compose2DTransform({ tx: 0.1, ty: 0.2, rotationRad: 0, sx: 1, sy: 1 });
    const p = vec2.fromValues(0, 0);
    const result = transformPoint(m, p);
    expect(result[0]).toBeCloseTo(0.1);
    expect(result[1]).toBeCloseTo(0.2);
  });
});
