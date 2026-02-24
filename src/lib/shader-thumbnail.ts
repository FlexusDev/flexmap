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

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    return shader;
  }
  gl.deleteShader(shader);
  return null;
}

export function renderShaderThumbnail(
  fragmentBody: string,
  opts: { width?: number; height?: number; time?: number } = {}
): string | null {
  if (typeof document === "undefined") return null;

  const width = Math.max(1, Math.floor(opts.width ?? 320));
  const height = Math.max(1, Math.floor(opts.height ?? 180));
  const time = opts.time ?? 1.25;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const gl = canvas.getContext("webgl", {
    antialias: false,
    depth: false,
    alpha: true,
    preserveDrawingBuffer: true,
    premultipliedAlpha: true,
  });
  if (!gl) return null;

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, buildFragmentShader(fragmentBody));
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  gl.useProgram(program);
  const positionAttr = gl.getAttribLocation(program, "a_position");
  if (positionAttr < 0) {
    gl.deleteProgram(program);
    return null;
  }

  const buffer = gl.createBuffer();
  if (!buffer) {
    gl.deleteProgram(program);
    return null;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
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

  const resolutionUniform = gl.getUniformLocation(program, "u_resolution");
  const timeUniform = gl.getUniformLocation(program, "u_time");
  if (resolutionUniform) gl.uniform2f(resolutionUniform, width, height);
  if (timeUniform) gl.uniform1f(timeUniform, time);
  gl.viewport(0, 0, width, height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  const dataUrl = canvas.toDataURL("image/png");
  gl.deleteBuffer(buffer);
  gl.deleteProgram(program);
  return dataUrl;
}

export function renderIsfSourceThumbnail(
  sourceCode: string,
  opts: { width?: number; height?: number; time?: number } = {}
): string | null {
  if (typeof document === "undefined") return null;
  const { body, inputs } = extractIsfSource(sourceCode);
  const uniformDecl = inputs.map((input) => toUniformDeclaration(input)).filter(Boolean).join("\n");
  const sanitized = sanitizeIsfBody(body);
  const fragmentSource = `
precision mediump float;
varying vec2 v_uv;
uniform vec2 RENDERSIZE;
uniform float TIME;
uniform int PASSINDEX;
${uniformDecl}

#define isf_FragNormCoord v_uv
vec4 IMG_NORM_PIXEL(sampler2D img, vec2 loc) { return texture2D(img, loc); }
vec4 IMG_PIXEL(sampler2D img, vec2 loc) { return texture2D(img, loc / max(RENDERSIZE, vec2(1.0, 1.0))); }
vec2 IMG_SIZE(sampler2D img) { return vec2(1.0, 1.0); }

${sanitized}
`;

  if (!/void\s+main\s*\(/.test(fragmentSource)) {
    return null;
  }

  const width = Math.max(1, Math.floor(opts.width ?? 320));
  const height = Math.max(1, Math.floor(opts.height ?? 180));
  const time = opts.time ?? 1.25;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const gl = canvas.getContext("webgl", {
    antialias: false,
    depth: false,
    alpha: true,
    preserveDrawingBuffer: true,
    premultipliedAlpha: true,
  });
  if (!gl) return null;

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER_SOURCE);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertexShader || !fragmentShader) {
    if (vertexShader) gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
    return null;
  }

  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    return null;
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  gl.useProgram(program);
  const positionAttr = gl.getAttribLocation(program, "a_position");
  if (positionAttr < 0) {
    gl.deleteProgram(program);
    return null;
  }

  const buffer = gl.createBuffer();
  if (!buffer) {
    gl.deleteProgram(program);
    return null;
  }

  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
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
  if (imageUniformLocations.length > 0 && dummyTex) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, dummyTex);
    for (const location of imageUniformLocations) {
      gl.uniform1i(location, 0);
    }
  }

  gl.viewport(0, 0, width, height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  const dataUrl = canvas.toDataURL("image/png");
  gl.deleteTexture(dummyTex);
  gl.deleteBuffer(buffer);
  gl.deleteProgram(program);
  return dataUrl;
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
