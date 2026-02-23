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

/**
 * FNV-1a hash of a list of 2D points for fast geometry change detection.
 * ~10ns per point. Avoids JSON.stringify allocation.
 */
export function hashPoints(points: { x: number; y: number }[]): number {
  let h = 0x811c9dc5; // FNV-1a offset basis
  for (const p of points) {
    h ^= (p.x * 1e6) | 0;
    h = Math.imul(h, 0x01000193);
    h ^= (p.y * 1e6) | 0;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Draw a textured triangle using a 2D affine transform.
 * Computes the affine matrix that maps srcTri → dstTri via Cramer's rule,
 * then clips to dstTri, applies setTransform, and draws the source image.
 *
 * @param ctx    - destination canvas context
 * @param img    - source image (HTMLCanvasElement or ImageBitmap)
 * @param srcTri - 3 points in source image pixel space
 * @param dstTri - 3 points in destination canvas pixel space
 */
export function drawTriangleTextured(
  ctx: CanvasRenderingContext2D,
  img: HTMLCanvasElement | ImageBitmap,
  srcTri: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
  dstTri: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
): void {
  const [s0, s1, s2] = srcTri;
  const [d0, d1, d2] = dstTri;

  // Compute affine transform: src → dst
  // [a c e] [x]   [X]
  // [b d f] [y] = [Y]
  // [0 0 1] [1]   [1]
  // Using Cramer's rule on two 3×3 systems (one for X, one for Y)
  const det = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
  if (Math.abs(det) < 1e-10) return; // Degenerate triangle

  const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / det;
  const c = (s0.x * (d1.x - d2.x) + s1.x * (d2.x - d0.x) + s2.x * (d0.x - d1.x)) / det;
  const e = d0.x - a * s0.x - c * s0.y;

  const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / det;
  const dd = (s0.x * (d1.y - d2.y) + s1.x * (d2.y - d0.y) + s2.x * (d0.y - d1.y)) / det;
  const f = d0.y - b * s0.x - dd * s0.y;

  // Bounding box of srcTri for source-rect crop (limits pixel sampling area)
  const sMinX = Math.floor(Math.min(s0.x, s1.x, s2.x));
  const sMinY = Math.floor(Math.min(s0.y, s1.y, s2.y));
  const sMaxX = Math.ceil(Math.max(s0.x, s1.x, s2.x));
  const sMaxY = Math.ceil(Math.max(s0.y, s1.y, s2.y));

  // Expand clip triangle ~0.5px outward from centroid to avoid sub-pixel seams
  const centX = (d0.x + d1.x + d2.x) / 3;
  const centY = (d0.y + d1.y + d2.y) / 3;
  const EXPAND = 0.5;
  function expandPt(p: { x: number; y: number }) {
    const dx = p.x - centX;
    const dy = p.y - centY;
    const d = Math.hypot(dx, dy);
    if (d < 0.001) return p;
    return { x: p.x + (dx / d) * EXPAND, y: p.y + (dy / d) * EXPAND };
  }
  const cd0 = expandPt(d0);
  const cd1 = expandPt(d1);
  const cd2 = expandPt(d2);

  ctx.beginPath();
  ctx.moveTo(cd0.x, cd0.y);
  ctx.lineTo(cd1.x, cd1.y);
  ctx.lineTo(cd2.x, cd2.y);
  ctx.closePath();
  ctx.clip();

  // Apply affine transform and draw only the relevant source rect
  ctx.setTransform(a, b, c, dd, e, f);
  ctx.drawImage(img, sMinX, sMinY, sMaxX - sMinX, sMaxY - sMinY, sMinX, sMinY, sMaxX - sMinX, sMaxY - sMinY);
  ctx.resetTransform();
}
