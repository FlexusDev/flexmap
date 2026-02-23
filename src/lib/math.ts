/**
 * gl-matrix based 2D math utilities for the editor.
 * Convention: Column-major matrices, post-multiply (gl-matrix default).
 * Coordinate space: normalized [0,1] for layer geometry, clip [-1,1] for GPU.
 */
import { mat3, vec2 } from "gl-matrix";

/**
 * Compose a 2D transform matrix from translation, rotation, and scale.
 * Order: Scale → Rotate → Translate (applied right-to-left in column-major).
 */
export function compose2DTransform(params: {
  tx: number;
  ty: number;
  rotationRad: number;
  sx: number;
  sy: number;
}): mat3 {
  const m = mat3.create();
  mat3.identity(m);
  mat3.translate(m, m, [params.tx, params.ty]);
  mat3.rotate(m, m, params.rotationRad);
  mat3.scale(m, m, [params.sx, params.sy]);
  return m;
}

/**
 * Compute a 3x3 homography matrix from 4 source → 4 destination point pairs.
 * Used for Quad (projective) warp.
 *
 * Source points are unit square corners: (0,0), (1,0), (1,1), (0,1)
 * Destination points are the quad's corner positions in normalized space.
 */
export function computeHomography(
  dst: [vec2, vec2, vec2, vec2]
): mat3 | null {
  // Map unit square to arbitrary quad using DLT (Direct Linear Transform)
  const src: [vec2, vec2, vec2, vec2] = [
    vec2.fromValues(0, 0),
    vec2.fromValues(1, 0),
    vec2.fromValues(1, 1),
    vec2.fromValues(0, 1),
  ];

  // Build 8x8 matrix for DLT
  // For each point pair (sx,sy) → (dx,dy):
  //   -sx -sy -1  0   0   0  sx*dx sy*dx dx
  //    0   0   0 -sx -sy  -1 sx*dy sy*dy dy
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [sx, sy] = [src[i][0], src[i][1]];
    const [dx, dy] = [dst[i][0], dst[i][1]];
    A.push([-sx, -sy, -1, 0, 0, 0, sx * dx, sy * dx, dx]);
    A.push([0, 0, 0, -sx, -sy, -1, sx * dy, sy * dy, dy]);
  }

  // Solve using simplified Gaussian elimination for 8x9 system
  // This is a well-known problem with an exact solution for 4 points
  const n = 8;
  const augmented = A.map((row) => [...row]);

  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxRow = col;
    let maxVal = Math.abs(augmented[col][col]);
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(augmented[row][col]) > maxVal) {
        maxVal = Math.abs(augmented[row][col]);
        maxRow = row;
      }
    }

    if (maxVal < 1e-10) return null; // Singular

    // Swap rows
    [augmented[col], augmented[maxRow]] = [augmented[maxRow], augmented[col]];

    // Eliminate
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = augmented[row][col] / augmented[col][col];
      for (let j = col; j <= n; j++) {
        augmented[row][j] -= factor * augmented[col][j];
      }
    }
  }

  // Extract solution
  const h = new Float32Array(9);
  for (let i = 0; i < n; i++) {
    h[i] = augmented[i][n] / augmented[i][i];
  }
  h[8] = 1.0;

  // Create mat3 (column-major)
  const result = mat3.create();
  result[0] = h[0];
  result[1] = h[3];
  result[2] = h[6];
  result[3] = h[1];
  result[4] = h[4];
  result[5] = h[7];
  result[6] = h[2];
  result[7] = h[5];
  result[8] = h[8];

  return result;
}

/**
 * Transform a point by a mat3 homography (with perspective division).
 */
export function transformPoint(m: mat3, p: vec2): vec2 {
  const x = m[0] * p[0] + m[3] * p[1] + m[6];
  const y = m[1] * p[0] + m[4] * p[1] + m[7];
  const w = m[2] * p[0] + m[5] * p[1] + m[8];

  if (Math.abs(w) < 1e-10) return vec2.fromValues(p[0], p[1]);
  return vec2.fromValues(x / w, y / w);
}

/**
 * Distance between two 2D points.
 */
export function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Clamp a value between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
