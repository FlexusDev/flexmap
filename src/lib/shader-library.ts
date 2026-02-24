import type { InstalledShaderSourceDescriptor, ShaderLibraryEntry } from "../types";

const ISF_LIBRARY_CONTENTS_URL = "https://api.github.com/repos/Vidvox/ISF-Files/contents/ISF";
const ONLINE_CACHE_KEY = "auramap:isf_catalog_v1";
const METADATA_CACHE_KEY = "auramap:isf_metadata_v1";
const INSTALLED_LIBRARY_KEY = "auramap:isf_installed_library_v1";
const SOURCE_CACHE_KEY = "auramap:isf_source_cache_v1";
const ONLINE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const PREVIEW_PLASMA_FLOW = `
vec4 auraColor(vec2 uv, float t) {
  vec2 p = uv * 2.0 - 1.0;
  float wave = sin(p.x * 6.0 + t * 1.5) + sin(p.y * 7.0 - t * 1.1) + sin((p.x + p.y) * 4.5 + t * 0.8);
  vec3 col = 0.5 + 0.5 * cos(vec3(0.0, 2.0, 4.0) + wave + t * vec3(0.8, 0.4, 0.2));
  return vec4(col, 1.0);
}
`;

const PREVIEW_KALEIDO_SPIN = `
vec4 auraColor(vec2 uv, float t) {
  vec2 p = uv * 2.0 - 1.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  float mirrored = abs(sin(a * 6.0 + t));
  float rings = 0.5 + 0.5 * sin(r * 12.0 - t * 2.0);
  vec3 col = vec3(mirrored, rings, 1.0 - mirrored) * (1.1 - r);
  col += vec3(rings * 0.15, mirrored * 0.1, 0.08);
  return vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

const PREVIEW_TUNNEL_PULSE = `
vec4 auraColor(vec2 uv, float t) {
  vec2 p = uv * 2.0 - 1.0;
  float dist = max(length(p), 0.001);
  float ang = atan(p.y, p.x);
  float rings = 0.5 + 0.5 * sin((10.0 / dist) - t * 4.0);
  float spokes = 0.5 + 0.5 * sin(ang * 8.0 + t * 1.7);
  float pulse = 0.5 + 0.5 * sin(t * 2.2);
  float blend = rings * 0.6 + spokes * 0.4;
  vec3 col = vec3(
    blend * (0.35 + 0.65 * pulse),
    (blend * 0.75 + (1.0 - rings) * 0.25) * (0.45 + 0.55 * pulse),
    (1.0 - blend) * 0.7 + rings * 0.3
  );
  return vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

interface IsfGitHubContentItem {
  name: string;
  type: "file" | "dir" | string;
  html_url: string | null;
  download_url: string | null;
}

interface OnlineCachePayload {
  cachedAt: number;
  entries: ShaderLibraryEntry[];
}

interface IsfMetadataCachePayload {
  cachedAt: number;
  records: Record<string, IsfEntryMetadata>;
}

export interface InstalledIsfShaderRecord {
  entry: ShaderLibraryEntry;
  sourceCode: string;
  sourceHash: string;
  seed: number;
  installedAt: string;
}

interface InstalledLibraryPayload {
  updatedAt: number;
  records: Record<string, InstalledIsfShaderRecord>;
}

interface IsfSourceCachePayload {
  cachedAt: number;
  records: Record<string, string>;
}

export interface IsfEntryMetadata {
  description: string;
  categories: string[];
  credit: string;
  inputCount: number;
  passCount: number;
}

export interface OnlineCatalogResponse {
  entries: ShaderLibraryEntry[];
  fromCache: boolean;
}

export interface InstallIsfResult {
  entry: ShaderLibraryEntry;
  sourceHash: string;
}

export const BUNDLED_SHADER_LIBRARY: ShaderLibraryEntry[] = [
  {
    id: "library:plasma_flow",
    name: "Plasma Flow",
    author: "AuraMap",
    tags: ["plasma", "flow", "color"],
    thumbnailUrl: createShaderThumbnailDataUrl("shader:plasma_flow", "Plasma Flow"),
    sourceId: "shader:plasma_flow",
    isBundled: true,
    previewFragment: PREVIEW_PLASMA_FLOW,
    license: "MIT",
    sourceUrl: "https://github.com/Vidvox/ISF-Files",
  },
  {
    id: "library:kaleido_spin",
    name: "Kaleido Spin",
    author: "AuraMap",
    tags: ["kaleidoscope", "rotation", "radial"],
    thumbnailUrl: createShaderThumbnailDataUrl("shader:kaleido_spin", "Kaleido Spin"),
    sourceId: "shader:kaleido_spin",
    isBundled: true,
    previewFragment: PREVIEW_KALEIDO_SPIN,
    license: "MIT",
    sourceUrl: "https://github.com/Vidvox/ISF-Files",
  },
  {
    id: "library:tunnel_pulse",
    name: "Tunnel Pulse",
    author: "AuraMap",
    tags: ["tunnel", "pulse", "depth"],
    thumbnailUrl: createShaderThumbnailDataUrl("shader:tunnel_pulse", "Tunnel Pulse"),
    sourceId: "shader:tunnel_pulse",
    isBundled: true,
    previewFragment: PREVIEW_TUNNEL_PULSE,
    license: "MIT",
    sourceUrl: "https://github.com/Vidvox/ISF-Files",
  },
];

export function createShaderThumbnailDataUrl(id: string, title: string): string {
  const seed = hashString(id);
  const hueA = seed % 360;
  const hueB = (seed * 13 + 83) % 360;
  const safeTitle = escapeSvg(title);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
    <defs>
      <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="hsl(${hueA},75%,55%)" />
        <stop offset="100%" stop-color="hsl(${hueB},78%,45%)" />
      </linearGradient>
    </defs>
    <rect width="320" height="180" fill="url(#grad)" />
    <circle cx="250" cy="40" r="54" fill="rgba(255,255,255,0.18)" />
    <circle cx="62" cy="146" r="68" fill="rgba(0,0,0,0.2)" />
    <text x="14" y="152" fill="rgba(255,255,255,0.95)" font-size="22" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif">${safeTitle}</text>
  </svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function readCachedOnlineIsfCatalog(now = Date.now()): ShaderLibraryEntry[] {
  const payload = readCachePayload();
  if (!payload) return [];
  if (now - payload.cachedAt > ONLINE_CACHE_TTL_MS) return [];
  const normalized = normalizeCatalogEntries(payload.entries);
  // Migrate older cache records that didn't store downloadUrl.
  writeCachePayload({ cachedAt: payload.cachedAt, entries: normalized });
  return normalized;
}

export async function fetchOnlineIsfCatalog(
  opts: { force?: boolean; signal?: AbortSignal } = {}
): Promise<OnlineCatalogResponse> {
  const { force = false, signal } = opts;
  if (!force) {
    const cached = readCachedOnlineIsfCatalog();
    if (cached.length > 0) {
      return { entries: cached, fromCache: true };
    }
  }

  const response = await fetch(ISF_LIBRARY_CONTENTS_URL, {
    method: "GET",
    signal,
    headers: {
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    throw new Error(`ISF catalog request failed (${response.status})`);
  }

  const payload = await response.json() as IsfGitHubContentItem[];
  if (!Array.isArray(payload)) {
    throw new Error("ISF catalog response shape was invalid");
  }

  const entries = payload
    .filter((item) => item.type === "file" && item.name.toLowerCase().endsWith(".fs"))
    .map(mapIsfItemToLibraryEntry)
    .sort((a, b) => a.name.localeCompare(b.name));

  const normalized = normalizeCatalogEntries(entries);
  writeCachePayload({ cachedAt: Date.now(), entries: normalized });
  return { entries: normalized, fromCache: false };
}

function mapIsfItemToLibraryEntry(item: IsfGitHubContentItem): ShaderLibraryEntry {
  const shaderName = item.name.replace(/\.fs$/i, "").trim();
  const tags = inferTags(shaderName);
  return {
    id: `isf:${slugify(shaderName)}`,
    name: shaderName,
    author: "VIDVOX Community",
    tags,
    thumbnailUrl: createShaderThumbnailDataUrl(`isf:${shaderName}`, shaderName),
    categories: tags.filter((tag) => tag !== "isf"),
    isBundled: false,
    isInstalled: false,
    license: "MIT",
    downloadUrl: item.download_url ?? undefined,
    sourceUrl: item.html_url ?? item.download_url ?? "https://github.com/Vidvox/ISF-Files",
  };
}

export function readInstalledIsfLibrary(): Record<string, InstalledIsfShaderRecord> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(INSTALLED_LIBRARY_KEY);
    if (!raw) return {};
    const payload = JSON.parse(raw) as InstalledLibraryPayload;
    const records = payload.records ?? {};
    const normalized = normalizeInstalledRecords(records);
    // Migrate older schemas missing seed.
    writeInstalledIsfLibrary(normalized);
    return normalized;
  } catch {
    return {};
  }
}

export function readInstalledLibraryEntries(): ShaderLibraryEntry[] {
  const records = readInstalledIsfLibrary();
  return Object.values(records)
    .map((record) => ({
      ...record.entry,
      isInstalled: true,
      installedAt: record.installedAt,
      sourceCode: record.sourceCode,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function writeInstalledIsfLibrary(records: Record<string, InstalledIsfShaderRecord>): void {
  if (typeof window === "undefined") return;
  try {
    const payload: InstalledLibraryPayload = {
      updatedAt: Date.now(),
      records,
    };
    window.localStorage.setItem(INSTALLED_LIBRARY_KEY, JSON.stringify(payload));
  } catch {
    // ignore installed library write failures
  }
}

export function getInstalledShaderDescriptors(): InstalledShaderSourceDescriptor[] {
  const records = readInstalledIsfLibrary();
  return Object.values(records).map((record) => ({
    id: record.entry.id,
    name: record.entry.name,
    seed: record.seed,
    sourceHash: record.sourceHash,
    installedAt: record.installedAt,
    sourceCode: record.sourceCode,
  }));
}

export function getInstalledIsfSource(entryId: string): string | null {
  const records = readInstalledIsfLibrary();
  return records[entryId]?.sourceCode ?? null;
}

export async function getIsfSourceForEntry(
  entry: ShaderLibraryEntry,
  opts: { signal?: AbortSignal; force?: boolean } = {}
): Promise<string | null> {
  if (entry.isBundled && !entry.downloadUrl) return null;

  const installedSource = getInstalledIsfSource(entry.id);
  if (installedSource) return installedSource;

  const sourceCache = readSourceCachePayload();
  const isFresh = sourceCache && Date.now() - sourceCache.cachedAt <= ONLINE_CACHE_TTL_MS;
  if (!opts.force && isFresh) {
    const cachedSource = sourceCache.records[entry.id];
    if (cachedSource) return cachedSource;
  }

  const downloadUrl = resolveDownloadUrl(entry);
  if (!downloadUrl) return entry.sourceCode ?? null;

  const response = await fetch(downloadUrl, {
    method: "GET",
    signal: opts.signal,
  });
  if (!response.ok) {
    throw new Error(`ISF source request failed (${response.status})`);
  }

  const sourceCode = await response.text();
  const nextRecords = sourceCache?.records ? { ...sourceCache.records } : {};
  nextRecords[entry.id] = sourceCode;
  writeSourceCachePayload({
    cachedAt: Date.now(),
    records: nextRecords,
  });

  return sourceCode;
}

export function isInstalledEntry(entryId: string): boolean {
  const records = readInstalledIsfLibrary();
  return Boolean(records[entryId]);
}

export async function installOnlineIsfEntry(
  entry: ShaderLibraryEntry,
  opts: { signal?: AbortSignal } = {}
): Promise<InstallIsfResult> {
  if (!entry.downloadUrl) {
    throw new Error("Entry does not provide a downloadable ISF file");
  }

  const response = await fetch(entry.downloadUrl, {
    method: "GET",
    signal: opts.signal,
  });
  if (!response.ok) {
    throw new Error(`ISF install request failed (${response.status})`);
  }
  const sourceCode = await response.text();
  const parsed = parseIsfMetadata(sourceCode);
  const mergedEntry: ShaderLibraryEntry = {
    ...entry,
    categories: parsed?.categories.length ? parsed.categories : entry.categories,
    description: parsed?.description || entry.description,
    author: parsed?.credit || entry.author,
  };
  return persistInstalledEntry(mergedEntry, sourceCode);
}

export function uninstallInstalledIsfEntry(entryId: string): boolean {
  const records = readInstalledIsfLibrary();
  if (!records[entryId]) return false;
  delete records[entryId];
  writeInstalledIsfLibrary(records);
  return true;
}

export function importIsfSourceFromFile(
  fileName: string,
  sourceCode: string
): InstallIsfResult {
  const shaderName = fileName.replace(/\.[A-Za-z0-9]+$/, "").trim() || "Imported Shader";
  const parsed = parseIsfMetadata(sourceCode);
  const categories = parsed?.categories.length ? parsed.categories : inferTags(shaderName).filter((tag) => tag !== "isf");
  const tags = ["isf", ...categories].slice(0, 6);
  const id = `isf:${slugify(shaderName)}`;

  const entry: ShaderLibraryEntry = {
    id,
    name: shaderName,
    author: parsed?.credit || "Imported",
    tags,
    categories,
    description: parsed?.description || "",
    thumbnailUrl: createShaderThumbnailDataUrl(id, shaderName),
    downloadUrl: undefined,
    isBundled: false,
    isInstalled: true,
    license: "Unknown",
    sourceUrl: `local://isf/${slugify(shaderName)}`,
  };

  return persistInstalledEntry(entry, sourceCode);
}

export function readCachedIsfMetadata(): Record<string, IsfEntryMetadata> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(METADATA_CACHE_KEY);
    if (!raw) return {};
    const payload = JSON.parse(raw) as IsfMetadataCachePayload;
    if (Date.now() - payload.cachedAt > ONLINE_CACHE_TTL_MS) return {};
    return payload.records ?? {};
  } catch {
    return {};
  }
}

export function writeCachedIsfMetadata(records: Record<string, IsfEntryMetadata>): void {
  if (typeof window === "undefined") return;
  try {
    const payload: IsfMetadataCachePayload = {
      cachedAt: Date.now(),
      records,
    };
    window.localStorage.setItem(METADATA_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore metadata cache write failures
  }
}

export async function fetchIsfEntryMetadata(
  entry: ShaderLibraryEntry,
  opts: { signal?: AbortSignal } = {}
): Promise<IsfEntryMetadata | null> {
  if (!entry.downloadUrl) return null;
  const response = await fetch(entry.downloadUrl, {
    method: "GET",
    signal: opts.signal,
  });
  if (!response.ok) {
    throw new Error(`ISF source request failed (${response.status})`);
  }
  const source = await response.text();
  return parseIsfMetadata(source);
}

function parseIsfMetadata(source: string): IsfEntryMetadata | null {
  const start = source.indexOf("/*");
  if (start < 0) return null;
  const end = source.indexOf("*/", start + 2);
  if (end < 0) return null;
  const commentBody = source.slice(start + 2, end);
  const jsonStart = commentBody.indexOf("{");
  const jsonEnd = commentBody.lastIndexOf("}");
  if (jsonStart < 0 || jsonEnd < 0 || jsonEnd <= jsonStart) return null;

  try {
    const raw = commentBody.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(raw) as {
      DESCRIPTION?: unknown;
      CATEGORIES?: unknown;
      CREDIT?: unknown;
      AUTHOR?: unknown;
      INPUTS?: unknown;
      PASSES?: unknown;
    };

    const categories = normalizeCategories(parsed.CATEGORIES);
    const description = typeof parsed.DESCRIPTION === "string"
      ? parsed.DESCRIPTION.trim()
      : "";
    const credit = typeof parsed.CREDIT === "string"
      ? parsed.CREDIT.trim()
      : typeof parsed.AUTHOR === "string"
        ? parsed.AUTHOR.trim()
        : "";
    const inputCount = Array.isArray(parsed.INPUTS) ? parsed.INPUTS.length : 0;
    const passCount = Array.isArray(parsed.PASSES) ? parsed.PASSES.length : 0;

    return {
      description,
      categories,
      credit,
      inputCount,
      passCount,
    };
  } catch {
    return null;
  }
}

function persistInstalledEntry(
  entry: ShaderLibraryEntry,
  sourceCode: string
): InstallIsfResult {
  const sourceHash = hashString(sourceCode).toString(16).padStart(8, "0");
  const seed = parseInt(sourceHash, 16) >>> 0;
  const installedAt = new Date().toISOString();
  const installedEntry: ShaderLibraryEntry = {
    ...entry,
    isInstalled: true,
    installedAt,
    sourceId: entry.id,
  };

  const records = readInstalledIsfLibrary();
  records[installedEntry.id] = {
    entry: installedEntry,
    sourceCode,
    sourceHash,
    seed,
    installedAt,
  };
  writeInstalledIsfLibrary(records);

  return { entry: installedEntry, sourceHash };
}

function normalizeInstalledRecords(
  records: Record<string, InstalledIsfShaderRecord>
): Record<string, InstalledIsfShaderRecord> {
  const normalized: Record<string, InstalledIsfShaderRecord> = {};
  for (const [id, record] of Object.entries(records)) {
    const sourceHash = (record.sourceHash || hashString(record.sourceCode || "").toString(16)).padStart(8, "0");
    const seed = typeof record.seed === "number" && Number.isFinite(record.seed)
      ? (record.seed >>> 0)
      : (parseInt(sourceHash, 16) >>> 0);
    normalized[id] = {
      ...record,
      sourceHash,
      seed,
    };
  }
  return normalized;
}

function normalizeCategories(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter((entry) => entry.length > 0);
  }
  if (typeof input === "string" && input.trim().length > 0) {
    return input
      .split(/[;,/]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function normalizeCatalogEntries(entries: ShaderLibraryEntry[]): ShaderLibraryEntry[] {
  return entries.map((entry) => {
    const downloadUrl = resolveDownloadUrl(entry);
    return {
      ...entry,
      downloadUrl,
      isBundled: Boolean(entry.isBundled),
      isInstalled: Boolean(entry.isInstalled),
      tags: Array.isArray(entry.tags) ? entry.tags : [],
      categories: Array.isArray(entry.categories) ? entry.categories : [],
      thumbnailUrl: entry.thumbnailUrl || createShaderThumbnailDataUrl(entry.id, entry.name),
      sourceUrl: entry.sourceUrl || downloadUrl || "https://github.com/Vidvox/ISF-Files",
    };
  });
}

function resolveDownloadUrl(entry: ShaderLibraryEntry): string | undefined {
  const existing = entry.downloadUrl?.trim();
  if (existing) return existing;

  const sourceUrl = entry.sourceUrl?.trim() ?? "";
  if (!sourceUrl) return undefined;

  if (sourceUrl.startsWith("https://raw.githubusercontent.com/")) {
    return sourceUrl;
  }

  const githubBlobPrefix = "https://github.com/Vidvox/ISF-Files/blob/";
  if (sourceUrl.startsWith(githubBlobPrefix)) {
    return sourceUrl.replace(
      githubBlobPrefix,
      "https://raw.githubusercontent.com/Vidvox/ISF-Files/"
    );
  }

  return undefined;
}

function inferTags(shaderName: string): string[] {
  const parts = shaderName
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length >= 3);

  const tags = ["isf"];
  for (const part of parts) {
    if (tags.includes(part)) continue;
    tags.push(part);
    if (tags.length >= 5) break;
  }
  return tags;
}

function readCachePayload(): OnlineCachePayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(ONLINE_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as OnlineCachePayload;
  } catch {
    return null;
  }
}

function writeCachePayload(payload: OnlineCachePayload): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ONLINE_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore cache write failures
  }
}

function readSourceCachePayload(): IsfSourceCachePayload | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SOURCE_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as IsfSourceCachePayload;
  } catch {
    return null;
  }
}

function writeSourceCachePayload(payload: IsfSourceCachePayload): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SOURCE_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // ignore cache write failures
  }
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function escapeSvg(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
