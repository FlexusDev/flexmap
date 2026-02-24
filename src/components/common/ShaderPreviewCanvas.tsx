import { useEffect, useMemo, useRef, useState } from "react";
import type { ShaderLibraryEntry } from "../../types";

const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const PREVIEW_FPS = 24;

type PreviewKind = "source" | "fragment" | "fallback";

type InputType = "float" | "long" | "bool" | "color" | "point2D" | "image";

interface IsfInputSpec {
  name: string;
  type: InputType;
  defaultValue: unknown;
}

interface PreviewSourceConfig {
  fragmentSource: string;
  kind: PreviewKind;
  inputSpecs: IsfInputSpec[];
}

interface ShaderPreviewCanvasProps {
  entry: ShaderLibraryEntry | null;
  enabled: boolean;
  sourceCode?: string;
}

function ShaderPreviewCanvas({ entry, enabled, sourceCode }: ShaderPreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [reinitCounter, setReinitCounter] = useState(0);

  const previewConfig = useMemo<PreviewSourceConfig | null>(() => {
    if (!entry) return null;
    if (sourceCode?.trim()) {
      return buildSourceBasedPreview(entry, sourceCode);
    }
    if (entry.previewFragment?.trim()) {
      return {
        fragmentSource: buildFragmentShader(entry.previewFragment),
        kind: "fragment",
        inputSpecs: [],
      };
    }
    return {
      fragmentSource: buildFragmentShader(buildFallbackPreviewFragment(entry)),
      kind: "fallback",
      inputSpecs: [],
    };
  }, [entry, sourceCode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled || !previewConfig || !entry) {
      setCompileError(null);
      return;
    }

    const { gl, contextLabel } = createGlContext(canvas);
    if (!gl) {
      setCompileError("WebGL is unavailable in this environment.");
      return;
    }

    const vertexShaderResult = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE, "vertex", entry.id);
    const fragmentShaderResult = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      previewConfig.fragmentSource,
      "fragment",
      entry.id
    );

    if (!vertexShaderResult.shader || !fragmentShaderResult.shader) {
      const compileMessage = fragmentShaderResult.error ?? vertexShaderResult.error ?? "Shader compile failed.";
      setCompileError(trimShaderError(compileMessage));
      return;
    }
    const vertexShader = vertexShaderResult.shader;
    const fragmentShader = fragmentShaderResult.shader;

    const program = gl.createProgram();
    if (!program) {
      setCompileError("Could not allocate preview program.");
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return;
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) ?? "Program link failed.";
      console.error("[ShaderPreview] Program link failed:", {
        entryId: entry.id,
        context: contextLabel,
        message,
      });
      setCompileError(trimShaderError(message));
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return;
    }

    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    gl.useProgram(program);

    const positionAttr = gl.getAttribLocation(program, "a_position");
    if (positionAttr < 0) {
      setCompileError("Missing a_position attribute.");
      gl.deleteProgram(program);
      return;
    }

    const positionBuffer = gl.createBuffer();
    if (!positionBuffer) {
      setCompileError("Could not allocate preview vertex buffer.");
      gl.deleteProgram(program);
      return;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
        1, -1,
        -1, 1,
        1, 1,
      ]),
      gl.STATIC_DRAW
    );
    gl.enableVertexAttribArray(positionAttr);
    gl.vertexAttribPointer(positionAttr, 2, gl.FLOAT, false, 0, 0);

    const resolutionUniform = gl.getUniformLocation(program, "u_resolution")
      ?? gl.getUniformLocation(program, "RENDERSIZE");
    const timeUniform = gl.getUniformLocation(program, "u_time")
      ?? gl.getUniformLocation(program, "TIME");
    const passIndexUniform = gl.getUniformLocation(program, "PASSINDEX");
    const bpmUniform = gl.getUniformLocation(program, "u_bpm");
    const beatUniform = gl.getUniformLocation(program, "u_beat");
    const levelUniform = gl.getUniformLocation(program, "u_level");
    const phaseUniform = gl.getUniformLocation(program, "u_phase");

    const dummyTex = createDummyTexture(gl);
    const imageUniformLocations: WebGLUniformLocation[] = [];
    for (const spec of previewConfig.inputSpecs) {
      const location = gl.getUniformLocation(program, spec.name);
      if (!location) continue;
      applyInputUniform(gl, location, spec);
      if (spec.type === "image") {
        imageUniformLocations.push(location);
      }
    }

    let raf = 0;
    let stopped = false;
    let startTime = performance.now();
    let lastFrameMs = 0;
    const frameIntervalMs = 1000 / PREVIEW_FPS;

    const draw = (now: number) => {
      if (stopped) return;
      if (now - lastFrameMs < frameIntervalMs) {
        raf = requestAnimationFrame(draw);
        return;
      }

      lastFrameMs = now;
      const { width, height } = syncCanvasSize(gl, canvas);
      gl.viewport(0, 0, width, height);

      const tSec = (now - startTime) / 1000;
      if (resolutionUniform) gl.uniform2f(resolutionUniform, width, height);
      if (timeUniform) gl.uniform1f(timeUniform, tSec);
      if (passIndexUniform) gl.uniform1i(passIndexUniform, 0);

      // Keep preview BPM uniforms deterministic and stable.
      const previewBpm = 120;
      const phase = (tSec * previewBpm / 60) % 1;
      const beat = phase < 0.12 ? 1 : 0;
      if (bpmUniform) gl.uniform1f(bpmUniform, previewBpm);
      if (beatUniform) gl.uniform1f(beatUniform, beat);
      if (levelUniform) gl.uniform1f(levelUniform, beat ? 0.85 : 0.22);
      if (phaseUniform) gl.uniform1f(phaseUniform, phase);

      if (imageUniformLocations.length > 0 && dummyTex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, dummyTex);
        for (const location of imageUniformLocations) {
          gl.uniform1i(location, 0);
        }
      }

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      raf = requestAnimationFrame(draw);
    };

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      stopped = true;
      cancelAnimationFrame(raf);
      setCompileError("WebGL context lost. Close/reopen the library to resume preview.");
    };
    const handleContextRestored = () => {
      setCompileError(null);
      setReinitCounter((c) => c + 1);
    };
    canvas.addEventListener("webglcontextlost", handleContextLost, false);
    canvas.addEventListener("webglcontextrestored", handleContextRestored, false);

    setCompileError(null);
    raf = requestAnimationFrame(draw);

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("webglcontextlost", handleContextLost, false);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored, false);
      gl.deleteTexture(dummyTex);
      gl.deleteBuffer(positionBuffer);
      gl.deleteProgram(program);
      startTime = 0;
      lastFrameMs = 0;
    };
  }, [enabled, entry, previewConfig, reinitCounter]);

  return (
    <div className="w-full">
      <div className="relative">
        <canvas
          ref={canvasRef}
          className="w-full h-48 border border-aura-border rounded-md bg-black"
        />
        {compileError && entry && (
          <img
            src={entry.thumbnailUrl}
            alt={`${entry.name} thumbnail fallback`}
            className="absolute inset-0 w-full h-48 border border-aura-border rounded-md object-cover bg-aura-bg/50"
          />
        )}
      </div>
      {!compileError && previewConfig?.kind === "source" && (
        <div className="mt-2 text-[11px] text-aura-text-dim">
          Realtime preview uses this shader source.
        </div>
      )}
      {!compileError && previewConfig?.kind === "fallback" && (
        <div className="mt-2 text-[11px] text-aura-text-dim">
          Preview is an animated proxy for this entry.
        </div>
      )}
      {compileError && (
        <div className="mt-2 text-[11px] text-red-300">
          Preview error: {compileError}. Showing thumbnail fallback.
        </div>
      )}
    </div>
  );
}

function buildFragmentShader(fragmentBody: string): string {
  return `
precision mediump float;

uniform vec2 u_resolution;
uniform float u_time;

${fragmentBody}

void main() {
  vec2 uv = gl_FragCoord.xy / max(u_resolution, vec2(1.0, 1.0));
  gl_FragColor = auraColor(uv, u_time);
}
`;
}

function buildSourceBasedPreview(entry: ShaderLibraryEntry, sourceCode: string): PreviewSourceConfig {
  const { body, inputs } = extractIsfSource(sourceCode);
  const uniformDecl = inputs.map((input) => toUniformDeclaration(input)).filter(Boolean).join("\n");
  const sanitized = sanitizeIsfBody(body);
  const fragmentSource = `
precision mediump float;
varying vec2 v_uv;
uniform vec2 RENDERSIZE;
uniform float TIME;
uniform int PASSINDEX;
uniform float u_bpm;
uniform float u_beat;
uniform float u_level;
uniform float u_phase;
${uniformDecl}

#define isf_FragNormCoord v_uv
vec4 IMG_NORM_PIXEL(sampler2D img, vec2 loc) { return texture2D(img, loc); }
vec4 IMG_PIXEL(sampler2D img, vec2 loc) { return texture2D(img, loc / max(RENDERSIZE, vec2(1.0, 1.0))); }
vec2 IMG_SIZE(sampler2D img) { return vec2(1.0, 1.0); }

${sanitized}
`;

  if (!/void\s+main\s*\(/.test(fragmentSource)) {
    return {
      fragmentSource: buildFragmentShader(buildFallbackPreviewFragment(entry)),
      kind: "fallback",
      inputSpecs: [],
    };
  }

  return {
    fragmentSource,
    kind: "source",
    inputSpecs: inputs,
  };
}

function sanitizeIsfBody(source: string): string {
  return source
    .replace(/^\s*#version[^\n]*\n/gm, "")
    .replace(/^\s*precision\s+(lowp|mediump|highp)\s+float\s*;\s*$/gm, "")
    .trim();
}

function extractIsfSource(source: string): { body: string; inputs: IsfInputSpec[] } {
  const commentMatch = source.match(/\/\*([\s\S]*?)\*\//);
  if (!commentMatch) {
    return { body: source, inputs: [] };
  }

  const comment = commentMatch[1];
  const jsonStart = comment.indexOf("{");
  const jsonEnd = comment.lastIndexOf("}");
  let inputs: IsfInputSpec[] = [];
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const jsonRaw = comment.slice(jsonStart, jsonEnd + 1);
    try {
      const parsed = JSON.parse(jsonRaw) as { INPUTS?: Array<Record<string, unknown>> };
      inputs = parseInputSpecs(parsed.INPUTS ?? []);
    } catch {
      inputs = [];
    }
  }

  const body = source.replace(commentMatch[0], "");
  return { body, inputs };
}

function parseInputSpecs(rawInputs: Array<Record<string, unknown>>): IsfInputSpec[] {
  const specs: IsfInputSpec[] = [];
  for (const raw of rawInputs) {
    const name = typeof raw.NAME === "string" ? raw.NAME.trim() : "";
    if (!name) continue;
    const rawType = typeof raw.TYPE === "string" ? raw.TYPE.trim().toLowerCase() : "";
    const type = normalizeInputType(rawType);
    if (!type) continue;
    specs.push({
      name,
      type,
      defaultValue: raw.DEFAULT ?? null,
    });
  }
  return specs;
}

function normalizeInputType(rawType: string): InputType | null {
  switch (rawType) {
    case "float":
      return "float";
    case "long":
      return "long";
    case "bool":
      return "bool";
    case "color":
      return "color";
    case "point2d":
      return "point2D";
    case "image":
      return "image";
    default:
      return null;
  }
}

function toUniformDeclaration(input: IsfInputSpec): string {
  switch (input.type) {
    case "float":
      return `uniform float ${input.name};`;
    case "long":
      return `uniform int ${input.name};`;
    case "bool":
      return `uniform bool ${input.name};`;
    case "color":
      return `uniform vec4 ${input.name};`;
    case "point2D":
      return `uniform vec2 ${input.name};`;
    case "image":
      return `uniform sampler2D ${input.name};`;
    default:
      return "";
  }
}

function applyInputUniform(
  gl: WebGLRenderingContext,
  location: WebGLUniformLocation,
  spec: IsfInputSpec
): void {
  switch (spec.type) {
    case "float": {
      const value = typeof spec.defaultValue === "number" ? spec.defaultValue : 0.5;
      gl.uniform1f(location, value);
      break;
    }
    case "long": {
      const value = typeof spec.defaultValue === "number" ? Math.round(spec.defaultValue) : 0;
      gl.uniform1i(location, value);
      break;
    }
    case "bool": {
      const value = spec.defaultValue === true ? 1 : 0;
      gl.uniform1i(location, value);
      break;
    }
    case "color": {
      const color = toNumberArray(spec.defaultValue, 4, [0.5, 0.5, 0.5, 1.0]);
      gl.uniform4f(location, color[0], color[1], color[2], color[3]);
      break;
    }
    case "point2D": {
      const point = toNumberArray(spec.defaultValue, 2, [0.5, 0.5]);
      gl.uniform2f(location, point[0], point[1]);
      break;
    }
    case "image": {
      gl.uniform1i(location, 0);
      break;
    }
  }
}

function toNumberArray(value: unknown, size: number, fallback: number[]): number[] {
  if (Array.isArray(value)) {
    const parsed = value
      .slice(0, size)
      .map((entry, index) => (typeof entry === "number" ? entry : fallback[index] ?? 0));
    while (parsed.length < size) {
      parsed.push(fallback[parsed.length] ?? 0);
    }
    return parsed;
  }
  return fallback.slice(0, size);
}

function createDummyTexture(gl: WebGLRenderingContext): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) return null;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    1,
    1,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    new Uint8Array([8, 8, 8, 255])
  );
  return texture;
}

function buildFallbackPreviewFragment(entry: ShaderLibraryEntry): string {
  const base = hashString(`${entry.id}|${entry.name}|${entry.tags.join(",")}`) >>> 0;
  const density = (4 + (base % 7)).toFixed(1);
  const speedA = (0.7 + ((base >>> 3) % 12) * 0.12).toFixed(2);
  const speedB = (0.5 + ((base >>> 7) % 14) * 0.1).toFixed(2);
  const phase = ((base % 360) * Math.PI / 180).toFixed(4);

  return `
vec4 auraColor(vec2 uv, float t) {
  vec2 p = uv * 2.0 - 1.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  float waveA = sin((p.x + p.y) * ${density} + t * ${speedA} + ${phase});
  float waveB = cos((a * ${density} * 0.8) - t * ${speedB});
  float rings = sin((10.0 / max(r, 0.08)) - t * ${speedA} * 1.6);
  float mixv = waveA * 0.45 + waveB * 0.35 + rings * 0.20;
  vec3 col = 0.5 + 0.5 * cos(vec3(0.0, 2.1, 4.2) + mixv + t * vec3(0.7, 0.4, 0.2));
  col *= 0.85 + 0.15 * sin(t + r * 8.0);
  return vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
}

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
  stageLabel: "vertex" | "fragment",
  entryId: string
): { shader: WebGLShader | null; error: string | null } {
  const shader = gl.createShader(type);
  if (!shader) return { shader: null, error: "Could not allocate shader object." };
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    return { shader, error: null };
  }
  const message = gl.getShaderInfoLog(shader) ?? "Unknown shader compile error.";
  console.error("[ShaderPreview] Shader compile failed:", {
    entryId,
    stage: stageLabel,
    message,
  });
  gl.deleteShader(shader);
  return { shader: null, error: message };
}

function createGlContext(
  canvas: HTMLCanvasElement
): { gl: WebGLRenderingContext | null; contextLabel: "webgl2" | "webgl" | "none" } {
  const attrs = {
    antialias: false,
    depth: false,
    alpha: true,
    preserveDrawingBuffer: false,
    premultipliedAlpha: true,
  } satisfies WebGLContextAttributes;

  const gl2 = canvas.getContext("webgl2", attrs);
  if (gl2) {
    return { gl: gl2 as unknown as WebGLRenderingContext, contextLabel: "webgl2" };
  }
  const gl = canvas.getContext("webgl", attrs);
  if (gl) {
    return { gl: gl as WebGLRenderingContext, contextLabel: "webgl" };
  }
  return { gl: null, contextLabel: "none" };
}

function trimShaderError(message: string): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
}

function syncCanvasSize(
  gl: WebGLRenderingContext,
  canvas: HTMLCanvasElement
): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  }
  return { width, height };
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export default ShaderPreviewCanvas;
