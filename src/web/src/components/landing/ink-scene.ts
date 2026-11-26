// "Two inks, one mark": a GPU stable-fluids simulation (WebGL2, half-float ping-pong
// textures). A warm ink (a person) rises from the left with a wavering hand; a mint
// ink (an agent) rises from the right, steady. They curl and wind together, then the
// ink gathers into the LetAgents mark, marbled with both, while the rest clears and
// the water calms. The dot ignites. Fixed time step, so every run plays the same.
// Ported from the desktop onboarding demo (variant "ink") for the website landing page.

export const INK_END = 5.6;
const STEP = 1 / 60;

const WARM: [number, number, number] = [1.0, 0.5, 0.2];
const MINT: [number, number, number] = [0.28, 1.0, 0.72];

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const smooth = (a: number, b: number, t: number) => { const x = clamp((t - a) / (b - a)); return x * x * (3 - 2 * x); };

const baseVertex = `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUv, vL, vR, vT, vB;
uniform vec2 texelSize;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0); vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y); vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const head = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB;
out vec4 o;
`;

// The mark, static, in svg units (y up), used to gather the ink.
const markGlsl = `
float sdRoundBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdBox(vec2 p, vec2 b) { vec2 d = abs(p) - b; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
float sdSeg(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
float mark2D(vec2 p) {
  float frame = abs(sdRoundBox(p, vec2(64.0), 35.0)) - 5.0;
  frame = max(frame, -sdBox(p - vec2(64.0, 0.0), vec2(12.0, 17.0)));
  frame = min(frame, length(p - vec2(64.0, 17.0)) - 5.0);
  frame = min(frame, length(p - vec2(64.0, -17.0)) - 5.0);
  float a = sdSeg(p, vec2(-30.0, -31.0), vec2(0.0, 37.0)) - 5.0;
  a = min(a, sdSeg(p, vec2(0.0, 37.0), vec2(30.0, -31.0)) - 5.0);
  a = min(a, sdSeg(p, vec2(-18.0, -4.0), vec2(18.0, -4.0)) - 5.0);
  return min(frame, a);
}
uniform float aspect;
uniform vec2 markCenter;
uniform float markHeight;
vec2 toMark(vec2 uv) { vec2 q = uv - markCenter; q.x *= aspect; return q / markHeight * 128.0; }
float markMask(vec2 uv) { return smoothstep(1.8, -1.8, mark2D(toMark(uv))); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) { vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
`;

const shaders = {
  splat: head + `
uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color; uniform vec2 point; uniform float radius;
void main() { vec2 p = vUv - point; p.x *= aspectRatio; o = vec4(texture(uTarget, vUv).xyz + exp(-dot(p, p) / radius) * color, 1.0); }`,
  advection: head + `
uniform sampler2D uVelocity, uSource; uniform vec2 texelSize; uniform float dt, dissipation;
void main() { vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize; o = texture(uSource, coord) / (1.0 + dissipation * dt); }`,
  divergence: head + `
uniform sampler2D uVelocity;
void main() {
  float L = texture(uVelocity, vL).x, R = texture(uVelocity, vR).x, T = texture(uVelocity, vT).y, B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) L = -C.x; if (vR.x > 1.0) R = -C.x; if (vT.y > 1.0) T = -C.y; if (vB.y < 0.0) B = -C.y;
  o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`,
  curl: head + `
uniform sampler2D uVelocity;
void main() { o = vec4(0.5 * (texture(uVelocity, vR).y - texture(uVelocity, vL).y - texture(uVelocity, vT).x + texture(uVelocity, vB).x), 0.0, 0.0, 1.0); }`,
  vorticity: head + `
uniform sampler2D uVelocity, uCurl; uniform float curl, dt;
void main() {
  float L = texture(uCurl, vL).x, R = texture(uCurl, vR).x, T = texture(uCurl, vT).x, B = texture(uCurl, vB).x, C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001; force *= curl * C; force.y *= -1.0;
  o = vec4(clamp(texture(uVelocity, vUv).xy + force * dt, -1000.0, 1000.0), 0.0, 1.0);
}`,
  pressure: head + `
uniform sampler2D uPressure, uDivergence;
void main() {
  float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x, T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
  o = vec4((L + R + B + T - texture(uDivergence, vUv).x) * 0.25, 0.0, 0.0, 1.0);
}`,
  clear: head + `
uniform sampler2D uTexture; uniform float value;
void main() { o = value * texture(uTexture, vUv); }`,
  gradient: head + `
uniform sampler2D uPressure, uVelocity;
void main() {
  float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x, T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
  o = vec4(texture(uVelocity, vUv).xy - vec2(R - L, T - B), 0.0, 1.0);
}`,
  // Ink gathers into the mark, marbled with both colours; ink elsewhere clears.
  gather: head + markGlsl + `
uniform sampler2D uTarget; uniform float amount, clearing, boost; uniform vec3 warm, mint;
void main() {
  vec4 ink = texture(uTarget, vUv);
  float m = markMask(vUv);
  vec2 q = toMark(vUv);
  float vein = 0.5 + 0.5 * sin((q.x * 0.62 + q.y * 0.4) * 0.085 + 3.2 * noise(q * 0.028) + 1.4 * noise(q * 0.09));
  vec3 marble = mix(warm, mint, smoothstep(0.15, 0.85, vein));
  // Mostly the ink that has arrived, made denser; a little of both colours to fill gaps.
  // The dot's place in the gap is spared from clearing, but not filled before it ignites.
  float keep = max(m, smoothstep(2.0, -2.0, length(q - vec2(64.0, 0.0)) - 9.0));
  o = vec4(ink.rgb * (1.0 - (1.0 - keep) * clearing) * (1.0 + m * boost) + marble * m * amount, 1.0);
}`,
  // The water inside the mark goes still, so the gathered ink keeps its shape.
  hold: head + markGlsl + `
uniform sampler2D uVelocity; uniform float damping, attract;
void main() {
  vec2 v = texture(uVelocity, vUv).xy;
  // Draw the inks in toward the mark, with a turn, so they spiral into each other.
  vec2 d = markCenter - vUv; d.x *= aspect;
  float r = length(d) + 0.0001;
  vec2 inward = d / r, around = vec2(-inward.y, inward.x);
  v += (inward * 0.85 + around * 0.45) * attract * smoothstep(0.02, 0.2, r);
  o = vec4(v * (1.0 - markMask(vUv) * damping), 0.0, 1.0);
}`,
  display: head + `
uniform sampler2D uTexture; uniform vec2 texelSize;
uniform float ripple, fade, aspectRatio; uniform vec2 dotPoint;
float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
void main() {
  vec3 c = texture(uTexture, vUv).rgb;
  // Smoke has body: shade by the slope of its density, lit from the top left.
  float dx = lum(texture(uTexture, vR).rgb) - lum(texture(uTexture, vL).rgb);
  float dy = lum(texture(uTexture, vT).rgb) - lum(texture(uTexture, vB).rgb);
  vec3 n = normalize(vec3(dx, dy, length(texelSize) * 6.0));
  float lit = clamp(0.78 + 0.32 * dot(n, normalize(vec3(-0.5, 0.6, 0.62))), 0.55, 1.12);
  vec3 glow = vec3(0.0);
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    glow += texture(uTexture, vUv + vec2(cos(a), sin(a)) * texelSize * 9.0).rgb;
  }
  vec3 ink = c * lit + glow / 8.0 * 0.22;
  ink = 1.0 - exp(-ink * 1.45);
  vec3 col = vec3(0.039, 0.043, 0.039) + ink;
  // Sign-in succeeded: one ring of light leaves the dot.
  if (ripple > 0.0 && ripple < 1.0) {
    vec2 d = vUv - dotPoint; d.x *= aspectRatio;
    float ring = exp(-pow((length(d) - ripple * 0.6) / (0.006 + ripple * 0.02), 2.0));
    col += vec3(0.72, 1.0, 0.88) * ring * 0.32 * (1.0 - ripple);
  }
  // Leaving for the next screen.
  col = mix(col, vec3(0.047, 0.055, 0.051), fade);
  o = vec4(pow(col, vec3(0.92)), 1.0);
}`,
};

type Uniforms = Record<string, WebGLUniformLocation | null>;
interface Program { program: WebGLProgram; uniforms: Uniforms }
interface Target { texture: WebGLTexture; fbo: WebGLFramebuffer; width: number; height: number; texel: [number, number] }
interface Double { read: Target; write: Target; swap(): void }

export type InkMode = "still" | "simmer" | "success" | "settle" | "stir" | "pulse";
export interface InkSceneOptions {
  /** Smaller grids for phones and low-power screens. */
  light?: boolean;
  /** Where the mark forms, in uv (y up). Default: upper middle. */
  markCenter?: [number, number];
  /** The mark's height as a part of the canvas height. */
  markHeight?: number;
}
export interface InkScene {
  end: number;
  render(t: number): void;
  resize(): void;
  dispose(): void;
  /** After the opening: keep the fluid alive while sign-in waits, then resolve it. */
  setMode(mode: InkMode): void;
  /** Advance the live mode to wall-clock `now` (ms). Returns false once the mode has come to rest. */
  live(now: number): boolean;
  /** The visitor's pointer moved: leave warm ink along the way (uv, y up). Starts or extends "stir". */
  stir(x: number, y: number, dx: number, dy: number): void;
  /** The agent answers: a ring of light from the dot and a mint stream toward a point (uv, y up). */
  pulse(x: number, y: number): void;
}

/** Returns null when the browser cannot render half-float textures; the page then shows its static mark. */
export function createInkScene(canvas: HTMLCanvasElement, options: InkSceneOptions = {}): InkScene | null {
  const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) return null;
  // Half-float colour targets: some mobile GPUs offer only the half-float extension.
  if (!gl.getExtension("EXT_color_buffer_float") && !gl.getExtension("EXT_color_buffer_half_float")) return null;
  gl.getExtension("OES_texture_float_linear");

  const created: Array<() => void> = [];
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "shader failed");
    created.push(() => gl.deleteShader(shader));
    return shader;
  };
  const vertex = compile(gl.VERTEX_SHADER, baseVertex);
  const programs = Object.fromEntries(Object.entries(shaders).map(([name, source]) => {
    const program = gl.createProgram()!;
    gl.attachShader(program, vertex);
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, source));
    gl.bindAttribLocation(program, 0, "aPosition");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`${name}: ${gl.getProgramInfoLog(program)}`);
    created.push(() => gl.deleteProgram(program));
    const uniforms: Uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i)!;
      uniforms[info.name] = gl.getUniformLocation(program, info.name);
    }
    return [name, { program, uniforms }];
  })) as Record<keyof typeof shaders, Program>;

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  created.push(() => gl.deleteBuffer(buffer));

  function target(width: number, height: number, internal: number, format: number): Target {
    const texture = gl!.createTexture()!;
    gl!.bindTexture(gl!.TEXTURE_2D, texture);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
    gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
    gl!.texImage2D(gl!.TEXTURE_2D, 0, internal, width, height, 0, format, gl!.HALF_FLOAT, null);
    const fbo = gl!.createFramebuffer()!;
    gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
    gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, texture, 0);
    gl!.viewport(0, 0, width, height);
    gl!.clearColor(0, 0, 0, 1);
    gl!.clear(gl!.COLOR_BUFFER_BIT);
    created.push(() => { gl!.deleteTexture(texture); gl!.deleteFramebuffer(fbo); });
    return { texture, fbo, width, height, texel: [1 / width, 1 / height] };
  }
  function double(width: number, height: number, internal: number, format: number): Double {
    let a = target(width, height, internal, format), b = target(width, height, internal, format);
    return { get read() { return a; }, get write() { return b; }, swap() { [a, b] = [b, a]; } } as Double;
  }

  // Fixed grids from the first size: a resize changes only how the dye is shown.
  const box = canvas.getBoundingClientRect();
  const aspect = Math.max(.35, (box.width || 16) / (box.height || 10));
  // The grid size is set on the shorter side, so a tall phone keeps enough cells across the mark.
  const grid = (short: number): [number, number] => aspect >= 1 ? [Math.round(short * aspect), short] : [short, Math.round(short / aspect)];
  const [simW, simH] = grid(options.light ? 128 : 160);
  const [dyeW, dyeH] = grid(options.light ? 448 : 720);
  const velocity = double(simW, simH, gl.RG16F, gl.RG);
  const dye = double(dyeW, dyeH, gl.RGBA16F, gl.RGBA);
  // A driver may list the extension and still refuse the target: fall back instead of drawing nothing.
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { created.forEach(remove => remove()); return null; }
  const pressure = double(simW, simH, gl.R16F, gl.RED);
  const divergence = target(simW, simH, gl.R16F, gl.RED);
  const curlField = target(simW, simH, gl.R16F, gl.RED);
  const markCenter: [number, number] = options.markCenter ?? [.5, .66];
  // On a tall phone the mark is kept narrower than the screen, so it does not crowd the headline.
  const markHeight = Math.min(options.markHeight ?? .3, .55 * aspect);

  function run(name: keyof typeof shaders, out: Target | null, set: (u: Uniforms, unit: (t: Target, i: number) => number) => void, texel: [number, number]) {
    const { program, uniforms } = programs[name];
    gl!.useProgram(program);
    gl!.uniform2f(uniforms.texelSize, texel[0], texel[1]);
    set(uniforms, (t, i) => { gl!.activeTexture(gl!.TEXTURE0 + i); gl!.bindTexture(gl!.TEXTURE_2D, t.texture); return i; });
    if (out) { gl!.bindFramebuffer(gl!.FRAMEBUFFER, out.fbo); gl!.viewport(0, 0, out.width, out.height); }
    else { gl!.bindFramebuffer(gl!.FRAMEBUFFER, null); gl!.viewport(0, 0, canvas.width, canvas.height); }
    gl!.drawArrays(gl!.TRIANGLES, 0, 3);
  }
  const markUniforms = (u: Uniforms) => {
    gl!.uniform1f(u.aspect, aspect);
    gl!.uniform2f(u.markCenter, markCenter[0], markCenter[1]);
    gl!.uniform1f(u.markHeight, markHeight);
  };

  function splat(field: Double, x: number, y: number, color: [number, number, number], radius: number) {
    run("splat", field.write, (u, unit) => {
      gl!.uniform1i(u.uTarget, unit(field.read, 0));
      gl!.uniform1f(u.aspectRatio, aspect);
      gl!.uniform2f(u.point, x, y);
      gl!.uniform3f(u.color, color[0], color[1], color[2]);
      gl!.uniform1f(u.radius, radius);
    }, field.read.texel);
    field.swap();
  }

  // One emitter: velocity and ink at a point, in a direction.
  function emit(x: number, y: number, angle: number, strength: number, color: [number, number, number]) {
    if (strength <= 0) return;
    const force = 42 * strength;
    splat(velocity, x, y, [Math.cos(angle) * force, Math.sin(angle) * force, 0], .0011);
    splat(dye, x, y, color.map(c => c * .085 * strength) as [number, number, number], .0009);
  }

  function step(ts: number) {
    const sim = velocity.read.texel;
    // The person: a wavering hand. The agent: steady and regular.
    const warmOn = smooth(0, .3, ts) * (1 - smooth(1.9, 2.4, ts));
    emit(.17 + .025 * Math.sin(ts * 2.3), .02, .92 + .32 * Math.sin(ts * 3.1) + .14 * Math.sin(ts * 7.3 + 1), warmOn, WARM);
    const mintOn = smooth(.12, .42, ts) * (1 - smooth(1.95, 2.45, ts));
    emit(.83, .02, Math.PI - .92 + .08 * Math.sin(ts * 4), mintOn, MINT);

    // The ink gathers into the mark, and the water inside it goes still.
    const gather = smooth(2.4, 2.75, ts) * (1 - smooth(3.2, 3.45, ts));
    const clearing = smooth(2.6, 3.1, ts) * .02;
    if (gather > 0 || clearing > 0) {
      run("gather", dye.write, (u, unit) => {
        markUniforms(u);
        gl!.uniform1i(u.uTarget, unit(dye.read, 0));
        gl!.uniform1f(u.amount, .02 * gather);
        gl!.uniform1f(u.boost, .1 * gather);
        gl!.uniform1f(u.clearing, clearing);
        gl!.uniform3f(u.warm, WARM[0] * .75, WARM[1] * .75, WARM[2] * .75);
        gl!.uniform3f(u.mint, MINT[0] * .7, MINT[1] * .7, MINT[2] * .7);
      }, dye.read.texel);
      dye.swap();
    }
    const holding = smooth(2.45, 2.85, ts) * .14;
    const attract = smooth(.6, 1.3, ts) * (1 - smooth(2.4, 2.8, ts)) * 1.8;
    if (holding > 0 || attract > 0) {
      run("hold", velocity.write, (u, unit) => {
        markUniforms(u);
        gl!.uniform1i(u.uVelocity, unit(velocity.read, 0));
        gl!.uniform1f(u.damping, holding);
        gl!.uniform1f(u.attract, attract);
      }, sim);
      velocity.swap();
    }
    // The dot ignites.
    const dotOn = smooth(3.5, 3.7, ts) * (1 - smooth(3.85, 4.05, ts));
    if (dotOn > 0) {
      const x = markCenter[0] + (64 / 128) * markHeight / aspect, y = markCenter[1];
      splat(dye, x, y, [.5 * dotOn * .3, 1 * dotOn * .3, .82 * dotOn * .3], .00011);
    }

    core({ curl: 26, calm: .18 + 3.2 * smooth(2.7, 3.6, ts), dyeFade: .32 - .29 * smooth(2.8, 3.4, ts) });
  }

  // The fluid itself: swirl, incompressibility, then carry velocity and ink along.
  function core(p: { curl: number; calm: number; dyeFade: number }) {
    const sim = velocity.read.texel;
    run("curl", curlField, (u, unit) => { gl!.uniform1i(u.uVelocity, unit(velocity.read, 0)); }, sim);
    run("vorticity", velocity.write, (u, unit) => {
      gl!.uniform1i(u.uVelocity, unit(velocity.read, 0));
      gl!.uniform1i(u.uCurl, unit(curlField, 1));
      gl!.uniform1f(u.curl, p.curl);
      gl!.uniform1f(u.dt, STEP);
    }, sim);
    velocity.swap();
    run("divergence", divergence, (u, unit) => { gl!.uniform1i(u.uVelocity, unit(velocity.read, 0)); }, sim);
    run("clear", pressure.write, (u, unit) => { gl!.uniform1i(u.uTexture, unit(pressure.read, 0)); gl!.uniform1f(u.value, .8); }, sim);
    pressure.swap();
    for (let i = 0; i < 20; i++) {
      run("pressure", pressure.write, (u, unit) => {
        gl!.uniform1i(u.uPressure, unit(pressure.read, 0));
        gl!.uniform1i(u.uDivergence, unit(divergence, 1));
      }, sim);
      pressure.swap();
    }
    run("gradient", velocity.write, (u, unit) => {
      gl!.uniform1i(u.uPressure, unit(pressure.read, 0));
      gl!.uniform1i(u.uVelocity, unit(velocity.read, 1));
    }, sim);
    velocity.swap();
    run("advection", velocity.write, (u, unit) => {
      gl!.uniform1i(u.uVelocity, unit(velocity.read, 0));
      gl!.uniform1i(u.uSource, unit(velocity.read, 0));
      gl!.uniform1f(u.dt, STEP);
      gl!.uniform1f(u.dissipation, p.calm);
    }, sim);
    velocity.swap();
    run("advection", dye.write, (u, unit) => {
      gl!.uniform1i(u.uVelocity, unit(velocity.read, 0));
      gl!.uniform1i(u.uSource, unit(dye.read, 1));
      gl!.uniform1f(u.dt, STEP);
      gl!.uniform1f(u.dissipation, p.dyeFade);
    }, sim);
    dye.swap();
  }

  const dotX = markCenter[0] + (64 / 128) * markHeight / aspect, dotY = markCenter[1];
  let ripple = -1, fade = 0;
  function display() {
    run("display", null, (u, unit) => {
      gl!.uniform1i(u.uTexture, unit(dye.read, 0));
      gl!.uniform1f(u.ripple, ripple);
      gl!.uniform1f(u.fade, fade);
      gl!.uniform1f(u.aspectRatio, aspect);
      gl!.uniform2f(u.dotPoint, dotX, dotY);
    }, dye.read.texel);
  }

  let done = 0;
  function render(t: number) {
    const wanted = Math.floor(Math.min(t, INK_END) / STEP);
    // Normal playback keeps up a few steps a frame; a skip or a late start catches up at once.
    const budget = wanted - done > 30 ? wanted - done : 4;
    for (let n = 0; n < budget && done < wanted; n++) step(++done * STEP);
    display();
  }

  // ---- Live modes, after the opening.
  let mode: InkMode = "still";
  let modeStart = 0, modeSteps = 0;
  let seed = 11;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  function setMode(next: InkMode) {
    // Finish the opening first, so live modes start from the formed mark.
    if (done < Math.floor(INK_END / STEP)) render(INK_END);
    mode = next;
    modeStart = 0;
    modeSteps = 0;
    if (next !== "success") { ripple = -1; fade = 0; }
  }
  function gatherKeep(amount: number, clearing: number) {
    run("gather", dye.write, (u, unit) => {
      markUniforms(u);
      gl!.uniform1i(u.uTarget, unit(dye.read, 0));
      gl!.uniform1f(u.amount, amount);
      gl!.uniform1f(u.boost, 0);
      gl!.uniform1f(u.clearing, clearing);
      gl!.uniform3f(u.warm, WARM[0] * .75, WARM[1] * .75, WARM[2] * .75);
      gl!.uniform3f(u.mint, MINT[0] * .7, MINT[1] * .7, MINT[2] * .7);
    }, dye.read.texel);
    dye.swap();
  }
  function hold(damping: number) {
    run("hold", velocity.write, (u, unit) => {
      markUniforms(u);
      gl!.uniform1i(u.uVelocity, unit(velocity.read, 0));
      gl!.uniform1f(u.damping, damping);
      gl!.uniform1f(u.attract, 0);
    }, velocity.read.texel);
    velocity.swap();
  }
  function liveStep(lt: number) {
    if (mode === "simmer") {
      // Slow eddies inside the strokes, the shape held, the dot breathing.
      for (let i = 0; i < 2; i++) {
        const a = rand() * Math.PI * 2;
        const x = markCenter[0] + (rand() - .5) * markHeight * 1.1 / aspect;
        const y = markCenter[1] + (rand() - .5) * markHeight * 1.1;
        splat(velocity, x, y, [Math.cos(a) * 2.6, Math.sin(a) * 2.6, 0], .0005);
      }
      hold(.05);
      gatherKeep(.004, .01);
      const breath = .5 + .5 * Math.sin(lt * 2.6);
      splat(dye, dotX, dotY, [.5 * .022 * breath, .022 * breath, .82 * .022 * breath], .00011);
      core({ curl: 16, calm: 1.4, dyeFade: .035 });
      return true;
    }
    if (mode === "success") {
      // Signed in: the water is let go and the mark dissolves into soft smoke.
      ripple = -1;
      if (lt < .18) {
        // One gentle breath outward from the strokes.
        for (let i = 0; i < 10; i++) {
          const a = i / 10 * Math.PI * 2 + .3;
          const x = markCenter[0] + Math.cos(a) * markHeight * .36 / aspect;
          const y = markCenter[1] + Math.sin(a) * markHeight * .36;
          splat(velocity, x, y, [Math.cos(a) * 10, Math.sin(a) * 10, 0], .0026);
        }
      }
      if (lt < 1.2) {
        // Small turns everywhere in the mark, so it billows instead of just fading.
        for (let i = 0; i < 3; i++) {
          const a = rand() * Math.PI * 2;
          const x = markCenter[0] + (rand() - .5) * markHeight * 1.15 / aspect;
          const y = markCenter[1] + (rand() - .5) * markHeight * 1.15;
          splat(velocity, x, y, [Math.cos(a) * 6.5, Math.sin(a) * 6.5, 0], .0009);
        }
      }
      core({ curl: 34, calm: .45, dyeFade: .14 + .55 * smooth(.55, 1.6, lt) });
      return lt < 2.2;
    }
    if (mode === "stir") {
      // The visitor's hand: warm ink where the pointer passed. The mark holds and recovers.
      for (const s of stirs.splice(0)) {
        splat(velocity, s.x, s.y, [s.dx * 900, s.dy * 900, 0], .0006);
        splat(dye, s.x, s.y, [WARM[0] * .07, WARM[1] * .07, WARM[2] * .07], .0006);
      }
      hold(.08);
      gatherKeep(.006, .014);
      core({ curl: 22, calm: 1.1, dyeFade: .55 });
      return lt - lastStir < 2.4;
    }
    if (mode === "pulse") {
      // The agent answers: one ring from the dot, and mint ink streams toward the pressed button.
      ripple = Math.min(lt / 1.3, 1);
      if (lt < .42) {
        const dx = pulseTo[0] - dotX, dy = pulseTo[1] - dotY;
        const len = Math.hypot(dx * aspect, dy) || 1;
        splat(velocity, dotX, dotY, [dx * aspect / len * 34, dy / len * 34, 0], .0012);
        splat(dye, dotX, dotY, [MINT[0] * .08, MINT[1] * .08, MINT[2] * .08], .0007);
      }
      // The dot lights again once the stream has left it.
      if (lt > 1 && lt < 1.8) splat(dye, dotX, dotY, [.5 * .03, .03, .82 * .03], .00011);
      hold(.06);
      gatherKeep(.006, .016);
      core({ curl: 24, calm: .9, dyeFade: .4 });
      if (lt >= 2.6) ripple = -1;
      return lt < 2.6;
    }
    if (mode === "settle") {
      hold(.3);
      gatherKeep(.004, .02);
      core({ curl: 12, calm: 4, dyeFade: .03 });
      return lt < 1;
    }
    return false;
  }
  // Pointer trails, queued until the next live step.
  const stirs: Array<{ x: number; y: number; dx: number; dy: number }> = [];
  let lastStir = 0;
  let pulseTo: [number, number] = [.5, .2];
  function stir(x: number, y: number, dx: number, dy: number) {
    if (mode === "success") return;
    if (mode !== "stir") setMode("stir");
    stirs.push({ x, y, dx, dy });
    if (stirs.length > 8) stirs.shift();
    lastStir = modeStart ? (performance.now() - modeStart) / 1000 : 0;
  }
  function pulse(x: number, y: number) {
    if (mode === "success") return;
    pulseTo = [x, y];
    setMode("pulse");
  }
  function live(now: number) {
    if (mode === "still") return false;
    if (!modeStart) modeStart = now;
    const lt = (now - modeStart) / 1000;
    // Simmer runs at half rate: slow water, half the work.
    const rate = mode === "simmer" ? 30 : 60;
    const wanted = Math.floor(lt * rate);
    let going = true;
    for (let n = 0; n < 3 && modeSteps < wanted; n++) { modeSteps++; going = liveStep(modeSteps / rate); }
    display();
    if (!going) mode = "still";
    return going;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.min(devicePixelRatio || 1, options.light ? 1.5 : 2) * .75;
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));
  }
  resize();
  return { end: INK_END, render, resize, setMode, live, stir, pulse, dispose() { created.forEach(remove => remove()); } };
}
