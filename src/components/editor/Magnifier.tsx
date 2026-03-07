import { useRef, useEffect } from "react";

interface MagnifierProps {
  sourceCanvas: HTMLCanvasElement | null;
  cursorX: number;
  cursorY: number;
  enabled: boolean;
}

const SIZE = 150;
const ZOOM = 3;

export function Magnifier({ sourceCanvas, cursorX, cursorY, enabled }: MagnifierProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!enabled || !sourceCanvas || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext("2d");
    if (!ctx) return;

    const sourceSize = SIZE / ZOOM;
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Clip to circle
    ctx.save();
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2, 0, Math.PI * 2);
    ctx.clip();

    // Draw zoomed portion of source canvas
    ctx.drawImage(
      sourceCanvas,
      cursorX - sourceSize / 2, cursorY - sourceSize / 2,
      sourceSize, sourceSize,
      0, 0, SIZE, SIZE
    );
    ctx.restore();

    // Draw crosshair
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(SIZE / 2 - 8, SIZE / 2);
    ctx.lineTo(SIZE / 2 + 8, SIZE / 2);
    ctx.moveTo(SIZE / 2, SIZE / 2 - 8);
    ctx.lineTo(SIZE / 2, SIZE / 2 + 8);
    ctx.stroke();

    // Draw border
    ctx.strokeStyle = "#818cf8";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
  });

  if (!enabled) return null;

  return (
    <canvas
      ref={canvasRef}
      width={SIZE}
      height={SIZE}
      className="absolute pointer-events-none z-30 rounded-full"
      style={{
        left: cursorX - SIZE / 2,
        top: cursorY - SIZE / 2,
        filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.5))",
      }}
    />
  );
}
