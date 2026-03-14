import { useEffect, useMemo } from "react";
import type { DimmerEffect, Layer, LayerGroup } from "../../../types";
import {
  computeDimmerPhase,
  computeGroupPhaseOffset,
  evaluateDimmerCurve,
  sortLayersByVisualOrder,
} from "../../../lib/dimmer-fx";
import { useAppStore } from "../../../store/useAppStore";

const VIEWBOX_WIDTH = 220;
const VIEWBOX_HEIGHT = 112;
const PLOT_X = 10;
const PLOT_Y = 8;
const PLOT_WIDTH = 200;
const PLOT_HEIGHT = 68;
const LANE_TOP = 84;
const LANE_HEIGHT = 18;

export type DimmerFxGraphContext =
  | {
      kind: "layer";
      layer: Layer;
      layers: Layer[];
      groups: LayerGroup[];
    }
  | {
      kind: "group";
      group: LayerGroup;
      layers: Layer[];
      groups: LayerGroup[];
      highlightedLayerId: string | null;
    };

interface DimmerFxGraphProps {
  effect: DimmerEffect;
  context: DimmerFxGraphContext;
}

interface PhaseLaneEntry {
  layer: Layer;
  phaseOffset: number;
  highlighted: boolean;
}

function phaseToX(phase: number): number {
  return PLOT_X + phase * PLOT_WIDTH;
}

function sampleToY(sample: number): number {
  return PLOT_Y + (1 - sample) * PLOT_HEIGHT;
}

function buildCurvePath(effect: DimmerEffect, phaseOffset = 0): string {
  const samples = 64;
  const points: string[] = [];
  for (let index = 0; index <= samples; index += 1) {
    const phase = (index / samples) + phaseOffset;
    const sample = evaluateDimmerCurve(effect.curve, phase, effect.dutyCycle);
    points.push(`${phaseToX(index / samples)},${sampleToY(sample)}`);
  }
  return points.join(" ");
}

function laneY(index: number, total: number): number {
  if (total <= 1) return LANE_TOP + (LANE_HEIGHT * 0.5);
  return LANE_TOP + (LANE_HEIGHT * index) / (total - 1);
}

export default function DimmerFxGraph({ effect, context }: DimmerFxGraphProps) {
  const bpmState = useAppStore((s) => s.bpmState);
  const refreshBpmState = useAppStore((s) => s.refreshBpmState);

  useEffect(() => {
    void refreshBpmState();
    const interval = window.setInterval(() => {
      void refreshBpmState();
    }, 50);
    return () => window.clearInterval(interval);
  }, [refreshBpmState]);

  const nowMs = Date.now();
  const basePhase = computeDimmerPhase(effect, bpmState, 0, nowMs);
  const baseSample = evaluateDimmerCurve(effect.curve, basePhase, effect.dutyCycle);

  const phaseLanes = useMemo<PhaseLaneEntry[]>(() => {
    if (context.kind !== "group") return [];
    const members = sortLayersByVisualOrder(
      context.layers.filter((layer) => layer.groupId === context.group.id)
    );
    return members.map((layer) => ({
      layer,
      phaseOffset: computeGroupPhaseOffset(layer, context.layers, context.group, effect),
      highlighted: layer.id === context.highlightedLayerId,
    }));
  }, [context, effect]);

  const highlightedLane = phaseLanes.find((entry) => entry.highlighted) ?? null;
  const highlightedPhase = highlightedLane
    ? computeDimmerPhase(effect, bpmState, highlightedLane.phaseOffset, nowMs)
    : null;
  const highlightedSample = highlightedLane
    ? evaluateDimmerCurve(effect.curve, highlightedPhase ?? 0, effect.dutyCycle)
    : null;

  return (
    <div
      className="rounded border border-zinc-800 bg-zinc-950/80 px-2 py-2"
      data-testid="dimmer-fx-graph"
    >
      <div className="mb-1 flex items-center justify-between text-[9px] uppercase tracking-wider text-zinc-500">
        <span>Realtime Curve</span>
        <span>{effect.speed.toFixed(2)} Beats/Cycle</span>
      </div>
      <svg viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`} className="h-28 w-full">
        <rect
          x={PLOT_X}
          y={PLOT_Y}
          width={PLOT_WIDTH}
          height={PLOT_HEIGHT}
          rx="6"
          fill="rgba(24,24,27,0.95)"
          stroke="rgba(82,82,91,0.7)"
        />
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={`v-${fraction}`}
            x1={phaseToX(fraction)}
            y1={PLOT_Y}
            x2={phaseToX(fraction)}
            y2={PLOT_Y + PLOT_HEIGHT}
            stroke="rgba(63,63,70,0.75)"
            strokeDasharray="3 4"
          />
        ))}
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={`h-${fraction}`}
            x1={PLOT_X}
            y1={sampleToY(fraction)}
            x2={PLOT_X + PLOT_WIDTH}
            y2={sampleToY(fraction)}
            stroke="rgba(63,63,70,0.75)"
            strokeDasharray="3 4"
          />
        ))}
        <polyline
          points={buildCurvePath(effect)}
          fill="none"
          stroke="rgba(245,158,11,0.95)"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {highlightedLane && (
          <polyline
            points={buildCurvePath(effect, highlightedLane.phaseOffset)}
            fill="none"
            stroke="rgba(103,232,249,0.95)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            data-testid="dimmer-fx-selected-trace"
          />
        )}
        <line
          x1={phaseToX(basePhase)}
          y1={PLOT_Y}
          x2={phaseToX(basePhase)}
          y2={PLOT_Y + PLOT_HEIGHT}
          stroke="rgba(250,250,250,0.7)"
          strokeWidth="1.5"
          data-testid="dimmer-fx-playhead"
        />
        <circle
          cx={phaseToX(basePhase)}
          cy={sampleToY(baseSample)}
          r="3.5"
          fill="rgba(245,158,11,1)"
        />
        {highlightedLane && highlightedPhase !== null && highlightedSample !== null && (
          <circle
            cx={phaseToX(highlightedPhase)}
            cy={sampleToY(highlightedSample)}
            r="3"
            fill="rgba(103,232,249,1)"
          />
        )}
        {phaseLanes.length > 0 && (
          <g data-testid="dimmer-fx-phase-lanes">
            {phaseLanes.map((entry, index) => {
              const phase = computeDimmerPhase(effect, bpmState, entry.phaseOffset, nowMs);
              const y = laneY(index, phaseLanes.length);
              return (
                <g key={entry.layer.id}>
                  <line
                    x1={PLOT_X}
                    y1={y}
                    x2={PLOT_X + PLOT_WIDTH}
                    y2={y}
                    stroke={entry.highlighted ? "rgba(103,232,249,0.45)" : "rgba(82,82,91,0.65)"}
                    strokeWidth={entry.highlighted ? "1.5" : "1"}
                  />
                  <circle
                    cx={phaseToX(phase)}
                    cy={y}
                    r={entry.highlighted ? "3" : "2"}
                    fill={entry.highlighted ? "rgba(103,232,249,1)" : "rgba(161,161,170,0.95)"}
                  />
                </g>
              );
            })}
          </g>
        )}
      </svg>
      <div className="mt-1 flex items-center justify-between text-[10px] text-zinc-500">
        <span>Curve Sample</span>
        <span className="font-mono text-zinc-300">{baseSample.toFixed(2)}</span>
      </div>
    </div>
  );
}
