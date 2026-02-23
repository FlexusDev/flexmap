import type {
  AspectRatioId,
  AspectRatioUiState,
  ProjectUiState,
} from "../types";

export type AspectRatioOption = {
  id: AspectRatioId;
  label: string;
  width: number;
  height: number;
};

export const COMMON_ASPECT_RATIOS: AspectRatioOption[] = [
  { id: "1:1", label: "1:1 (Square)", width: 1, height: 1 },
  { id: "4:3", label: "4:3", width: 4, height: 3 },
  { id: "5:4", label: "5:4", width: 5, height: 4 },
  { id: "3:2", label: "3:2", width: 3, height: 2 },
  { id: "16:10", label: "16:10", width: 16, height: 10 },
  { id: "16:9", label: "16:9", width: 16, height: 9 },
  { id: "17:9", label: "17:9", width: 17, height: 9 },
  { id: "21:9", label: "21:9", width: 21, height: 9 },
  { id: "32:9", label: "32:9", width: 32, height: 9 },
  { id: "9:16", label: "9:16 (Portrait)", width: 9, height: 16 },
  { id: "3:4", label: "3:4 (Portrait)", width: 3, height: 4 },
];

export const DEFAULT_ASPECT_RATIO_ID: AspectRatioId = "16:9";

export type ViewportRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.round(value));
}

function normalizeOffset(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function isAspectRatioId(value: unknown): value is AspectRatioId {
  return COMMON_ASPECT_RATIOS.some((ratio) => ratio.id === value);
}

export function getAspectRatioById(id: string | null | undefined): AspectRatioOption | null {
  if (!id) return null;
  return COMMON_ASPECT_RATIOS.find((ratio) => ratio.id === id) ?? null;
}

export function findAspectRatioByDimensions(
  width: number,
  height: number
): AspectRatioOption | null {
  const w = normalizeDimension(width);
  const h = normalizeDimension(height);
  return COMMON_ASPECT_RATIOS.find((ratio) => ratio.width * h === ratio.height * w) ?? null;
}

export function inferAspectRatioId(width: number, height: number): AspectRatioId {
  return findAspectRatioByDimensions(width, height)?.id ?? DEFAULT_ASPECT_RATIO_ID;
}

export function computeHeightFromWidth(width: number, ratioId: AspectRatioId): number {
  const ratio = getAspectRatioById(ratioId) ?? getAspectRatioById(DEFAULT_ASPECT_RATIO_ID)!;
  return normalizeDimension((normalizeDimension(width) * ratio.height) / ratio.width);
}

export function computeWidthFromHeight(height: number, ratioId: AspectRatioId): number {
  const ratio = getAspectRatioById(ratioId) ?? getAspectRatioById(DEFAULT_ASPECT_RATIO_ID)!;
  return normalizeDimension((normalizeDimension(height) * ratio.width) / ratio.height);
}

export function resolveAspectRatioUiState(
  uiState: unknown,
  output: { width: number; height: number }
): AspectRatioUiState {
  const fallbackRatioId = inferAspectRatioId(output.width, output.height);
  let lockEnabled = true;
  let ratioId = fallbackRatioId;

  if (isRecord(uiState) && isRecord(uiState.aspectRatio)) {
    const aspect = uiState.aspectRatio;
    if (typeof aspect.lockEnabled === "boolean") {
      lockEnabled = aspect.lockEnabled;
    }
    if (isAspectRatioId(aspect.ratioId)) {
      ratioId = aspect.ratioId;
    }
  }

  return { lockEnabled, ratioId };
}

export function resolveProjectUiState(
  uiState: unknown,
  output: { width: number; height: number }
): ProjectUiState {
  const base: ProjectUiState = isRecord(uiState)
    ? { ...(uiState as Record<string, unknown>) }
    : {};
  base.aspectRatio = resolveAspectRatioUiState(uiState, output);
  return base;
}

export function withAspectRatioUiState(
  uiState: unknown,
  nextAspect: AspectRatioUiState
): unknown {
  const next: Record<string, unknown> = isRecord(uiState)
    ? { ...uiState }
    : {};
  next.aspectRatio = {
    lockEnabled: nextAspect.lockEnabled,
    ratioId: nextAspect.ratioId,
  };
  return next;
}

export function fitAspectViewport(
  containerWidth: number,
  containerHeight: number,
  aspectWidth: number,
  aspectHeight: number,
  lockEnabled: boolean
): ViewportRect {
  const cw = normalizeDimension(containerWidth);
  const ch = normalizeDimension(containerHeight);

  if (!lockEnabled) {
    return { x: 0, y: 0, w: cw, h: ch };
  }

  const aw = normalizeDimension(aspectWidth);
  const ah = normalizeDimension(aspectHeight);
  const target = aw / ah;
  const container = cw / ch;

  if (container > target) {
    const h = ch;
    const w = Math.min(cw, normalizeDimension(h * target));
    return {
      x: normalizeOffset((cw - w) / 2),
      y: 0,
      w,
      h,
    };
  }

  const w = cw;
  const h = Math.min(ch, normalizeDimension(w / target));
  return {
    x: 0,
    y: normalizeOffset((ch - h) / 2),
    w,
    h,
  };
}
