const VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

type InputType = "float" | "long" | "bool" | "color" | "point2D" | "image";

interface IsfInputSpec {
  name: string;
  type: InputType;
  defaultValue: unknown;
}

// ── Shared WebGL context (single context for ALL thumbnail renders) ──

let _sharedCanvas: HTMLCanvasElement | null = null;
let _sharedGl: WebGLRenderingContext | null = null;
let _sharedVertexShader: WebGLShader | null = null;
let _sharedQuadBuffer: WebGLBuffer | null = null;
let _renderCount = 0;

function getSharedGl(width: number, height: number): WebGLRenderingContext | null {
  if (typeof document === "undefined") return null;

  // If we have a context but it was lost, tear down and recreate
  if (_sharedGl && _sharedGl.isContextLost()) {
    console.warn("[ShaderThumb] Shared context was lost, recreating");
    _sharedGl = null;
    _sharedCanvas = null;
    _sharedVertexShader = null;
    _sharedQuadBuffer = null;
  }

  if (_sharedGl) {
    // Resize if needed
    if (_sharedCanvas!.width !== width || _sharedCanvas!.height !== height) {
      _sharedCanvas!.width = width;
      _sharedCanvas!.height = height;
    }
    return _sharedGl;
  }

  // First-time creation
  _sharedCanvas = document.createElement("canvas");
  _sharedCanvas.width = width;
  _sharedCanvas.height = height;

  const gl = _sharedCanvas.getContext("webgl", {
    antialias: false,
    depth: false,
    alpha: true,
    preserveDrawingBuffer: true,
    premultipliedAlpha: true,
  });
  if (!gl) {
    console.warn("[ShaderThumb] Failed to create shared WebGL context");
    return null;
  }

  // Compile shared vertex shader
  const vs = gl.createShader(gl.VERTEX_SHADER);
  if (!vs) {
    console.warn("[ShaderThumb] createShader(VERTEX) returned null, gl.getError()=%d", gl.getError());
    return null;
  }
  gl.shaderSource(vs, VERTEX_SHADER_SOURCE);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    console.warn("[ShaderThumb] Vertex shader compile failed: %s", gl.getShaderInfoLog(vs)?.slice(0, 200));
    gl.deleteShader(vs);
    return null;
  }

  // Create shared quad buffer
  const buf = gl.createBuffer();
  if (!buf) {
    gl.deleteShader(vs);
    return null;
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW
  );

  _sharedGl = gl;
  _sharedVertexShader = vs;
  _sharedQuadBuffer = buf;
  console.info("[ShaderThumb] Created shared WebGL context for thumbnail rendering");
  return gl;
}

function compileFragmentShader(gl: WebGLRenderingContext, source: string): WebGLShader | null {
  const shader = gl.createShader(gl.FRAGMENT_SHADER);
  if (!shader) {
    console.warn("[ShaderThumb] createShader(FRAGMENT) returned null, gl.getError()=%d", gl.getError());
    return null;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    return shader;
  }
  const info = gl.getShaderInfoLog(shader) ?? "";
  // Log at debug level — thumbnail compile failures are expected for multi-pass / advanced ISF shaders
  console.debug("[ShaderThumb] Fragment compile failed: %s", info.slice(0, 200));
  gl.deleteShader(shader);
  return null;
}

function renderWithSharedContext(
  fragmentSource: string,
  width: number,
  height: number,
  setupUniforms: (gl: WebGLRenderingContext, program: WebGLProgram) => (() => void) | void,
  customVertexSource?: string | null
): string | null {
  const gl = getSharedGl(width, height);
  if (!gl || !_sharedVertexShader || !_sharedQuadBuffer) return null;

  // Compile per-render fragment shader
  const fragmentShader = compileFragmentShader(gl, fragmentSource);
  if (!fragmentShader) return null;

  // Compile per-render custom vertex shader if provided
  let customVertexShader: WebGLShader | null = null;
  if (customVertexSource) {
    customVertexShader = gl.createShader(gl.VERTEX_SHADER);
    if (customVertexShader) {
      gl.shaderSource(customVertexShader, customVertexSource);
      gl.compileShader(customVertexShader);
      if (!gl.getShaderParameter(customVertexShader, gl.COMPILE_STATUS)) {
        console.debug("[ShaderThumb] Custom vertex compile failed: %s",
          (gl.getShaderInfoLog(customVertexShader) ?? "").slice(0, 200));
        gl.deleteShader(customVertexShader);
        customVertexShader = null;
      }
    }
  }
  const vertexShader = customVertexShader ?? _sharedVertexShader;

  // Create + link temporary program
  const program = gl.createProgram();
  if (!program) {
    console.warn("[ShaderThumb] createProgram returned null, gl.getError()=%d", gl.getError());
    gl.deleteShader(fragmentShader);
    if (customVertexShader) gl.deleteShader(customVertexShader);
    return null;
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) ?? "";
    // Link failures are expected for shaders with WebGL1 limitations — log at debug level
    console.debug("[ShaderThumb] Program link failed: %s", info.slice(0, 200));
    gl.detachShader(program, vertexShader);
    gl.detachShader(program, fragmentShader);
    gl.deleteShader(fragmentShader);
    if (customVertexShader) gl.deleteShader(customVertexShader);
    gl.deleteProgram(program);
    return null;
  }

  gl.useProgram(program);

  // Bind shared quad buffer
  const positionAttr = gl.getAttribLocation(program, "a_position");
  if (positionAttr < 0) {
    gl.detachShader(program, vertexShader);
    gl.detachShader(program, fragmentShader);
    gl.deleteShader(fragmentShader);
    if (customVertexShader) gl.deleteShader(customVertexShader);
    gl.deleteProgram(program);
    return null;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, _sharedQuadBuffer);
  gl.enableVertexAttribArray(positionAttr);
  gl.vertexAttribPointer(positionAttr, 2, gl.FLOAT, false, 0, 0);

  // Let caller set uniforms; may return a cleanup function for post-draw resources
  const postDrawCleanup = setupUniforms(gl, program);

  gl.viewport(0, 0, width, height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.disableVertexAttribArray(positionAttr);

  // Clean up any resources the caller created (e.g. dummy textures)
  if (postDrawCleanup) postDrawCleanup();

  const dataUrl = _sharedCanvas!.toDataURL("image/png");

  // Cleanup: detach vertex shader so the shared one survives, delete the rest
  gl.detachShader(program, vertexShader);
  gl.detachShader(program, fragmentShader);
  gl.deleteShader(fragmentShader);
  if (customVertexShader) gl.deleteShader(customVertexShader);
  gl.deleteProgram(program);

  _renderCount++;
  if (_renderCount % 20 === 0) {
    console.info("[ShaderThumb] Rendered %d thumbnails (shared context reused)", _renderCount);
  }

  return dataUrl;
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

export function renderShaderThumbnail(
  fragmentBody: string,
  opts: { width?: number; height?: number; time?: number } = {}
): string | null {
  if (typeof document === "undefined") return null;

  const width = Math.max(1, Math.floor(opts.width ?? 320));
  const height = Math.max(1, Math.floor(opts.height ?? 180));
  const time = opts.time ?? 1.25;

  return renderWithSharedContext(
    buildFragmentShader(fragmentBody),
    width,
    height,
    (gl, program) => {
      const resolutionUniform = gl.getUniformLocation(program, "u_resolution");
      const timeUniform = gl.getUniformLocation(program, "u_time");
      if (resolutionUniform) gl.uniform2f(resolutionUniform, width, height);
      if (timeUniform) gl.uniform1f(timeUniform, time);
    }
  );
}

export function renderIsfSourceThumbnail(
  sourceCode: string,
  opts: { width?: number; height?: number; time?: number } = {}
): string | null {
  if (typeof document === "undefined") return null;
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
    return null;
  }

  const width = Math.max(1, Math.floor(opts.width ?? 320));
  const height = Math.max(1, Math.floor(opts.height ?? 180));
  const time = opts.time ?? 1.25;

  // Build a dynamic vertex shader that matches the ISF body's varying declarations
  const customVertexSource = buildIsfVertexShader(sanitized);

  return renderWithSharedContext(
    fragmentSource,
    width,
    height,
    (gl, program) => {
      const resolutionUniform = gl.getUniformLocation(program, "RENDERSIZE");
      const timeUniform = gl.getUniformLocation(program, "TIME");
      const passIndexUniform = gl.getUniformLocation(program, "PASSINDEX");
      if (resolutionUniform) gl.uniform2f(resolutionUniform, width, height);
      if (timeUniform) gl.uniform1f(timeUniform, time);
      if (passIndexUniform) gl.uniform1i(passIndexUniform, 0);

      const dummyTex = createDummyTexture(gl);
      const imageUniformLocations: WebGLUniformLocation[] = [];
      for (const spec of inputs) {
        const location = gl.getUniformLocation(program, spec.name);
        if (!location) continue;
        applyInputUniform(gl, location, spec);
        if (spec.type === "image") {
          imageUniformLocations.push(location);
        }
      }
      if (dummyTex) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, dummyTex);
        for (const location of imageUniformLocations) {
          gl.uniform1i(location, 0);
        }
        // Bind lastFrame and pass-target samplers to the same dummy texture
        const lastFrameLoc = gl.getUniformLocation(program, "lastFrame");
        if (lastFrameLoc) gl.uniform1i(lastFrameLoc, 0);
        for (const t of passTargets) {
          const loc = gl.getUniformLocation(program, t);
          if (loc) gl.uniform1i(loc, 0);
        }
      }
      // Return cleanup for post-draw: delete dummy texture
      return () => { if (dummyTex) gl.deleteTexture(dummyTex); };
    },
    customVertexSource
  );
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
 * vertex shader that outputs them.  Returns `null` when no extra varyings are
 * found (the caller should use the default simple vertex shader).
 */
function buildIsfVertexShader(fragmentSource: string): string | null {
  const varyingRe = /^\s*varying\s+(vec[234]|float|mat[234])\s+(\w+)(\[\d+\])?/gm;
  const varyings: { type: string; name: string; arraySuffix: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = varyingRe.exec(fragmentSource)) !== null) {
    // Skip v_uv — already declared in the base vertex shader
    if (m[2] === "v_uv") continue;
    varyings.push({ type: m[1], name: m[2], arraySuffix: m[3] ?? "" });
  }
  if (varyings.length === 0) return null;

  // Known ISF neighborhood varyings and their pixel-offset computation
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
      // Array varying — fill each element
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
    } else {
      // mat types or other — zero-init would need mat constructor; skip assignment
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
