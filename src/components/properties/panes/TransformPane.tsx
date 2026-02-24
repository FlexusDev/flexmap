import type { KeyboardEvent, PointerEvent, RefObject } from "react";
import type { InputTransform } from "../../../types";

const TWO_PI = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;

type Axis = "x" | "y";

type GeomUi = {
  dx: number;
  dy: number;
  rotationDeg: number;
  sx: number;
  sy: number;
};

interface TransformPaneProps {
  inputMixed: boolean;
  inputUi: InputTransform;
  onResetInputTransform: () => void;
  onInputPointerDown: () => void;
  onInputPointerUp: () => void;
  onInputChange: (next: InputTransform) => void;

  geomAbsUi: { xPx: string; yPx: string };
  onGeomAbsFocus: (axis: Axis) => void;
  onGeomAbsBlur: (axis: Axis) => void;
  onGeomAbsKeyDown: (axis: Axis, event: KeyboardEvent<HTMLInputElement>) => void;
  onGeomAbsChange: (axis: Axis, value: string) => void;
  onApplyAbsoluteCenter: () => void;
  geomCenterNorm: { x: number; y: number };
  outputWidth: number;
  outputHeight: number;

  geomUi: GeomUi;
  onGeomUiChange: (patch: Partial<GeomUi>) => void;
  onGeomPointerDown: () => void;
  onGeomPointerUp: () => void;

  joystickRef: RefObject<HTMLDivElement>;
  onJoystickPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onJoystickPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onJoystickPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onJoystickLostPointerCapture: () => void;
}

function TransformPane({
  inputMixed,
  inputUi,
  onResetInputTransform,
  onInputPointerDown,
  onInputPointerUp,
  onInputChange,
  geomAbsUi,
  onGeomAbsFocus,
  onGeomAbsBlur,
  onGeomAbsKeyDown,
  onGeomAbsChange,
  onApplyAbsoluteCenter,
  geomCenterNorm,
  outputWidth,
  outputHeight,
  geomUi,
  onGeomUiChange,
  onGeomPointerDown,
  onGeomPointerUp,
  joystickRef,
  onJoystickPointerDown,
  onJoystickPointerMove,
  onJoystickPointerUp,
  onJoystickLostPointerCapture,
}: TransformPaneProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">
            Input Transform
            {inputMixed && (
              <span className="ml-2 text-[11px] normal-case text-amber-300">Mixed</span>
            )}
          </span>
          <button
            type="button"
            onClick={onResetInputTransform}
            className="text-xs text-aura-text-dim hover:text-aura-text"
            title="Reset input transform"
          >
            ↺ Reset
          </button>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Position X</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{inputUi.offset[0].toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.001}
            value={inputUi.offset[0]}
            onPointerDown={onInputPointerDown}
            onPointerUp={onInputPointerUp}
            onPointerCancel={onInputPointerUp}
            onChange={(e) => {
              const next: InputTransform = {
                ...inputUi,
                offset: [parseFloat(e.target.value), inputUi.offset[1]],
              };
              onInputChange(next);
            }}
            className="slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Position Y</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{inputUi.offset[1].toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={-1}
            max={1}
            step={0.001}
            value={inputUi.offset[1]}
            onPointerDown={onInputPointerDown}
            onPointerUp={onInputPointerUp}
            onPointerCancel={onInputPointerUp}
            onChange={(e) => {
              const next: InputTransform = {
                ...inputUi,
                offset: [inputUi.offset[0], parseFloat(e.target.value)],
              };
              onInputChange(next);
            }}
            className="slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Rotation</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{(inputUi.rotation / TWO_PI * 360).toFixed(1)}°</span>
          </div>
          <input
            type="range"
            min={-180}
            max={180}
            step={0.1}
            value={(inputUi.rotation / TWO_PI) * 360}
            onPointerDown={onInputPointerDown}
            onPointerUp={onInputPointerUp}
            onPointerCancel={onInputPointerUp}
            onChange={(e) => {
              const next: InputTransform = {
                ...inputUi,
                rotation: parseFloat(e.target.value) * DEG_TO_RAD,
              };
              onInputChange(next);
            }}
            className="slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Scale X</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{inputUi.scale[0].toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.001}
            value={inputUi.scale[0]}
            onPointerDown={onInputPointerDown}
            onPointerUp={onInputPointerUp}
            onPointerCancel={onInputPointerUp}
            onChange={(e) => {
              const next: InputTransform = {
                ...inputUi,
                scale: [parseFloat(e.target.value), inputUi.scale[1]],
              };
              onInputChange(next);
            }}
            className="slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Scale Y</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{inputUi.scale[1].toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.001}
            value={inputUi.scale[1]}
            onPointerDown={onInputPointerDown}
            onPointerUp={onInputPointerUp}
            onPointerCancel={onInputPointerUp}
            onChange={(e) => {
              const next: InputTransform = {
                ...inputUi,
                scale: [inputUi.scale[0], parseFloat(e.target.value)],
              };
              onInputChange(next);
            }}
            className="slider"
          />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-aura-text-dim">
            Geometry Transform
          </span>
          <span className="text-[11px] text-aura-text-dim">Joystick + Absolute</span>
        </div>

        <div className="rounded-md border border-aura-border/70 p-2 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-aura-text-dim">Absolute Center (canvas px)</span>
            <button
              type="button"
              onClick={onApplyAbsoluteCenter}
              className="text-xs text-aura-text-dim hover:text-aura-text"
              title="Apply absolute center position"
            >
              Apply
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-aura-text-dim block mb-1">X</label>
              <input
                type="number"
                step={0.1}
                value={geomAbsUi.xPx}
                onFocus={() => onGeomAbsFocus("x")}
                onBlur={() => onGeomAbsBlur("x")}
                onKeyDown={(event) => onGeomAbsKeyDown("x", event)}
                onChange={(e) => onGeomAbsChange("x", e.target.value)}
                className="input w-full text-xs py-1"
              />
            </div>
            <div>
              <label className="text-[11px] text-aura-text-dim block mb-1">Y</label>
              <input
                type="number"
                step={0.1}
                value={geomAbsUi.yPx}
                onFocus={() => onGeomAbsFocus("y")}
                onBlur={() => onGeomAbsBlur("y")}
                onKeyDown={(event) => onGeomAbsKeyDown("y", event)}
                onChange={(e) => onGeomAbsChange("y", e.target.value)}
                className="input w-full text-xs py-1"
              />
            </div>
          </div>
          <div className="text-[11px] text-aura-text-dim">
            Canvas {outputWidth}x{outputHeight} | Normalized center {geomCenterNorm.x.toFixed(4)}, {geomCenterNorm.y.toFixed(4)}
          </div>
        </div>

        <div className="rounded-md border border-aura-border/70 p-2">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-aura-text-dim">Position Joystick</label>
            <span className="text-xs font-mono text-aura-text">
              {geomUi.dx.toFixed(2)}, {geomUi.dy.toFixed(2)}
            </span>
          </div>
          <div className="flex justify-center">
            <div
              ref={joystickRef}
              onPointerDown={onJoystickPointerDown}
              onPointerMove={onJoystickPointerMove}
              onPointerUp={onJoystickPointerUp}
              onPointerCancel={onJoystickPointerUp}
              onLostPointerCapture={onJoystickLostPointerCapture}
              className="relative w-24 h-24 rounded-full border border-aura-border bg-aura-hover/40 touch-none select-none cursor-grab active:cursor-grabbing"
            >
              <div className="absolute inset-1 rounded-full border border-aura-border/50" />
              <div
                className="absolute left-1/2 top-1/2 w-8 h-8 -ml-4 -mt-4 rounded-full border border-aura-border bg-aura-surface shadow"
                style={{
                  transform: `translate(${geomUi.dx * 28}px, ${geomUi.dy * 28}px)`,
                }}
              />
            </div>
          </div>
          <div className="mt-2 text-[11px] text-aura-text-dim text-center">
            Hold and drag. Release springs back to center.
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Rotation</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{geomUi.rotationDeg.toFixed(1)}°</span>
          </div>
          <input
            type="range"
            min={-180}
            max={180}
            step={0.1}
            value={geomUi.rotationDeg}
            onPointerDown={onGeomPointerDown}
            onPointerUp={onGeomPointerUp}
            onPointerCancel={onGeomPointerUp}
            onChange={(e) => onGeomUiChange({ rotationDeg: parseFloat(e.target.value) })}
            className="slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Scale X</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{geomUi.sx.toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.001}
            value={geomUi.sx}
            onPointerDown={onGeomPointerDown}
            onPointerUp={onGeomPointerUp}
            onPointerCancel={onGeomPointerUp}
            onChange={(e) => onGeomUiChange({ sx: parseFloat(e.target.value) })}
            className="slider"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-aura-text-dim">Scale Y</label>
            <span className="text-xs font-mono text-aura-text w-14 text-right">{geomUi.sy.toFixed(3)}</span>
          </div>
          <input
            type="range"
            min={0.1}
            max={3}
            step={0.001}
            value={geomUi.sy}
            onPointerDown={onGeomPointerDown}
            onPointerUp={onGeomPointerUp}
            onPointerCancel={onGeomPointerUp}
            onChange={(e) => onGeomUiChange({ sy: parseFloat(e.target.value) })}
            className="slider"
          />
        </div>
      </div>
    </div>
  );
}

export default TransformPane;
