import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  passTargets: string[];
  vertexSource?: string;
}

interface ShaderPreviewCanvasProps {
  entry: ShaderLibraryEntry | null;
  enabled: boolean;
  sourceCode?: string;
  /** Compact mode for grid thumbnails — no status text, canvas fills container */
  compact?: boolean;
}

function ShaderPreviewCanvas({ entry, enabled, sourceCode, compact }: ShaderPreviewCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [compileError, setCompileError] = useState<string | null>(null);
  const [reinitCounter, setReinitCounter] = useState(0);
  const [fps, setFps] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const fpsRef = useRef({ frames: 0, lastSample: 0 });

  const reportFps = useCallback((now: number) => {
    fpsRef.current.frames++;
    if (now - fpsRef.current.lastSample >= 1000) {
      setFps(fpsRef.current.frames);
      fpsRef.current.frames = 0;
      fpsRef.current.lastSample = now;
    }
  }, []);

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
        passTargets: [],
      };
    }
    return {
      fragmentSource: buildFragmentShader(buildFallbackPreviewFragment(entry)),
      kind: "fallback",
      inputSpecs: [],
      passTargets: [],
    };
  }, [entry, sourceCode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !enabled || !previewConfig || !entry) {
      setCompileError(null);
      return;
    }

    console.info("[ShaderPreview] Init: entry=%s kind=%s enabled=%s", entry.id, previewConfig.kind, enabled);

    const { gl, contextLabel } = createGlContext(canvas);
    if (!gl) {
      console.warn("[ShaderPreview] No WebGL context available (contextLabel=none) for entry=%s", entry.id);
      setCompileError("WebGL is unavailable in this environment.");
      return;
    }

    const vertexSource = previewConfig.vertexSource ?? VERTEX_SHADER_SOURCE;
    const vertexShaderResult = compileShader(gl, gl.VERTEX_SHADER, vertexSource, "vertex", entry.id);
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
      console.warn("[ShaderPreview] createProgram returned null, gl.getError()=%d entry=%s", gl.getError(), entry.id);
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
    // Resolve lastFrame and pass-target sampler uniforms so they get bound to the dummy texture
    const lastFrameLoc = gl.getUniformLocation(program, "lastFrame");
    if (lastFrameLoc) imageUniformLocations.push(lastFrameLoc);
    for (const t of previewConfig.passTargets) {
      const loc = gl.getUniformLocation(program, t);
      if (loc) imageUniformLocations.push(loc);
    }

    let raf = 0;
    let stopped = false;
    let startTime = performance.now();
    let lastFrameMs = 0;
    const frameIntervalMs = 1000 / PREVIEW_FPS;
    fpsRef.current = { frames: 0, lastSample: performance.now() };
    setIsRunning(true);

    const draw = (now: number) => {
      if (stopped) return;
      if (now - lastFrameMs < frameIntervalMs) {
        raf = requestAnimationFrame(draw);
        return;
      }

      lastFrameMs = now;
      reportFps(now);
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
      console.warn("[ShaderPreview] Context lost for entry=%s", entry.id);
      stopped = true;
      cancelAnimationFrame(raf);
      setCompileError("WebGL context lost. Close/reopen the library to resume preview.");
    };
    const handleContextRestored = () => {
      console.info("[ShaderPreview] Context restored for entry=%s", entry.id);
      setCompileError(null);
      setReinitCounter((c) => c + 1);
    };
    canvas.addEventListener("webglcontextlost", handleContextLost, false);
    canvas.addEventListener("webglcontextrestored", handleContextRestored, false);

    setCompileError(null);
    console.info("[ShaderPreview] Ready: entry=%s context=%s kind=%s", entry.id, contextLabel, previewConfig.kind);
    raf = requestAnimationFrame(draw);

    return () => {
      console.info("[ShaderPreview] Cleanup: entry=%s", entry.id);
      stopped = true;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("webglcontextlost", handleContextLost, false);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored, false);
      if (dummyTex) gl.deleteTexture(dummyTex);
      gl.deleteBuffer(positionBuffer);
      gl.deleteProgram(program);
      startTime = 0;
      lastFrameMs = 0;
      setIsRunning(false);
      setFps(0);
    };
  }, [enabled, entry, previewConfig, reinitCounter, reportFps]);

  const waiting = enabled && !isRunning && !compileError;

  if (compact) {
    return (
      <div className="w-full h-full relative">
        <canvas
          ref={canvasRef}
          className="w-full h-full bg-black"
        />
        {compileError && entry && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70">
            <div className="text-[10px] text-red-300/80 px-2 text-center leading-tight">
              Preview unavailable
            </div>
          </div>
        )}
        {waiting && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50">
            <div className="w-4 h-4 border-2 border-aura-text-dim/30 border-t-aura-text-dim rounded-full animate-spin" />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="w-full">
      <div className="relative">
        <canvas
          ref={canvasRef}
          className="w-full h-48 border border-aura-border rounded-md bg-black"
        />
        {compileError && entry && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-aura-bg/80 border border-red-500/20 rounded-md">
            <svg className="w-6 h-6 text-red-400/60 mb-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15.75h.007v.008H12v-.008z" />
            </svg>
            <div className="text-[11px] text-red-300/80 text-center px-4 leading-tight">
              Shader compile failed
            </div>
          </div>
        )}
        {waiting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 rounded-md">
            <div className="w-5 h-5 border-2 border-aura-text-dim/30 border-t-aura-text-dim rounded-full animate-spin mb-1.5" />
            <div className="text-[10px] text-aura-text-dim/60">Initializing preview...</div>
          </div>
        )}
        {isRunning && !compileError && (
          <div className="absolute top-1.5 right-1.5 text-[10px] text-aura-text-dim/50 bg-black/40 px-1.5 py-0.5 rounded font-mono tabular-nums">
            {fps} fps
          </div>
        )}
      </div>
      {!compileError && previewConfig?.kind === "source" && (
        <div className="mt-2 text-[11px] text-aura-text-dim">
          Realtime preview from shader source.
        </div>
      )}
      {!compileError && previewConfig?.kind === "fallback" && (
        <div className="mt-2 text-[11px] text-aura-text-dim">
          Animated proxy — source unavailable for live preview.
        </div>
      )}
      {compileError && (
        <div className="mt-2 text-[11px] text-red-300">
          {compileError}
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
  const { body, inputs, passTargets } = extractIsfSource(sourceCode);
  const uniformDecl = inputs.map((input) => toUniformDeclaration(input)).filter(Boolean).join("\n");
  const bufferDecl = passTargets.map((t) => `uniform sampler2D ${t};`).join("\n");
  const sanitized = sanitizeIsfBody(body);
  const fragmentSource = `
precision mediump float;
varying vec2 v_uv;
uniform vec2 RENDERSIZE;
uniform float TIME;
uniform int PASSINDEX;
uniform int FRAMEINDEX;
uniform float u_bpm;
uniform float u_beat;
uniform float u_level;
uniform float u_phase;
uniform sampler2D lastFrame;
${uniformDecl}
${bufferDecl}

#define isf_FragNormCoord v_uv
vec4 IMG_NORM_PIXEL(sampler2D img, vec2 loc) { return texture2D(img, loc); }
vec4 IMG_PIXEL(sampler2D img, vec2 loc) { return texture2D(img, loc / max(RENDERSIZE, vec2(1.0, 1.0))); }
vec2 IMG_SIZE(sampler2D img) { return vec2(1.0, 1.0); }
vec4 IMG_THIS_PIXEL(sampler2D img) { return texture2D(img, v_uv); }
vec4 IMG_THIS_NORM_PIXEL(sampler2D img) { return texture2D(img, v_uv); }

${sanitized}
`;

  if (!/void\s+main\s*\(/.test(fragmentSource)) {
    return {
      fragmentSource: buildFragmentShader(buildFallbackPreviewFragment(entry)),
      kind: "fallback",
      inputSpecs: [],
      passTargets: [],
    };
  }

  return {
    fragmentSource,
    kind: "source",
    inputSpecs: inputs,
    passTargets,
    vertexSource: buildIsfVertexShader(sanitized),
  };
}

function sanitizeIsfBody(source: string): string {
  return source
    .replace(/^\s*#version[^\n]*\n/gm, "")
    .replace(/^\s*precision\s+(lowp|mediump|highp)\s+float\s*;\s*$/gm, "")
    .trim();
}

function extractIsfSource(source: string): { body: string; inputs: IsfInputSpec[]; passTargets: string[] } {
  const commentMatch = source.match(/\/\*([\s\S]*?)\*\//);
  if (!commentMatch) {
    return { body: source, inputs: [], passTargets: [] };
  }

  const comment = commentMatch[1];
  const jsonStart = comment.indexOf("{");
  const jsonEnd = comment.lastIndexOf("}");
  let inputs: IsfInputSpec[] = [];
  let passTargets: string[] = [];
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const jsonRaw = comment.slice(jsonStart, jsonEnd + 1);
    try {
      const parsed = JSON.parse(jsonRaw) as {
        INPUTS?: Array<Record<string, unknown>>;
        PASSES?: Array<Record<string, unknown>>;
      };
      inputs = parseInputSpecs(parsed.INPUTS ?? []);
      passTargets = parsePassTargets(parsed.PASSES ?? []);
    } catch {
      inputs = [];
      passTargets = [];
    }
  }

  const body = source.replace(commentMatch[0], "");
  return { body, inputs, passTargets };
}

function parsePassTargets(passes: Array<Record<string, unknown>>): string[] {
  const targets: string[] = [];
  for (const pass of passes) {
    const target = typeof pass.TARGET === "string" ? pass.TARGET.trim() : "";
    if (target) targets.push(target);
  }
  return targets;
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

/**
 * Scan ISF fragment source for `varying` declarations and build a matching
 * vertex shader that outputs them.  Returns `undefined` when no extra varyings
 * are found (the caller should use the default simple vertex shader).
 */
function buildIsfVertexShader(fragmentSource: string): string | undefined {
  const varyingRe = /^\s*varying\s+(vec[234]|float|mat[234])\s+(\w+)(\[\d+\])?/gm;
  const varyings: { type: string; name: string; arraySuffix: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = varyingRe.exec(fragmentSource)) !== null) {
    if (m[2] === "v_uv") continue;
    varyings.push({ type: m[1], name: m[2], arraySuffix: m[3] ?? "" });
  }
  if (varyings.length === 0) return undefined;

  const knownOffsets: Record<string, string> = {
    left_coord: "v_uv - vec2(1.0/RENDERSIZE.x, 0.0)",
    right_coord: "v_uv + vec2(1.0/RENDERSIZE.x, 0.0)",
    above_coord: "v_uv + vec2(0.0, 1.0/RENDERSIZE.y)",
    below_coord: "v_uv - vec2(0.0, 1.0/RENDERSIZE.y)",
    above_left_coord: "v_uv + vec2(-1.0/RENDERSIZE.x, 1.0/RENDERSIZE.y)",
    above_right_coord: "v_uv + vec2(1.0/RENDERSIZE.x, 1.0/RENDERSIZE.y)",
    below_left_coord: "v_uv + vec2(-1.0/RENDERSIZE.x, -1.0/RENDERSIZE.y)",
    below_right_coord: "v_uv + vec2(1.0/RENDERSIZE.x, -1.0/RENDERSIZE.y)",
  };

  const declarations: string[] = [];
  const assignments: string[] = [];
  for (const v of varyings) {
    declarations.push(`varying ${v.type} ${v.name}${v.arraySuffix};`);

    if (v.arraySuffix) {
      const countMatch = v.arraySuffix.match(/\[(\d+)\]/);
      const count = countMatch ? parseInt(countMatch[1], 10) : 0;
      const val = v.type.startsWith("vec") ? "v_uv" : "0.0";
      for (let i = 0; i < count; i++) {
        assignments.push(`  ${v.name}[${i}] = ${val};`);
      }
    } else if (knownOffsets[v.name] && v.type === "vec2") {
      assignments.push(`  ${v.name} = ${knownOffsets[v.name]};`);
    } else if (v.type === "vec2") {
      assignments.push(`  ${v.name} = v_uv;`);
    } else if (v.type === "float") {
      assignments.push(`  ${v.name} = 0.0;`);
    } else if (v.type === "vec3") {
      assignments.push(`  ${v.name} = vec3(v_uv, 0.0);`);
    } else if (v.type === "vec4") {
      assignments.push(`  ${v.name} = vec4(v_uv, 0.0, 1.0);`);
    }
  }

  return `
attribute vec2 a_position;
varying vec2 v_uv;
uniform vec2 RENDERSIZE;
${declarations.join("\n")}

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
${assignments.join("\n")}
}
`;
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
  if (!shader) {
    console.warn("[ShaderPreview] createShader(%s) returned null, gl.getError()=%d entry=%s", stageLabel, gl.getError(), entryId);
    return { shader: null, error: "Could not allocate shader object." };
  }
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
