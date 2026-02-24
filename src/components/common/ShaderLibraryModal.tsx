import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { useAppStore } from "../../store/useAppStore";
import type { ShaderLibraryEntry } from "../../types";
import {
  BUNDLED_SHADER_LIBRARY,
  fetchIsfEntryMetadata,
  getIsfSourceForEntry,
  fetchOnlineIsfCatalog,
  importIsfSourceFromFile,
  installOnlineIsfEntry,
  type IsfEntryMetadata,
  readInstalledLibraryEntries,
  readCachedIsfMetadata,
  readCachedOnlineIsfCatalog,
  RateLimitError,
  uninstallInstalledIsfEntry,
  writeCachedIsfMetadata,
} from "../../lib/shader-library";
import { renderIsfSourceThumbnail, renderShaderThumbnail } from "../../lib/shader-thumbnail";
import ShaderPreviewCanvas from "./ShaderPreviewCanvas";

interface ShaderLibraryModalProps {
  open: boolean;
  onClose: () => void;
  hasSelection: boolean;
  onApplySource: (sourceId: string) => Promise<void> | void;
}

function ShaderLibraryModal({
  open,
  onClose,
  hasSelection,
  onApplySource,
}: ShaderLibraryModalProps) {
  const projectorWindowOpen = useAppStore((s) => s.projectorWindowOpen);
  const addToast = useAppStore((s) => s.addToast);
  const refreshSources = useAppStore((s) => s.refreshSources);
  const syncProjectorWindowState = useAppStore((s) => s.syncProjectorWindowState);

  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<"all" | "bundled" | "online" | "installed">("all");
  const [onlineEntries, setOnlineEntries] = useState<ShaderLibraryEntry[]>([]);
  const [installedEntries, setInstalledEntries] = useState<ShaderLibraryEntry[]>([]);
  const [isFetching, setIsFetching] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const [selectedId, setSelectedId] = useState(BUNDLED_SHADER_LIBRARY[0]?.id ?? "");
  const [tabVisible, setTabVisible] = useState(true);
  const [thumbnailOverrides, setThumbnailOverrides] = useState<Record<string, string>>({});
  const [metadataById, setMetadataById] = useState<Record<string, IsfEntryMetadata>>({});
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [bundledThumbsHydrated, setBundledThumbsHydrated] = useState(false);
  const [sourceById, setSourceById] = useState<Record<string, string>>({});
  const [hoveredGridId, setHoveredGridId] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const metadataReqRef = useRef<AbortController | null>(null);
  const sourceReqRef = useRef<AbortController | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const fetchingRef = useRef(false);

  const allEntries = useMemo(() => {
    const combined = new Map<string, ShaderLibraryEntry>();
    const installedIds = new Set(installedEntries.map((entry) => entry.id));
    for (const entry of BUNDLED_SHADER_LIBRARY) combined.set(entry.id, entry);
    for (const entry of installedEntries) combined.set(entry.id, entry);
    for (const entry of onlineEntries) {
      const existing = combined.get(entry.id);
      if (existing?.isInstalled) continue;
      combined.set(entry.id, { ...entry, isInstalled: installedIds.has(entry.id) });
    }
    return Array.from(combined.values());
  }, [onlineEntries, installedEntries]);

  const query = search.trim().toLowerCase();
  const filteredEntries = useMemo(() => {
    if (!query) return allEntries;
    return allEntries.filter((entry) => {
      const haystack = `${entry.name} ${entry.author} ${entry.tags.join(" ")}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [allEntries, query]);

  const scopeEntries = useMemo(() => {
    if (scope === "all") return filteredEntries;
    if (scope === "bundled") return filteredEntries.filter((entry) => entry.isBundled);
    if (scope === "installed") return filteredEntries.filter((entry) => entry.isInstalled);
    return filteredEntries.filter((entry) => !entry.isBundled && !entry.isInstalled);
  }, [filteredEntries, scope]);

  const selectedEntry = useMemo(() => {
    if (scopeEntries.length === 0) return null;
    return scopeEntries.find((entry) => entry.id === selectedId) ?? scopeEntries[0];
  }, [scopeEntries, selectedId]);

  const previewEnabled = open && !projectorWindowOpen && tabVisible;

  useEffect(() => {
    if (!open) return;
    void syncProjectorWindowState();
    const cached = readCachedOnlineIsfCatalog();
    if (cached.length > 0) {
      setOnlineEntries(cached);
    }
    setInstalledEntries(readInstalledLibraryEntries());
    setMetadataById(readCachedIsfMetadata());
    setTabVisible(document.visibilityState !== "hidden");
  }, [open, syncProjectorWindowState]);

  useEffect(() => {
    if (!open || bundledThumbsHydrated) return;
    const next: Record<string, string> = {};
    for (const entry of BUNDLED_SHADER_LIBRARY) {
      if (!entry.previewFragment) continue;
      const rendered = renderShaderThumbnail(entry.previewFragment, { width: 320, height: 180 });
      if (rendered) {
        next[entry.id] = rendered;
      }
    }
    if (Object.keys(next).length > 0) {
      setThumbnailOverrides((current) => ({ ...current, ...next }));
    }
    setBundledThumbsHydrated(true);
  }, [open, bundledThumbsHydrated]);

  useEffect(() => {
    if (!selectedEntry || selectedEntry.id === selectedId) return;
    setSelectedId(selectedEntry.id);
  }, [selectedEntry, selectedId]);

  // Clear grid hover when entry list changes
  useEffect(() => {
    setHoveredGridId(null);
  }, [scopeEntries]);

  useEffect(() => {
    if (!open) return;
    const onVisibilityChange = () => setTabVisible(document.visibilityState !== "hidden");
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (open) return;
    requestRef.current?.abort();
    metadataReqRef.current?.abort();
    sourceReqRef.current?.abort();
    requestRef.current = null;
    metadataReqRef.current = null;
    sourceReqRef.current = null;
    fetchingRef.current = false;
    setIsFetching(false);
    setIsInstalling(false);
    setMetadataLoading(false);
  }, [open]);

  useEffect(() => {
    return () => {
      requestRef.current?.abort();
      metadataReqRef.current?.abort();
      sourceReqRef.current?.abort();
      requestRef.current = null;
      metadataReqRef.current = null;
      sourceReqRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (installedEntries.length === 0) return;
    const next: Record<string, string> = {};
    for (const entry of installedEntries) {
      if (!entry.sourceCode) continue;
      next[entry.id] = entry.sourceCode;
    }
    if (Object.keys(next).length === 0) return;
    setSourceById((current) => ({ ...current, ...next }));
  }, [installedEntries]);

  useEffect(() => {
    if (!open || onlineEntries.length === 0) return;
    let cancelled = false;
    const controller = new AbortController();

    const hydrate = async () => {
      const candidates = onlineEntries
        .filter((entry) => !entry.isBundled)
        .slice(0, 18);

      for (const entry of candidates) {
        if (cancelled) break;
        if (thumbnailOverrides[entry.id]) continue;

        let sourceCode: string | null = sourceById[entry.id] ?? entry.sourceCode ?? null;
        if (!sourceCode) {
          try {
            sourceCode = await getIsfSourceForEntry(entry, { signal: controller.signal });
          } catch {
            continue;
          }
        }
        if (cancelled || !sourceCode?.trim()) continue;

        const rendered = renderIsfSourceThumbnail(sourceCode, { width: 320, height: 180 });
        if (!rendered) continue;

        setSourceById((current) =>
          current[entry.id] ? current : { ...current, [entry.id]: sourceCode as string }
        );
        setThumbnailOverrides((current) =>
          current[entry.id] ? current : { ...current, [entry.id]: rendered }
        );
      }
    };

    void hydrate();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, onlineEntries]);

  useEffect(() => {
    if (!open) return;
    setThumbnailOverrides((current) => {
      const additions: Record<string, string> = {};
      for (const entry of allEntries) {
        if (current[entry.id]) continue;
        const sourceCode = sourceById[entry.id] ?? entry.sourceCode;
        if (!sourceCode?.trim()) continue;
        const rendered = renderIsfSourceThumbnail(sourceCode, { width: 320, height: 180 });
        if (rendered) {
          additions[entry.id] = rendered;
        }
      }
      if (Object.keys(additions).length === 0) return current;
      return { ...current, ...additions };
    });
  }, [open, allEntries, sourceById]);

  useEffect(() => {
    if (!open || !selectedEntry || selectedEntry.isBundled || selectedEntry.isInstalled) {
      setMetadataLoading(false);
      metadataReqRef.current?.abort();
      metadataReqRef.current = null;
      return;
    }

    if (metadataById[selectedEntry.id]) {
      setMetadataLoading(false);
      return;
    }

    metadataReqRef.current?.abort();
    const controller = new AbortController();
    metadataReqRef.current = controller;
    setMetadataLoading(true);

    void fetchIsfEntryMetadata(selectedEntry, { signal: controller.signal })
      .then((metadata) => {
        if (controller.signal.aborted || !metadata) return;
        setMetadataById((current) => {
          const next = { ...current, [selectedEntry.id]: metadata };
          writeCachedIsfMetadata(next);
          return next;
        });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.error("Failed to load ISF metadata:", error);
      })
      .finally(() => {
        if (metadataReqRef.current === controller) {
          metadataReqRef.current = null;
          setMetadataLoading(false);
        }
      });
  }, [open, selectedEntry, metadataById]);

  useEffect(() => {
    if (!open || projectorWindowOpen || !selectedEntry) {
      sourceReqRef.current?.abort();
      sourceReqRef.current = null;
      return;
    }

    if (selectedEntry.previewFragment) return;
    if (sourceById[selectedEntry.id] || selectedEntry.sourceCode) return;

    sourceReqRef.current?.abort();
    const controller = new AbortController();
    sourceReqRef.current = controller;

    void getIsfSourceForEntry(selectedEntry, { signal: controller.signal })
      .then((sourceCode) => {
        if (controller.signal.aborted || !sourceCode) return;
        setSourceById((current) => ({ ...current, [selectedEntry.id]: sourceCode }));
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        console.error("Failed to load ISF source for preview:", error);
      })
      .finally(() => {
        if (sourceReqRef.current === controller) {
          sourceReqRef.current = null;
        }
      });
  }, [open, projectorWindowOpen, selectedEntry, sourceById]);

  const handleFetchOnline = async (force = true) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setIsFetching(true);

    try {
      const result = await fetchOnlineIsfCatalog({ force, signal: controller.signal });
      if (controller.signal.aborted) return;
      setOnlineEntries(result.entries);
      addToast(
        result.fromCache
          ? `Loaded ${result.entries.length} ISF shaders from cache`
          : `Fetched ${result.entries.length} ISF shaders`,
        "info"
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("[ISF-diag] handleFetchOnline: failed:", error);

      const isRateLimit = error instanceof RateLimitError;
      if (isRateLimit) {
        const rle = error as RateLimitError;
        const resetLabel = rle.resetAt ? ` Resets at ${rle.resetAt.toLocaleTimeString()}.` : "";
        addToast(
          `GitHub API rate limit reached.${resetLabel} Add a GitHub token in Settings to increase the limit.`,
          "error"
        );
      }

      const cached = readCachedOnlineIsfCatalog();
      if (cached.length > 0) {
        setOnlineEntries(cached);
        if (!isRateLimit) {
          addToast("Could not reach ISF online catalog. Showing cached entries.", "warning");
        }
      } else if (!isRateLimit) {
        addToast("Could not reach ISF online catalog. Showing bundled shaders only.", "warning");
      }
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
      }
      fetchingRef.current = false;
      setIsFetching(false);
    }
  };

  const handleInstall = async () => {
    if (!selectedEntry || selectedEntry.isBundled || selectedEntry.isInstalled) return;
    if (!selectedEntry.downloadUrl) {
      addToast("This entry does not expose a downloadable ISF file.", "warning");
      return;
    }
    if (isInstalling) return;

    setIsInstalling(true);
    try {
      const result = await installOnlineIsfEntry(selectedEntry);
      setInstalledEntries(readInstalledLibraryEntries());
      setOnlineEntries((current) =>
        current.map((entry) => (entry.id === result.entry.id ? { ...entry, isInstalled: true } : entry))
      );
      setSelectedId(result.entry.id);
      await refreshSources();
      addToast(`Installed "${result.entry.name}" to local library`, "info");
    } catch (error) {
      console.error("Failed to install ISF entry:", error);
      addToast("Failed to install ISF entry", "error");
    } finally {
      setIsInstalling(false);
    }
  };

  const handleRemoveInstalled = () => {
    if (!selectedEntry?.isInstalled || selectedEntry.isBundled) return;
    const removed = uninstallInstalledIsfEntry(selectedEntry.id);
    if (!removed) return;
    setInstalledEntries(readInstalledLibraryEntries());
    setOnlineEntries((current) =>
      current.map((entry) => (entry.id === selectedEntry.id ? { ...entry, isInstalled: false } : entry))
    );
    void refreshSources();
    addToast(`Removed "${selectedEntry.name}" from local library`, "info");
  };

  const handleImportFileSelect = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const sourceCode = await file.text();
      const result = importIsfSourceFromFile(file.name, sourceCode);
      setInstalledEntries(readInstalledLibraryEntries());
      setSelectedId(result.entry.id);
      await refreshSources();
      addToast(`Imported "${result.entry.name}" to local library`, "info");
    } catch (error) {
      console.error("Failed to import ISF file:", error);
      addToast("Failed to import ISF file", "error");
    }
  };

  const handleImportClick = () => {
    importInputRef.current?.click();
  };

  const handleApply = async () => {
    if (!selectedEntry?.sourceId || !hasSelection) return;
    try {
      console.info("[ShaderLibrary] Applying source", {
        entryId: selectedEntry.id,
        sourceId: selectedEntry.sourceId,
      });
      await onApplySource(selectedEntry.sourceId);
      addToast(`Assigned "${selectedEntry.name}" to selected layers`, "info");
      onClose();
    } catch (error) {
      console.error("Failed to apply shader source:", error);
      addToast("Failed to assign shader source", "error");
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-6xl h-[82vh] bg-aura-surface border border-aura-border rounded-lg shadow-2xl flex flex-col min-h-0"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-aura-border">
          <div>
            <div className="text-sm font-semibold text-aura-text">Shader Library</div>
            <div className="text-[11px] text-aura-text-dim">
              Bundled shaders are assignable now. Online ISF entries can be installed into a local library.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="btn-ghost text-xs px-3 py-1"
              onClick={handleImportClick}
              title="Import local ISF shader file"
            >
              Import .fs
            </button>
            <button
              className="btn-ghost text-xs px-3 py-1"
              onClick={() => void handleFetchOnline(true)}
              disabled={isFetching}
              title="Fetch online ISF catalog"
            >
              {isFetching ? "Fetching..." : "Refresh ISF"}
            </button>
            <button className="btn-ghost text-xs px-3 py-1" onClick={onClose}>
              Close
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept=".fs,.frag,.glsl,text/plain"
              className="hidden"
              onChange={(event) => void handleImportFileSelect(event)}
            />
          </div>
        </div>

        <div className="px-4 py-3 border-b border-aura-border flex items-center gap-2">
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name, author, or tags"
            className="w-full bg-aura-bg border border-aura-border rounded px-3 py-1.5 text-xs text-aura-text outline-none focus:border-aura-success"
          />
          <div className="flex items-center gap-1 min-w-fit">
            <button
              className={`text-[11px] px-2 py-1 rounded border ${
                scope === "all"
                  ? "border-aura-success text-aura-success"
                  : "border-aura-border text-aura-text-dim hover:text-aura-text"
              }`}
              onClick={() => setScope("all")}
            >
              All
            </button>
            <button
              className={`text-[11px] px-2 py-1 rounded border ${
                scope === "bundled"
                  ? "border-aura-success text-aura-success"
                  : "border-aura-border text-aura-text-dim hover:text-aura-text"
              }`}
              onClick={() => setScope("bundled")}
            >
              Bundled
            </button>
            <button
              className={`text-[11px] px-2 py-1 rounded border ${
                scope === "online"
                  ? "border-aura-success text-aura-success"
                  : "border-aura-border text-aura-text-dim hover:text-aura-text"
              }`}
              onClick={() => setScope("online")}
            >
              Online
            </button>
            <button
              className={`text-[11px] px-2 py-1 rounded border ${
                scope === "installed"
                  ? "border-aura-success text-aura-success"
                  : "border-aura-border text-aura-text-dim hover:text-aura-text"
              }`}
              onClick={() => setScope("installed")}
            >
              Installed
            </button>
          </div>
          <span className="text-[11px] text-aura-text-dim min-w-fit">
            {scopeEntries.length} results
          </span>
        </div>

        <div className="flex-1 min-h-0 flex">
          <div className="w-[58%] min-w-0 border-r border-aura-border p-3 overflow-y-auto">
            {scopeEntries.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-aura-text-dim">
                No shaders match your search.
              </div>
            ) : (
              <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
                {scopeEntries.map((entry) => {
                  const selected = selectedEntry?.id === entry.id;
                  const thumbnail = thumbnailOverrides[entry.id] ?? entry.thumbnailUrl;
                  const isHovered = hoveredGridId === entry.id;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setSelectedId(entry.id)}
                      onMouseEnter={() => setHoveredGridId(entry.id)}
                      onMouseLeave={() => setHoveredGridId((current) => current === entry.id ? null : current)}
                      className={`text-left border rounded-md overflow-hidden transition-colors ${
                        selected
                          ? "border-aura-success bg-aura-success/10"
                          : "border-aura-border hover:border-aura-text-dim"
                      }`}
                    >
                      <div className="relative">
                        <img
                          src={thumbnail}
                          alt={`${entry.name} thumbnail`}
                          className="w-full aspect-video object-cover bg-aura-bg/50"
                          loading="lazy"
                        />
                        {isHovered && previewEnabled && (sourceById[entry.id] || entry.sourceCode || entry.previewFragment) && (
                          <div className="absolute inset-0 overflow-hidden rounded-t-md">
                            <ShaderPreviewCanvas
                              entry={entry}
                              enabled
                              sourceCode={sourceById[entry.id] ?? entry.sourceCode}
                              compact
                            />
                          </div>
                        )}
                      </div>
                      <div className="p-2">
                        <div className="text-xs font-medium text-aura-text truncate">{entry.name}</div>
                        <div className="text-[10px] text-aura-text-dim truncate">{entry.author}</div>
                        <div className="mt-1.5 flex items-center gap-1 flex-wrap">
                          <span
                            className={`text-[10px] px-1.5 py-0.5 rounded ${
                              entry.isBundled
                                ? "bg-emerald-500/15 text-emerald-300"
                                : entry.isInstalled
                                  ? "bg-cyan-500/15 text-cyan-300"
                                  : "bg-blue-500/15 text-blue-300"
                            }`}
                          >
                            {entry.isBundled ? "Bundled" : entry.isInstalled ? "Installed" : "Online"}
                          </span>
                          {entry.tags.slice(0, 2).map((tag) => (
                            <span
                              key={`${entry.id}:${tag}`}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-aura-hover text-aura-text-dim"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex-1 min-w-0 p-4 flex flex-col gap-3">
            {!selectedEntry ? (
              <div className="h-full flex items-center justify-center text-xs text-aura-text-dim">
                Select a shader to inspect details.
              </div>
            ) : (
              <>
                <div>
                  <div className="text-sm font-semibold text-aura-text">{selectedEntry.name}</div>
                  <div className="text-[11px] text-aura-text-dim">{selectedEntry.author}</div>
                </div>

                {projectorWindowOpen ? (
                  <div className="space-y-2">
                    <img
                      src={thumbnailOverrides[selectedEntry.id] ?? selectedEntry.thumbnailUrl}
                      alt={`${selectedEntry.name} thumbnail`}
                      className="w-full h-48 border border-aura-border rounded-md object-cover bg-aura-bg/50"
                    />
                    <div className="text-xs text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-3 py-2">
                      Projector is active. Realtime preview is disabled to protect output performance.
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {!tabVisible && (
                      <div className="text-xs text-aura-text-dim bg-aura-bg/50 border border-aura-border rounded px-3 py-2">
                        Realtime preview is paused while the app is not visible.
                      </div>
                    )}
                    {(sourceById[selectedEntry.id] || selectedEntry.sourceCode || selectedEntry.previewFragment) ? (
                      <ShaderPreviewCanvas
                        entry={selectedEntry}
                        enabled={previewEnabled}
                        sourceCode={sourceById[selectedEntry.id] ?? selectedEntry.sourceCode}
                      />
                    ) : (
                      <div className="relative">
                        <img
                          src={thumbnailOverrides[selectedEntry.id] ?? selectedEntry.thumbnailUrl}
                          alt={`${selectedEntry.name} thumbnail`}
                          className="w-full h-48 border border-aura-border rounded-md object-cover bg-aura-bg/50"
                        />
                        <div className="absolute bottom-2 right-2 text-[10px] text-aura-text-dim/60 bg-black/40 px-1.5 py-0.5 rounded">
                          Loading preview...
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div className="text-[11px] text-aura-text-dim leading-relaxed">
                  {selectedEntry.tags.length > 0 ? `Tags: ${selectedEntry.tags.join(", ")}` : "No tags"}
                  <br />
                  License: {selectedEntry.license}
                  {selectedEntry.isInstalled && selectedEntry.installedAt && (
                    <>
                      <br />
                      Installed: {new Date(selectedEntry.installedAt).toLocaleString()}
                    </>
                  )}
                </div>

                {!selectedEntry.isBundled && selectedEntry.isInstalled && (
                  <div className="text-[11px] text-aura-text-dim leading-relaxed bg-aura-bg/40 border border-aura-border rounded px-3 py-2">
                    {selectedEntry.description ? (
                      <div className="mb-1">{selectedEntry.description}</div>
                    ) : (
                      <div className="mb-1">Installed shader is available in your local library.</div>
                    )}
                    {selectedEntry.categories && selectedEntry.categories.length > 0 && (
                      <div>Categories: {selectedEntry.categories.join(", ")}</div>
                    )}
                  </div>
                )}

                {!selectedEntry.isBundled && !selectedEntry.isInstalled && (
                  <div className="text-[11px] text-aura-text-dim leading-relaxed bg-aura-bg/40 border border-aura-border rounded px-3 py-2">
                    {metadataLoading && <div>Loading ISF metadata...</div>}
                    {!metadataLoading && metadataById[selectedEntry.id] && (
                      <>
                        {metadataById[selectedEntry.id].description && (
                          <div className="mb-1">{metadataById[selectedEntry.id].description}</div>
                        )}
                        {metadataById[selectedEntry.id].categories.length > 0 && (
                          <div className="mb-1">
                            Categories: {metadataById[selectedEntry.id].categories.join(", ")}
                          </div>
                        )}
                        {metadataById[selectedEntry.id].credit && (
                          <div className="mb-1">Credit: {metadataById[selectedEntry.id].credit}</div>
                        )}
                        <div>
                          Inputs: {metadataById[selectedEntry.id].inputCount} · Passes: {metadataById[selectedEntry.id].passCount}
                        </div>
                      </>
                    )}
                    {!metadataLoading && !metadataById[selectedEntry.id] && (
                      <div>ISF metadata unavailable for this entry.</div>
                    )}
                  </div>
                )}

                <a
                  href={selectedEntry.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-blue-300 hover:text-blue-200 truncate"
                >
                  {selectedEntry.sourceUrl}
                </a>

                <div className="mt-auto pt-2 border-t border-aura-border/70">
                  {selectedEntry.sourceId ? (
                    <button
                      className="btn-primary text-xs px-3 py-1.5 w-full disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={!hasSelection}
                      onClick={handleApply}
                      title={hasSelection ? "Assign to selected layer(s)" : "Select a layer first"}
                    >
                      Apply to selected layer(s)
                    </button>
                  ) : !selectedEntry.isBundled ? (
                    <button
                      className="btn-primary text-xs px-3 py-1.5 w-full disabled:opacity-50 disabled:cursor-not-allowed"
                      disabled={isInstalling}
                      onClick={() => void handleInstall()}
                    >
                      {isInstalling ? "Installing..." : "Install to local library"}
                    </button>
                  ) : (
                    <div className="text-xs text-aura-text-dim bg-aura-bg/50 border border-aura-border rounded px-3 py-2">
                      This shader is browse-only in the current build.
                    </div>
                  )}
                  {selectedEntry.isInstalled && !selectedEntry.isBundled && (
                    <button
                      className="btn-ghost text-xs px-3 py-1.5 w-full mt-2"
                      onClick={handleRemoveInstalled}
                    >
                      Remove from local library
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ShaderLibraryModal;
