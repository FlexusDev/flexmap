import { useEffect, useState } from "react";

interface CoordinateHUDProps {
  x: number;
  y: number;
  cursorX: number;  // pixel position in canvas container
  cursorY: number;
  mode: "point" | "layer-delta";
  visible: boolean;
}

export function CoordinateHUD({ x, y, cursorX, cursorY, mode, visible }: CoordinateHUDProps) {
  const [show, setShow] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    if (visible) {
      setShow(true);
      setFadeOut(false);
    } else if (show) {
      setFadeOut(true);
      const timer = setTimeout(() => { setShow(false); setFadeOut(false); }, 500);
      return () => clearTimeout(timer);
    }
  }, [visible, show]);

  if (!show) return null;

  const label = mode === "point"
    ? `x: ${x.toFixed(3)}  y: ${y.toFixed(3)}`
    : `dx: ${x >= 0 ? "+" : ""}${x.toFixed(0)}px  dy: ${y >= 0 ? "+" : ""}${y.toFixed(0)}px`;

  return (
    <div
      className={`absolute pointer-events-none z-40 transition-opacity duration-500 ${fadeOut ? "opacity-0" : "opacity-100"}`}
      style={{ left: cursorX + 16, top: cursorY - 28 }}
    >
      <div className="bg-black/80 text-zinc-200 text-[11px] font-mono px-2 py-0.5 rounded-full whitespace-nowrap">
        {label}
      </div>
    </div>
  );
}
