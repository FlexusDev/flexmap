import { useEffect, useMemo, useState } from "react";
import {
  Group,
  Panel,
  Separator,
  useDefaultLayout,
  usePanelRef,
} from "react-resizable-panels";
import type { Layout, PanelSize } from "react-resizable-panels";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../../store/useAppStore";
import InspectorPane from "../properties/InspectorPane";
import LayerPanel from "../layers/LayerPanel";
import SourcePanel from "../common/SourcePanel";

type LeftSectionId = "layers" | "sources";

const LEFT_PANEL_IDS: Record<LeftSectionId, string> = {
  layers: "layers",
  sources: "sources",
};

const LEFT_SECTIONS: LeftSectionId[] = ["layers", "sources"];

const LEFT_SECTION_DEFAULT_PCT: Record<LeftSectionId, number> = {
  layers: 65,
  sources: 35,
};

const LEFT_SECTION_MIN_PX = 96;
const LEFT_SECTION_COLLAPSED_PX = 40;

function LeftPanel() {
  const { layers, sources } = useAppStore(useShallow((s) => ({
    layers: s.layers,
    sources: s.sources,
  })));

  const layersPanelRef = usePanelRef();
  const sourcesPanelRef = usePanelRef();

  const [collapsedSections, setCollapsedSections] = useState<
    Record<LeftSectionId, boolean>
  >({
    layers: false,
    sources: false,
  });
  const [activeSection, setActiveSection] = useState<LeftSectionId>("layers");

  const fallbackLayout = useMemo<Layout>(() => ({
    [LEFT_PANEL_IDS.layers]: LEFT_SECTION_DEFAULT_PCT.layers,
    [LEFT_PANEL_IDS.sources]: LEFT_SECTION_DEFAULT_PCT.sources,
  }), []);

  const { defaultLayout: persistedLayout, onLayoutChanged } = useDefaultLayout({
    id: "flexmap-left-split",
    panelIds: LEFT_SECTIONS.map((id) => LEFT_PANEL_IDS[id]),
    storage: localStorage,
  });

  const leftLayout = persistedLayout ?? fallbackLayout;

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setCollapsedSections({
        layers: layersPanelRef.current?.isCollapsed() ?? false,
        sources: sourcesPanelRef.current?.isCollapsed() ?? false,
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [leftLayout, layersPanelRef, sourcesPanelRef]);

  useEffect(() => {
    if (!collapsedSections[activeSection]) return;
    const fallback = LEFT_SECTIONS.find((id) => !collapsedSections[id]);
    if (fallback) {
      setActiveSection(fallback);
    }
  }, [activeSection, collapsedSections]);

  const getPanelHandle = (sectionId: LeftSectionId) => {
    return sectionId === "layers" ? layersPanelRef.current : sourcesPanelRef.current;
  };

  const updateSectionCollapsed = (sectionId: LeftSectionId, collapsed: boolean) => {
    setCollapsedSections((prev) => {
      if (prev[sectionId] === collapsed) return prev;
      return { ...prev, [sectionId]: collapsed };
    });
  };

  const setSectionCollapsed = (sectionId: LeftSectionId, collapsed: boolean) => {
    const handle = getPanelHandle(sectionId);
    if (!handle) return;
    if (collapsed) {
      if (!handle.isCollapsed()) handle.collapse();
      updateSectionCollapsed(sectionId, true);
      return;
    }
    if (handle.isCollapsed()) handle.expand();
    updateSectionCollapsed(sectionId, false);
  };

  const focusSection = (sectionId: LeftSectionId) => {
    LEFT_SECTIONS.forEach((id) => {
      setSectionCollapsed(id, id !== sectionId);
    });
    setActiveSection(sectionId);
    requestAnimationFrame(() => {
      getPanelHandle(sectionId)?.resize(100);
    });
  };

  const handleSectionResize = (sectionId: LeftSectionId, panelSize: PanelSize) => {
    const collapsed = panelSize.inPixels <= LEFT_SECTION_COLLAPSED_PX + 1;
    updateSectionCollapsed(sectionId, collapsed);
  };

  const toggleSectionCollapsed = (sectionId: LeftSectionId) => {
    const isCollapsed = collapsedSections[sectionId];
    setSectionCollapsed(sectionId, !isCollapsed);
    if (!isCollapsed) {
      const nextActive = LEFT_SECTIONS.find(
        (id) => id !== sectionId && !collapsedSections[id]
      );
      if (nextActive) setActiveSection(nextActive);
      return;
    }
    setActiveSection(sectionId);
  };

  const handleSectionHeaderClick = (sectionId: LeftSectionId) => {
    if (collapsedSections[sectionId]) {
      focusSection(sectionId);
      return;
    }
    setActiveSection(sectionId);
  };

  const layersStatus = `${layers.length} layer${layers.length !== 1 ? "s" : ""}`;
  const sourcesStatus = `${sources.length} source${sources.length !== 1 ? "s" : ""}`;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-3 py-2 border-b border-aura-border">
        <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">
          Layers & Sources
        </span>
        <div className="mt-1">
          <span className="text-sm text-aura-text-dim">
            {layersStatus} · {sourcesStatus}
          </span>
        </div>
      </div>

      <Group
        orientation="vertical"
        className="flex-1 min-h-0 properties-inspector-group"
        defaultLayout={leftLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <Panel
          id={LEFT_PANEL_IDS.layers}
          panelRef={layersPanelRef}
          defaultSize={LEFT_SECTION_DEFAULT_PCT.layers}
          minSize={LEFT_SECTION_MIN_PX}
          collapsible
          collapsedSize={LEFT_SECTION_COLLAPSED_PX}
          onResize={(panelSize) => handleSectionResize("layers", panelSize)}
          className="min-h-0"
        >
          <InspectorPane
            title="Layers"
            status={layersStatus}
            active={activeSection === "layers"}
            collapsed={collapsedSections.layers}
            onHeaderClick={() => handleSectionHeaderClick("layers")}
            onToggleCollapsed={() => toggleSectionCollapsed("layers")}
          >
            <div className="h-full flex flex-col min-h-0">
              <LayerPanel />
            </div>
          </InspectorPane>
        </Panel>
        <Separator />
        <Panel
          id={LEFT_PANEL_IDS.sources}
          panelRef={sourcesPanelRef}
          defaultSize={LEFT_SECTION_DEFAULT_PCT.sources}
          minSize={LEFT_SECTION_MIN_PX}
          collapsible
          collapsedSize={LEFT_SECTION_COLLAPSED_PX}
          onResize={(panelSize) => handleSectionResize("sources", panelSize)}
          className="min-h-0"
        >
          <InspectorPane
            title="Sources"
            status={sourcesStatus}
            active={activeSection === "sources"}
            collapsed={collapsedSections.sources}
            onHeaderClick={() => handleSectionHeaderClick("sources")}
            onToggleCollapsed={() => toggleSectionCollapsed("sources")}
          >
            <div className="h-full flex flex-col min-h-0">
              <SourcePanel />
            </div>
          </InspectorPane>
        </Panel>
      </Group>
    </div>
  );
}

export default LeftPanel;
