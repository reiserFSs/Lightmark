import type { RenderRow, ThemePreset } from "./types";

export interface RenderSize {
  width: number;
  height: number;
}

export type BlurBackend = "WebGL" | "CPU";

export interface BlurredBackground {
  canvas: HTMLCanvasElement;
  backend: BlurBackend;
}

const RENDER_LONG_EDGE = 1600;
const LANDSCAPE_DESIGN_WIDTH = 1600;
const PORTRAIT_DESIGN_WIDTH = 900;
const SQUARE_DESIGN_WIDTH = 1200;
export const DEFAULT_BLUR_RADIUS = 14;

let webglBlurRenderer: WebglBlurRenderer | null | false = null;

export function getRenderSize(imageWidth: number, imageHeight: number): RenderSize {
  if (imageWidth <= 0 || imageHeight <= 0) {
    return { width: 1600, height: 900 };
  }

  const ratio = imageWidth / imageHeight;
  if (ratio >= 1) {
    return {
      width: RENDER_LONG_EDGE,
      height: Math.max(1, Math.round(RENDER_LONG_EDGE / ratio)),
    };
  }

  return {
    width: Math.max(1, Math.round(RENDER_LONG_EDGE * ratio)),
    height: RENDER_LONG_EDGE,
  };
}

export async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (/^https?:\/\//i.test(src)) {
      image.crossOrigin = "anonymous";
    }
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load image"));
    image.src = src;
  });
}

export function renderSummaryCanvas(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
  rows: RenderRow[],
  theme: ThemePreset,
  size: RenderSize,
  scale = 1,
  blurredBackground?: HTMLCanvasElement,
  blurRadius = DEFAULT_BLUR_RADIUS,
  showPanelRule = true,
): void {
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas rendering is not available");
  }

  ctx.save();
  if (blurredBackground) {
    ctx.drawImage(blurredBackground, 0, 0, width, height);
  } else {
    drawBlurredContainImage(ctx, image, width, height, blurRadius * scale);
  }
  ctx.fillStyle = theme.backgroundOverlay;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();

  ctx.save();
  ctx.shadowColor = theme.shadow;
  ctx.shadowBlur = 18 * scale;
  ctx.shadowOffsetY = 4 * scale;
  ctx.fillStyle = theme.text;
  ctx.textBaseline = "middle";

  const layout = layoutForSize(size);
  const textScale = (width / layout.baseWidth) * layout.textBoost;
  const x = width * layout.xRatio;
  let y = height * layout.technicalYRatio;
  const iconGap = 62 * textScale;
  const technical = rows.filter((row) => row.group === "technical").slice(0, 5);
  const production = rows.filter((row) => row.group === "production").slice(0, 8);

  ctx.font = `${42 * textScale}px ${theme.fontFamily}`;
  for (const row of technical) {
    drawGlyph(ctx, row.key, x, y, textScale, theme.accent);
    ctx.fillStyle = theme.text;
    ctx.fillText(row.value, x + iconGap, y);
    y += 72 * textScale;
  }

  const ruleY = height * layout.ruleYRatio;
  if (showPanelRule) {
    ctx.strokeStyle = theme.panelRule;
    ctx.lineWidth = Math.max(1, scale);
    ctx.beginPath();
    ctx.moveTo(width * layout.ruleStartRatio, ruleY);
    ctx.lineTo(width * layout.ruleEndRatio, ruleY);
    ctx.stroke();
  }

  ctx.font = `${25 * textScale}px ${theme.fontFamily}`;
  y = ruleY + 50 * textScale;
  for (const row of production) {
    drawGlyph(ctx, row.key, x, y, textScale * 0.72, theme.accent);
    ctx.fillStyle = theme.mutedText;
    const textX = x + 46 * textScale;
    const maxTextWidth = width * layout.ruleEndRatio - textX;
    const lineHeight = 31 * textScale;
    const lines = wrapCanvasText(ctx, row.value, maxTextWidth, 2);
    drawWrappedText(ctx, lines, textX, y, lineHeight);
    y += Math.max(43 * textScale, lines.length * lineHeight + 12 * textScale);
  }

  ctx.restore();
}

export function renderBlurredBackground(
  image: CanvasImageSource,
  size: RenderSize,
  scale = 1,
  blurRadius = DEFAULT_BLUR_RADIUS,
): BlurredBackground {
  const gpuCanvas = renderWebglBlurredBackground(image, size, scale, blurRadius);
  if (gpuCanvas) {
    return { canvas: gpuCanvas, backend: "WebGL" };
  }

  const canvas = createCanvas(Math.round(size.width * scale), Math.round(size.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas rendering is not available");
  }

  drawBlurredContainImage(ctx, image, canvas.width, canvas.height, blurRadius * scale);
  return { canvas, backend: "CPU" };
}

function renderWebglBlurredBackground(
  image: CanvasImageSource,
  size: RenderSize,
  scale: number,
  blurRadius: number,
): HTMLCanvasElement | null {
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);

  if (webglBlurRenderer === false) {
    return null;
  }

  try {
    if (!webglBlurRenderer) {
      webglBlurRenderer = new WebglBlurRenderer();
    }

    return webglBlurRenderer.render(image, width, height, blurRadius * scale);
  } catch {
    if (webglBlurRenderer) {
      webglBlurRenderer.dispose();
      webglBlurRenderer = null;
    } else {
      webglBlurRenderer = false;
    }
    return null;
  }
}

class WebglBlurRenderer {
  private readonly canvas = createCanvas(1, 1);
  private readonly gl: WebGLRenderingContext;
  private readonly program: WebGLProgram;
  private readonly positionBuffer: WebGLBuffer;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly positionLocation: number;
  private readonly imageLocation: WebGLUniformLocation;
  private readonly resolutionLocation: WebGLUniformLocation;
  private readonly sourceResolutionLocation: WebGLUniformLocation;
  private readonly directionLocation: WebGLUniformLocation;
  private readonly radiusLocation: WebGLUniformLocation;
  private readonly containLocation: WebGLUniformLocation;

  constructor() {
    const gl = this.canvas.getContext("webgl", {
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error("WebGL rendering is not available");
    }

    const program = createBlurProgram(gl);
    const positionBuffer = gl.createBuffer();
    const framebuffer = gl.createFramebuffer();
    if (!positionBuffer || !framebuffer) {
      if (positionBuffer) {
        gl.deleteBuffer(positionBuffer);
      }
      if (framebuffer) {
        gl.deleteFramebuffer(framebuffer);
      }
      gl.deleteProgram(program);
      throw new Error("Could not create WebGL blur resources");
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    try {
      const positionLocation = gl.getAttribLocation(program, "a_position");
      if (positionLocation < 0) {
        throw new Error("Missing WebGL attribute a_position");
      }

      this.gl = gl;
      this.program = program;
      this.positionBuffer = positionBuffer;
      this.framebuffer = framebuffer;
      this.positionLocation = positionLocation;
      this.imageLocation = requiredUniform(gl, program, "u_image");
      this.resolutionLocation = requiredUniform(gl, program, "u_resolution");
      this.sourceResolutionLocation = requiredUniform(gl, program, "u_sourceResolution");
      this.directionLocation = requiredUniform(gl, program, "u_direction");
      this.radiusLocation = requiredUniform(gl, program, "u_radius");
      this.containLocation = requiredUniform(gl, program, "u_contain");
    } catch (error) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteBuffer(positionBuffer);
      gl.deleteProgram(program);
      throw error;
    }
  }

  render(image: CanvasImageSource, width: number, height: number, blurRadius: number): HTMLCanvasElement {
    const { gl } = this;
    const sourceTexture = createSourceTexture(gl, image);
    const tempTexture = createEmptyTexture(gl, width, height);
    if (!sourceTexture || !tempTexture) {
      if (sourceTexture) {
        gl.deleteTexture(sourceTexture);
      }
      if (tempTexture) {
        gl.deleteTexture(tempTexture);
      }
      throw new Error("Could not create WebGL blur textures");
    }

    try {
      this.canvas.width = width;
      this.canvas.height = height;

      const imageSize = imageDimensions(image);
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
      gl.enableVertexAttribArray(this.positionLocation);
      gl.vertexAttribPointer(this.positionLocation, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1i(this.imageLocation, 0);
      gl.uniform2f(this.resolutionLocation, width, height);
      gl.uniform1f(this.radiusLocation, blurRadius);
      gl.viewport(0, 0, width, height);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tempTexture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("WebGL blur framebuffer is incomplete");
      }
      gl.uniform2f(this.sourceResolutionLocation, imageSize.width, imageSize.height);
      gl.uniform2f(this.directionLocation, 1, 0);
      gl.uniform1i(this.containLocation, 1);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      gl.bindTexture(gl.TEXTURE_2D, tempTexture);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.uniform2f(this.sourceResolutionLocation, width, height);
      gl.uniform2f(this.directionLocation, 0, 1);
      gl.uniform1i(this.containLocation, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      return copyCanvas(this.canvas);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.deleteTexture(sourceTexture);
      gl.deleteTexture(tempTexture);
    }
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteBuffer(this.positionBuffer);
    gl.deleteProgram(this.program);
  }
}

export function canvasToDataUrl(canvas: HTMLCanvasElement, format: "png" | "jpg"): string {
  return canvas.toDataURL(format === "jpg" ? "image/jpeg" : "image/png", 0.94);
}

function drawContainImage(ctx: CanvasRenderingContext2D, image: CanvasImageSource, width: number, height: number): void {
  const { width: imageWidth, height: imageHeight } = imageDimensions(image);
  const scale = Math.min(width / imageWidth, height / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawBlurredContainImage(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
  blurRadius: number,
): void {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);

  if (drawFilteredBlurredContainImage(ctx, image, width, height, blurRadius)) {
    return;
  }

  const scratch = createCanvas(Math.round(width), Math.round(height));
  const scratchCtx = scratch.getContext("2d", { willReadFrequently: true });

  if (!scratchCtx) {
    drawContainImage(ctx, image, width, height);
    return;
  }

  scratchCtx.fillStyle = "#000";
  scratchCtx.fillRect(0, 0, scratch.width, scratch.height);
  drawContainImage(scratchCtx, image, scratch.width, scratch.height);
  const imageData = scratchCtx.getImageData(0, 0, scratch.width, scratch.height);
  applyBoxBlur(imageData, Math.max(1, Math.round(blurRadius)));
  scratchCtx.putImageData(imageData, 0, 0);
  ctx.drawImage(scratch, 0, 0, width, height);
}

function drawFilteredBlurredContainImage(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  width: number,
  height: number,
  blurRadius: number,
): boolean {
  const filteredCtx = ctx as CanvasRenderingContext2D & { filter?: string };
  if (typeof filteredCtx.filter !== "string") {
    return false;
  }

  ctx.save();
  try {
    filteredCtx.filter = `blur(${Math.max(0, blurRadius)}px)`;
    drawContainImage(ctx, image, width, height);
    return true;
  } finally {
    ctx.restore();
  }
}

function createBlurProgram(gl: WebGLRenderingContext): WebGLProgram {
  const vertexShader = compileShader(
    gl,
    gl.VERTEX_SHADER,
    `
      attribute vec2 a_position;
      varying vec2 v_texCoord;

      void main() {
        v_texCoord = (a_position + 1.0) * 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `,
  );
  const fragmentShader = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    `
      precision mediump float;

      uniform sampler2D u_image;
      uniform vec2 u_resolution;
      uniform vec2 u_sourceResolution;
      uniform vec2 u_direction;
      uniform float u_radius;
      uniform bool u_contain;
      varying vec2 v_texCoord;

      vec2 containCoord(vec2 uv) {
        float outputRatio = u_resolution.x / u_resolution.y;
        float sourceRatio = u_sourceResolution.x / u_sourceResolution.y;
        vec2 visible = vec2(1.0);

        if (sourceRatio > outputRatio) {
          visible.y = outputRatio / sourceRatio;
        } else {
          visible.x = sourceRatio / outputRatio;
        }

        return clamp((uv - 0.5) / visible + 0.5, 0.0, 1.0);
      }

      void main() {
        vec2 baseCoord = u_contain ? containCoord(v_texCoord) : v_texCoord;
        vec2 stepSize = u_direction * (u_radius / 12.0) / u_resolution;
        vec4 sum = vec4(0.0);
        float weightSum = 0.0;

        for (int i = -12; i <= 12; i++) {
          float offset = float(i);
          float weight = exp(-0.5 * (offset * offset) / 32.0);
          sum += texture2D(u_image, baseCoord + stepSize * offset) * weight;
          weightSum += weight;
        }

        gl_FragColor = sum / weightSum;
      }
    `,
  );
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("Could not create WebGL program");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? "Could not link WebGL program";
    gl.deleteProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error(message);
  }

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  return program;
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error("Could not create WebGL shader");
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) ?? "Could not compile WebGL shader";
    gl.deleteShader(shader);
    throw new Error(message);
  }

  return shader;
}

function createSourceTexture(gl: WebGLRenderingContext, image: CanvasImageSource): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) {
    return null;
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image as TexImageSource);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  return texture;
}

function createEmptyTexture(gl: WebGLRenderingContext, width: number, height: number): WebGLTexture | null {
  const texture = gl.createTexture();
  if (!texture) {
    return null;
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  return texture;
}

function requiredUniform(gl: WebGLRenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) {
    throw new Error(`Missing WebGL uniform ${name}`);
  }

  return location;
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function copyCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = createCanvas(source.width, source.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Canvas rendering is not available");
  }

  ctx.drawImage(source, 0, 0);
  return canvas;
}

function applyBoxBlur(imageData: ImageData, radius: number): void {
  if (radius < 1) {
    return;
  }

  const { width, height, data } = imageData;
  const source = new Uint8ClampedArray(data);
  const temp = new Uint8ClampedArray(data.length);

  boxBlurHorizontal(source, temp, width, height, radius);
  boxBlurVertical(temp, data, width, height, radius);
  source.set(data);
  boxBlurHorizontal(source, temp, width, height, Math.max(1, Math.round(radius * 0.72)));
  boxBlurVertical(temp, data, width, height, Math.max(1, Math.round(radius * 0.72)));
}

function boxBlurHorizontal(
  source: Uint8ClampedArray,
  target: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): void {
  const windowSize = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;

    for (let offset = -radius; offset <= radius; offset += 1) {
      const x = clamp(offset, 0, width - 1);
      const index = (row + x) * 4;
      red += source[index];
      green += source[index + 1];
      blue += source[index + 2];
      alpha += source[index + 3];
    }

    for (let x = 0; x < width; x += 1) {
      const targetIndex = (row + x) * 4;
      target[targetIndex] = red / windowSize;
      target[targetIndex + 1] = green / windowSize;
      target[targetIndex + 2] = blue / windowSize;
      target[targetIndex + 3] = alpha / windowSize;

      const removeX = clamp(x - radius, 0, width - 1);
      const addX = clamp(x + radius + 1, 0, width - 1);
      const removeIndex = (row + removeX) * 4;
      const addIndex = (row + addX) * 4;
      red += source[addIndex] - source[removeIndex];
      green += source[addIndex + 1] - source[removeIndex + 1];
      blue += source[addIndex + 2] - source[removeIndex + 2];
      alpha += source[addIndex + 3] - source[removeIndex + 3];
    }
  }
}

function boxBlurVertical(
  source: Uint8ClampedArray,
  target: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
): void {
  const windowSize = radius * 2 + 1;

  for (let x = 0; x < width; x += 1) {
    let red = 0;
    let green = 0;
    let blue = 0;
    let alpha = 0;

    for (let offset = -radius; offset <= radius; offset += 1) {
      const y = clamp(offset, 0, height - 1);
      const index = (y * width + x) * 4;
      red += source[index];
      green += source[index + 1];
      blue += source[index + 2];
      alpha += source[index + 3];
    }

    for (let y = 0; y < height; y += 1) {
      const targetIndex = (y * width + x) * 4;
      target[targetIndex] = red / windowSize;
      target[targetIndex + 1] = green / windowSize;
      target[targetIndex + 2] = blue / windowSize;
      target[targetIndex + 3] = alpha / windowSize;

      const removeY = clamp(y - radius, 0, height - 1);
      const addY = clamp(y + radius + 1, 0, height - 1);
      const removeIndex = (removeY * width + x) * 4;
      const addIndex = (addY * width + x) * 4;
      red += source[addIndex] - source[removeIndex];
      green += source[addIndex + 1] - source[removeIndex + 1];
      blue += source[addIndex + 2] - source[removeIndex + 2];
      alpha += source[addIndex + 3] - source[removeIndex + 3];
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface LayoutTokens {
  baseWidth: number;
  textBoost: number;
  xRatio: number;
  technicalYRatio: number;
  ruleYRatio: number;
  ruleStartRatio: number;
  ruleEndRatio: number;
}

function layoutForSize(size: RenderSize): LayoutTokens {
  const ratio = size.width / size.height;

  if (ratio < 0.92) {
    return {
      baseWidth: PORTRAIT_DESIGN_WIDTH,
      textBoost: 1.13,
      xRatio: 0.09,
      technicalYRatio: 0.18,
      ruleYRatio: 0.61,
      ruleStartRatio: 0.09,
      ruleEndRatio: 0.91,
    };
  }

  if (ratio <= 1.08) {
    return {
      baseWidth: SQUARE_DESIGN_WIDTH,
      textBoost: 1.04,
      xRatio: 0.1,
      technicalYRatio: 0.15,
      ruleYRatio: 0.58,
      ruleStartRatio: 0.09,
      ruleEndRatio: 0.9,
    };
  }

  return {
    baseWidth: LANDSCAPE_DESIGN_WIDTH,
    textBoost: 1,
    xRatio: 0.106,
    technicalYRatio: 0.16,
    ruleYRatio: 0.567,
    ruleStartRatio: 0.094,
    ruleEndRatio: 0.884,
  };
}

function imageDimensions(image: CanvasImageSource): { width: number; height: number } {
  const source = image as {
    naturalWidth?: number;
    naturalHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
    width?: number | { baseVal?: { value: number } };
    height?: number | { baseVal?: { value: number } };
  };

  return {
    width: Number(source.naturalWidth ?? source.videoWidth ?? source.displayWidth ?? dimensionValue(source.width)),
    height: Number(source.naturalHeight ?? source.videoHeight ?? source.displayHeight ?? dimensionValue(source.height)),
  };
}

function dimensionValue(value: number | { baseVal?: { value: number } } | undefined): number {
  if (typeof value === "number") {
    return value;
  }

  return value?.baseVal?.value ?? 1;
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = word;
    } else {
      const broken = breakLongWord(ctx, word, maxWidth);
      lines.push(broken[0]);
      current = broken[1] ?? "";
    }

    if (lines.length === maxLines) {
      return lines;
    }

    while (current && ctx.measureText(current).width > maxWidth && lines.length < maxLines) {
      const broken = breakLongWord(ctx, current, maxWidth);
      lines.push(broken[0]);
      current = broken[1] ?? "";
    }

    if (lines.length === maxLines) {
      return lines;
    }
  }

  if (current && lines.length < maxLines) {
    lines.push(current);
  }

  return lines;
}

function breakLongWord(ctx: CanvasRenderingContext2D, word: string, maxWidth: number): string[] {
  let head = "";
  for (const char of word) {
    if (ctx.measureText(head + char).width > maxWidth) {
      return [head, word.slice(head.length)];
    }
    head += char;
  }

  return [word];
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  lines: string[],
  x: number,
  y: number,
  lineHeight: number,
): void {
  for (const [index, line] of lines.entries()) {
    ctx.fillText(line, x, y + index * lineHeight);
  }
}

function drawGlyph(
  ctx: CanvasRenderingContext2D,
  key: string,
  x: number,
  y: number,
  scale: number,
  color: string,
): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (key === "aperture") {
    ctx.beginPath();
    ctx.arc(0, 0, 17, 0, Math.PI * 2);
    ctx.stroke();
    for (let index = 0; index < 6; index += 1) {
      ctx.rotate(Math.PI / 3);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(17, -6);
      ctx.stroke();
    }
  } else if (key === "shutterSpeed" || key === "captureTime") {
    ctx.beginPath();
    ctx.arc(0, 0, 17, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -11);
    ctx.moveTo(0, 0);
    ctx.lineTo(10, 5);
    ctx.stroke();
  } else if (key === "iso") {
    ctx.beginPath();
    ctx.roundRect(-18, -13, 36, 26, 5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(-8, 0, 5, 0, Math.PI * 2);
    ctx.arc(8, 0, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-18, -5);
    ctx.lineTo(18, -5);
    ctx.moveTo(-18, 5);
    ctx.lineTo(18, 5);
    ctx.stroke();
  } else if (key === "cameraBody") {
    ctx.strokeRect(-18, -12, 36, 24);
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.stroke();
  } else if (key === "focalLength") {
    ctx.beginPath();
    ctx.moveTo(-18, -12);
    ctx.lineTo(16, 0);
    ctx.lineTo(-18, 12);
    ctx.closePath();
    ctx.stroke();
  } else if (key === "lens") {
    ctx.beginPath();
    ctx.ellipse(0, 0, 15, 17, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(0, 0, 7, 9, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-18, -10);
    ctx.lineTo(-12, -14);
    ctx.moveTo(18, -10);
    ctx.lineTo(12, -14);
    ctx.moveTo(-18, 10);
    ctx.lineTo(-12, 14);
    ctx.moveTo(18, 10);
    ctx.lineTo(12, 14);
    ctx.stroke();
  } else if (key === "bitDepth") {
    ctx.strokeRect(-15, -12, 30, 24);
    ctx.beginPath();
    ctx.moveTo(-9, -4);
    ctx.lineTo(9, -4);
    ctx.moveTo(-9, 4);
    ctx.lineTo(9, 4);
    ctx.stroke();
  } else if (key === "lightingModifier") {
    ctx.beginPath();
    ctx.moveTo(-16, -10);
    ctx.quadraticCurveTo(-2, -20, 12, -10);
    ctx.lineTo(16, 10);
    ctx.quadraticCurveTo(0, 18, -16, 10);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-10, -8);
    ctx.quadraticCurveTo(0, -2, 10, -8);
    ctx.moveTo(-12, 6);
    ctx.quadraticCurveTo(0, 12, 12, 6);
    ctx.stroke();
  } else if (key === "lightSource") {
    ctx.beginPath();
    ctx.moveTo(-13, -17);
    ctx.lineTo(13, -17);
    ctx.lineTo(5, 2);
    ctx.lineTo(16, 2);
    ctx.lineTo(-4, 20);
    ctx.lineTo(0, 6);
    ctx.lineTo(-13, 6);
    ctx.closePath();
    ctx.stroke();
  } else if (key === "notes") {
    ctx.beginPath();
    ctx.roundRect(-15, -18, 30, 36, 3);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-7, -7);
    ctx.lineTo(8, -7);
    ctx.moveTo(-7, 1);
    ctx.lineTo(8, 1);
    ctx.moveTo(-7, 9);
    ctx.lineTo(4, 9);
    ctx.stroke();
  } else if (key === "photographer") {
    ctx.beginPath();
    ctx.arc(0, -7, 8, 0, Math.PI * 2);
    ctx.moveTo(-15, 18);
    ctx.quadraticCurveTo(0, 4, 15, 18);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, 14, 0, Math.PI * 2);
    ctx.moveTo(-6, 0);
    ctx.lineTo(6, 0);
    ctx.stroke();
  }

  ctx.restore();
}
