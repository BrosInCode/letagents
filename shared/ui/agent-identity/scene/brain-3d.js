import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ICBM152 cortical surface, styled for agent setup. Attribution lives with the asset.
// The second hemisphere mirrors the first; the presentation is illustrative.
async function loadCortex() {
  const response = await fetch(new URL('./assets/brain/cortex-left.mz3', import.meta.url));
  if (!response.ok) throw new Error('Brain surface could not be loaded');
  const bytes = await response.arrayBuffer();
  const inflated = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const header = new DataView(inflated);
  if (header.getUint16(0, true) !== 23117 || header.getUint16(2, true) !== 3) throw new Error('Unexpected brain surface');
  const faces = header.getUint32(4, true), vertices = header.getUint32(8, true), offset = 16 + header.getUint32(12, true);
  const indices = new Uint32Array(inflated.slice(offset, offset + faces * 12));
  const source = new Float32Array(inflated, offset + faces * 12, vertices * 3);
  const points = new Float32Array(vertices * 3);
  for (let i = 0; i < vertices; i++) {
    points[i * 3] = source[i * 3] / 67;
    points[i * 3 + 1] = (source[i * 3 + 2] - 17) / 67;
    points[i * 3 + 2] = (source[i * 3 + 1] + 18) / 67;
  }
  // Swapping anatomical Y/Z reverses handedness.
  for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  // Soft local curvature shading keeps the sulci legible without a wireframe.
  const sums = new Float32Array(points.length), counts = new Uint16Array(vertices);
  for (let f = 0; f < indices.length; f += 3) {
    for (let j = 0; j < 3; j++) {
      const a = indices[f + j], b = indices[f + (j + 1) % 3];
      counts[a]++; counts[b]++;
      for (let k = 0; k < 3; k++) { sums[a * 3 + k] += points[b * 3 + k]; sums[b * 3 + k] += points[a * 3 + k]; }
    }
  }
  const normals = geometry.attributes.normal.array, colors = new Float32Array(points.length);
  for (let i = 0; i < vertices; i++) {
    let concavity = 0;
    for (let k = 0; k < 3; k++) concavity += (sums[i * 3 + k] / counts[i] - points[i * 3 + k]) * normals[i * 3 + k];
    const shade = 1 - THREE.MathUtils.clamp(concavity * 65, 0, .52);
    colors.set([shade, shade, shade], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  addNeuralNetwork(geometry);
  return geometry;
}

// Illustrative capability editions, not an anatomical or measured IQ model.
// Paths follow the real cortical mesh. Their distance fields are shaded into
// the material, so they sit in its folds rather than floating over the brain.
function addNeuralNetwork(geometry) {
  const p = geometry.attributes.position.array, faces = geometry.index.array;
  const count = p.length / 3, neighbors = Array.from({ length: count }, () => new Set());
  const distance = (a, b) => Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
  for (let f = 0; f < faces.length; f += 3) for (let j = 0; j < 3; j++) {
    const a = faces[f + j], b = faces[f + (j + 1) % 3];
    neighbors[a].add(b); neighbors[b].add(a);
  }
  const edges = neighbors.map((list, a) => [...list].map(b => [b, distance(a, b)]));
  function spread(sources, limit = Infinity) {
    const d = new Float32Array(count).fill(Infinity), previous = new Int32Array(count).fill(-1), heap = [];
    function push(vertex, cost) {
      let i = heap.length; heap.push([vertex, cost]);
      while (i) { const parent = (i - 1) >>> 1; if (heap[parent][1] <= cost) break; heap[i] = heap[parent]; i = parent; }
      heap[i] = [vertex, cost];
    }
    for (const source of sources) { d[source] = 0; push(source, 0); }
    while (heap.length) {
      const [a, cost] = heap[0], last = heap.pop();
      if (heap.length) {
        let i = 0;
        while (i * 2 + 1 < heap.length) {
          let child = i * 2 + 1;
          if (child + 1 < heap.length && heap[child + 1][1] < heap[child][1]) child++;
          if (heap[child][1] >= last[1]) break;
          heap[i] = heap[child]; i = child;
        }
        heap[i] = last;
      }
      if (cost > d[a] + .000001) continue;
      for (const [b, length] of edges[a]) {
        const next = cost + length;
        if (next >= d[b] || next > limit) continue;
        d[b] = next; previous[b] = a; push(b, next);
      }
    }
    return { d, previous };
  }
  // Evenly spread junctions over the external surface; no random layout jump
  // when moving between models. Higher editions extend the existing network.
  const candidates = [];
  for (let i = 0; i < count; i += 11) if (p[i * 3] < -.20 && p[i * 3 + 1] > -.85) candidates.push(i);
  const hubs = [candidates[Math.floor(candidates.length * .46)]];
  const nearest = new Float32Array(candidates.length).fill(Infinity);
  while (hubs.length < 56) {
    let farthest = 0;
    for (let i = 0; i < candidates.length; i++) {
      nearest[i] = Math.min(nearest[i], distance(candidates[i], hubs.at(-1)));
      if (nearest[i] > nearest[farthest]) farthest = i;
    }
    hubs.push(candidates[farthest]);
  }
  const trees = [hubs[0], hubs[2], hubs[5]].map(root => spread([root]).previous);
  const paths = new Float32Array(count * 4), nodes = new Float32Array(count * 4);
  for (let tier = 0; tier < 4; tier++) {
    const junctions = hubs.slice(0, [3, 10, 26, 56][tier]), route = new Set();
    for (let h = 1; h < junctions.length; h++) {
      // Extra cross-connections add depth in the advanced/frontier editions.
      const routes = tier === 3 && h % 2 === 0 ? trees
        : tier === 2 && h % 3 === 0 ? [trees[0], trees[1]] : [trees[0]];
      for (const tree of routes) {
        let point = junctions[h];
        while (point >= 0) { route.add(point); point = tree[point]; }
      }
    }
    const pathDistance = spread(route, .09).d, nodeDistance = spread(junctions, .09).d;
    for (let v = 0; v < count; v++) {
      paths[v * 4 + tier] = Math.min(pathDistance[v], .09);
      nodes[v * 4 + tier] = Math.min(nodeDistance[v], .09);
    }
  }
  geometry.setAttribute('neuralPaths', new THREE.BufferAttribute(paths, 4));
  geometry.setAttribute('neuralNodes', new THREE.BufferAttribute(nodes, 4));
}

export async function createBrainPreview(host, { onUnavailable }) {
  const corticalGeometry = await loadCortex();
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = .75;
  const canvas = renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  host.append(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-3, 3, 1.7, -1.7, .1, 30);
  camera.position.set(0, 2.3, 7);
  camera.lookAt(0, -.08, 0);
  const pmrem = new THREE.PMREMGenerator(renderer), room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, .06);
  scene.environment = environment.texture;
  scene.environmentIntensity = .3;
  room.dispose(); pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xfaf9f5, 0x282725, 1.0));
  const key = new THREE.DirectionalLight(0xfff6ee, 2.2);
  key.position.set(-3, 5, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0xffffff, 2.3);
  rim.position.set(4, 2, -3); scene.add(rim);
  const fill = new THREE.DirectionalLight(0xfaf9f5, .85);
  fill.position.set(3, 0, 4); scene.add(fill);
  const brain = new THREE.Group(); scene.add(brain);
  const cortex = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, roughness: .52, metalness: .08,
    clearcoat: .1, clearcoatRoughness: .6,
  });
  const geometries = [corticalGeometry];
  const left = new THREE.Mesh(corticalGeometry, cortex);
  const right = new THREE.Mesh(corticalGeometry, cortex);
  right.scale.x = -1;
  brain.add(left, right);

  // Project the marks into the cortex material. They inherit the actual folds,
  // lighting and silhouette; no badge mesh or flattened landing is needed.
  const textureLoader = new THREE.TextureLoader();
  const textures = [
    new URL('./assets/providers/openai-mark.svg', import.meta.url).href,
    new URL('./assets/providers/claude-mark.svg', import.meta.url).href,
    new URL('./assets/providers/cursor-mark.svg', import.meta.url).href,
  ].map(url => textureLoader.load(url, () => requestDraw()));

  // Full-surface edition paint. These original panel layouts use the official
  // palette, while the supplied provider marks retain their own proportions.
  const edition = {
    from: { value: 0 }, to: { value: 0 }, blend: { value: 0 },
    openai: { value: textures[0] }, claude: { value: textures[1] }, cursorMark: { value: textures[2] },
    ink: { value: new THREE.Color('#141413') }, ivory: { value: new THREE.Color('#faf9f5') },
    orange: { value: new THREE.Color('#d97757') }, cursor: { value: new THREE.Color('#1b1913') },
    chalk: { value: new THREE.Color('#edecec') }, gray: { value: new THREE.Color('#999999') },
  };
  // Steam is an illustrative effort cue, never a live model-activity reading.
  const steamState = { level: { value: 0 }, phase: { value: 0 }, cortexMatrix: { value: new THREE.Matrix4() } };
  const neural = {
    from: { value: new THREE.Vector4() }, to: { value: new THREE.Vector4() },
    progress: { value: 1 },
  };
  cortex.onBeforeCompile = shader => {
    for (const [key, uniform] of Object.entries(edition)) shader.uniforms['edition_' + key] = uniform;
    for (const [key, uniform] of Object.entries(neural)) shader.uniforms['neural_' + key] = uniform;
    shader.vertexShader = 'attribute vec4 neuralPaths, neuralNodes;\nvarying vec4 pathDistance, nodeDistance;\nvarying vec3 editionPoint;\nvarying float editionSide;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n pathDistance = neuralPaths; nodeDistance = neuralNodes;\n editionPoint = position;\n editionSide = step(dot(cross(modelMatrix[0].xyz, modelMatrix[1].xyz), modelMatrix[2].xyz), 0.);');
    shader.fragmentShader = `
      varying vec3 editionPoint;
      varying float editionSide;
      varying vec4 pathDistance, nodeDistance;
      uniform vec4 neural_from, neural_to;
      uniform float neural_progress;
      float neuralLight;
      vec3 neuralInk;
      uniform float edition_from, edition_to, edition_blend;
      uniform vec3 edition_ink, edition_ivory, edition_orange, edition_cursor, edition_chalk, edition_gray;
      uniform sampler2D edition_openai, edition_claude, edition_cursorMark;
      float markMask(vec3 p, float style) {
        // A three-quarter projection keeps the complete silhouette readable
        // at the resting angle, while its shading still follows every fold.
        vec2 surface = vec2(.62 * abs(p.x) - .78 * p.z,
          .95 * p.y - .31 * (.78 * abs(p.x) + .62 * p.z));
        vec2 center = style < .5 ? vec2(.16, .16) : style < 1.5 ? vec2(.16, .09) : vec2(.20, -.06);
        vec2 size = style < .5 ? vec2(.94) : style < 1.5 ? vec2(1.08) : vec2(.84 * 466.73 / 532.09, .84);
        vec2 uv = (surface - center) / size + .5;
        float inside = step(0., uv.x) * step(uv.x, 1.) * step(0., uv.y) * step(uv.y, 1.);
        float alpha = style < .5 ? texture2D(edition_openai, uv).a
          : style < 1.5 ? texture2D(edition_claude, uv).a
          : style < 2.5 ? texture2D(edition_cursorMark, uv).a : 0.;
        return alpha * inside * editionSide * smoothstep(.18, .38, abs(p.x));
      }
      vec3 editionPaint(vec3 p, float style) {
        vec3 paint;
        if (style < .5) {
          // Porcelain upper shell, graphite lower shell, a narrow silver seam.
          float line = p.y + .20 * p.z + .16;
          paint = mix(edition_ink, edition_ivory, smoothstep(-.025, .025, line));
          paint = mix(paint, edition_gray, 1. - smoothstep(.012, .026, abs(line - .08)));
        } else if (style < 1.5) {
          // Terracotta with an ivory ribbon sweeping around the whole cortex.
          float ribbon = p.y + .28 * p.z + .18 * p.z * p.z + .60;
          paint = mix(edition_orange, edition_ivory, 1. - smoothstep(.18, .205, abs(ribbon)));
          float pinstripe = 1. - smoothstep(.009, .020, abs(ribbon + .28));
          paint = mix(paint, edition_ink, pinstripe * .8);
        } else if (style < 2.5) {
          // Graphite and chalk in an angular, directional shoulder treatment.
          float chevron = p.y - .48 * abs(p.z - .18) + .12;
          paint = mix(edition_cursor, edition_chalk, smoothstep(.72, .75, chevron));
          paint = mix(paint, edition_chalk, (1. - smoothstep(.012, .027, abs(chevron - .60))) * .8);
        } else {
          float stripe = p.y + .15 * p.z;
          paint = mix(edition_gray, edition_ivory, 1. - smoothstep(.09, .115, abs(stripe + .27)));
        }
        vec3 markColor = style < .5 ? edition_ink : edition_chalk;
        return mix(paint, markColor, markMask(p, style));
      }
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float sweep = smoothstep(0., 1., clamp(edition_blend * 1.6 - (editionPoint.z + 1.5) * .2, 0., 1.));
      diffuseColor.rgb *= mix(editionPaint(editionPoint, edition_from), editionPaint(editionPoint, edition_to), sweep);
      float front = clamp((editionPoint.y + .55 * editionPoint.z + 1.7) / 3.4, 0., 1.);
      float reveal = smoothstep(0., 1., clamp(neural_progress * 2. - front, 0., 1.));
      vec4 weights = mix(neural_from, neural_to, reveal);
      // Distinct structures, legible at the normal preview size. Each tier
      // grows the same network, with wider channels and larger junctions.
      vec4 width = vec4(.003, .005, .008, .011);
      vec4 radius = vec4(.018, .024, .030, .036);
      vec4 traces = 1. - smoothstep(width, width + .003 + fwidth(pathDistance) * .5, pathDistance);
      vec4 channels = 1. - smoothstep(width + .006, width + .014, pathDistance);
      vec4 junctions = 1. - smoothstep(radius, radius + .005 + fwidth(nodeDistance) * .5, nodeDistance);
      vec4 sockets = 1. - smoothstep(radius + .006, radius + .014, nodeDistance);
      float mark = mix(markMask(editionPoint, edition_from), markMask(editionPoint, edition_to), sweep);
      float unmarked = 1. - mark;
      float trace = dot(traces, weights) * unmarked;
      float junction = dot(junctions, weights) * unmarked;
      float luminance = dot(diffuseColor.rgb, vec3(.2126, .7152, .0722));
      neuralInk = mix(vec3(.86, .91, .93), vec3(.055, .075, .085), smoothstep(.24, .60, luminance));
      float frame = max(dot(channels, weights), dot(sockets, weights)) * unmarked;
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.025, .035, .04), frame * .55);
      diffuseColor.rgb = mix(diffuseColor.rgb, neuralInk, clamp(trace * .95, 0., .95));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(.96, .97, .95), clamp(junction, 0., 1.));
      float traveling = pow(max(0., 1. - abs(neural_progress * 2. - front - .3) * 6.), 2.) * step(.001, neural_progress) * (1. - step(.999, neural_progress));
      neuralLight = trace * .12 * (1. - smoothstep(.32, .8, luminance)) + junction * .55
        + traveling * (trace + junction) * .8;
    `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += vec3(.86, .90, .92) * neuralLight;');
  };

  // Emit from area-weighted points on both actual cortical surfaces. Each
  // soft puff leaves its source, expands, rises, and dissolves in open space.
  const particleCount = 360;
  const positions = corticalGeometry.attributes.position;
  const normals = corticalGeometry.attributes.normal;
  const triangles = corticalGeometry.index.array;
  const areas = new Float32Array(triangles.length / 3);
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const edge = new THREE.Vector3(), cross = new THREE.Vector3();
  let totalArea = 0, randomState = 1847;
  const random = () => {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    return randomState / 4294967296;
  };
  for (let face = 0; face < areas.length; face++) {
    a.fromBufferAttribute(positions, triangles[face * 3]);
    b.fromBufferAttribute(positions, triangles[face * 3 + 1]);
    c.fromBufferAttribute(positions, triangles[face * 3 + 2]);
    totalArea += cross.subVectors(b, a).cross(edge.subVectors(c, a)).length() * .5;
    areas[face] = totalArea;
  }
  const sources = new Float32Array(particleCount * 3);
  const directions = new Float32Array(particleCount * 3);
  const seeds = new Float32Array(particleCount * 4);
  for (let i = 0; i < particleCount; i++) {
    const area = random() * totalArea;
    let lo = 0, hi = areas.length - 1;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (areas[mid] < area) lo = mid + 1; else hi = mid; }
    const root = Math.sqrt(random()), v = random();
    const weights = [1 - root, root * (1 - v), root * v];
    a.set(0, 0, 0); b.set(0, 0, 0);
    for (let j = 0; j < 3; j++) {
      const vertex = triangles[lo * 3 + j];
      a.addScaledVector(c.fromBufferAttribute(positions, vertex), weights[j]);
      b.addScaledVector(c.fromBufferAttribute(normals, vertex), weights[j]);
    }
    if (i % 2) { a.x *= -1; b.x *= -1; }
    a.toArray(sources, i * 3); b.normalize().toArray(directions, i * 3);
    seeds.set([random(), random(), random(), random()], i * 4);
  }
  const quad = new THREE.PlaneGeometry(1, 1);
  const steamGeometry = new THREE.InstancedBufferGeometry().copy(quad);
  quad.dispose();
  steamGeometry.instanceCount = particleCount;
  steamGeometry.setAttribute('sourcePoint', new THREE.InstancedBufferAttribute(sources, 3));
  steamGeometry.setAttribute('sourceNormal', new THREE.InstancedBufferAttribute(directions, 3));
  steamGeometry.setAttribute('seed', new THREE.InstancedBufferAttribute(seeds, 4));
  geometries.push(steamGeometry);
  const steamMaterial = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: steamState,
    vertexShader: `
      uniform float level, phase;
      uniform mat4 cortexMatrix;
      attribute vec3 sourcePoint, sourceNormal;
      attribute vec4 seed;
      varying vec2 steamUV;
      varying float lifeOpacity, noiseSeed, vapourAge, viewHeight;
      void main() {
        float age = fract(seed.x + phase * (.22 + seed.y * .08));
        vec3 origin = (cortexMatrix * vec4(sourcePoint, 1.)).xyz;
        vec3 surfaceNormal = normalize(mat3(cortexMatrix) * sourceNormal);
        vec3 radial = normalize(mat3(cortexMatrix) * sourcePoint);
        vec3 outward = normalize(mix(surfaceNormal, radial, .65));
        // A small outward release clears the folds before buoyancy takes over.
        vec3 center = origin + outward * (.025 + age * (.18 + level * .18));
        center.y += pow(age, 1.35) * (.65 + level * .72);
        center.x += sin(age * 5. + seed.z * 6.28) * age * .17;
        center.z += cos(age * 4. + seed.w * 6.28) * age * .12;
        float size = (.13 + pow(age, .8) * (.30 + level * .24)) * (.8 + seed.z * .4);
        vec4 viewCenter = viewMatrix * vec4(center, 1.);
        viewCenter.xy += position.xy * size * vec2(1., 1.25);
        gl_Position = projectionMatrix * viewCenter;
        steamUV = uv;
        vapourAge = age;
        noiseSeed = seed.z * 35.;
        viewHeight = viewCenter.y;
        float recruited = 1. - smoothstep(.16 + level * .82, .18 + level * .82, seed.w);
        lifeOpacity = smoothstep(0., .12, age) * (1. - smoothstep(.48, 1., age))
          * recruited * smoothstep(0., .10, level);
      }
    `,
    fragmentShader: `
      uniform float level;
      varying vec2 steamUV;
      varying float lifeOpacity, noiseSeed, vapourAge, viewHeight;
      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3. - 2. * f);
        return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x),
          mix(hash(i + vec2(0., 1.)), hash(i + 1.), f.x), f.y);
      }
      float mist(vec2 p) {
        mat2 turn = mat2(.8, -.6, .6, .8);
        float sum = 0., weight = .55;
        for (int octave = 0; octave < 3; octave++) {
          sum += noise(p) * weight;
          p = turn * p * 2.03 + vec2(7.3, 19.1);
          weight *= .48;
        }
        return sum;
      }
      void main() {
        vec2 p = steamUV * 2. - 1.;
        vec2 flow = p * 2.2 + vec2(noiseSeed, -vapourAge * 1.8);
        vec2 curl = vec2(mist(flow), mist(flow + 8.7)) - .48;
        float cloud = mist(flow + curl * 1.8);
        float edge = length(p + curl * .28);
        float feather = 1. - smoothstep(.18, .95, edge);
        float texture = smoothstep(.18, .72, cloud);
        float dissolve = 1. - smoothstep(1.12, 1.50, viewHeight);
        float alpha = feather * texture * lifeOpacity * dissolve * (.24 + level * .34);
        gl_FragColor = vec4(vec3(.83, .86, .87), alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const steam = new THREE.Mesh(steamGeometry, steamMaterial);
  // Vertex positions are displaced from cortical source points on the GPU.
  steam.frustumCulled = false;
  scene.add(steam);
  const palettes = [
    { rim: '#ffffff', metalness: .08 },
    { rim: '#faf9f5', metalness: .04 },
    { rim: '#edecec', metalness: .12 },
    { rim: '#ffffff', metalness: .08 },
  ].map(palette => ({ ...palette, rim: new THREE.Color(palette.rim) }));
  let position = 0, active = false, animate = true, frame = 0, last = 0, time = 0, disposed = false, failed = false;
  let lookX = 0, lookY = 0, yaw = 0, pitch = 0;
  let effortTarget = 0;
  let capability = null;
  const shapeWeights = new THREE.Vector4();
  function paint() {
    const value = THREE.MathUtils.clamp(position, 0, palettes.length - 1);
    const index = Math.floor(value), blend = value - index;
    const from = palettes[index], to = palettes[Math.min(index + 1, palettes.length - 1)];
    edition.from.value = index; edition.to.value = Math.min(index + 1, palettes.length - 1); edition.blend.value = blend;
    rim.color.copy(from.rim).lerp(to.rim, blend);
    cortex.metalness = THREE.MathUtils.lerp(from.metalness, to.metalness, blend);
  }
  function pose(dt) {
    const follow = animate ? 1 - Math.exp(-8 * dt) : 1;
    yaw += ((animate ? lookX * .18 : 0) - yaw) * follow;
    pitch += ((animate ? lookY * .08 : 0) - pitch) * follow;
    const modelTurn = animate ? Math.sin(neural.progress.value * Math.PI) * .24 : 0;
    brain.rotation.set(.04 + pitch, -.98 + position * .07 + yaw + modelTurn + (animate ? Math.sin(time * .38) * .035 : 0), -.06);
    shapeWeights.lerpVectors(neural.from.value, neural.to.value, THREE.MathUtils.smoothstep(neural.progress.value, 0, 1));
    // A persistent silhouette cue still reads with motion off. Unclassified
    // providers retain their original size and receive no tier treatment.
    const size = 1.04 + shapeWeights.x * -.26 + shapeWeights.y * -.11
      + shapeWeights.z * .04 + shapeWeights.w * .14;
    brain.scale.setScalar(size);
    brain.position.y = .02 + shapeWeights.w * .04 + (animate ? Math.sin(time * 1.15) * .016 : 0);
  }
  function tick(now) {
    frame = 0;
    if (!active || disposed || failed || document.hidden) return;
    const dt = last ? Math.min((now - last) / 1000, .035) : 1 / 60; last = now;
    if (animate) time += dt;
    neural.progress.value = animate ? Math.min(1, neural.progress.value + dt / .95) : 1;
    steamState.level.value += (effortTarget - steamState.level.value) * (animate ? 1 - Math.exp(-7 * dt) : 1);
    steamState.phase.value += animate ? dt * (.24 + steamState.level.value * .9) : 0;
    pose(dt);
    brain.updateMatrixWorld(); steamState.cortexMatrix.value.copy(brain.matrixWorld);
    renderer.render(scene, camera);
    if (animate) frame = requestAnimationFrame(tick);
  }
  function requestDraw() { if (!frame && active && !disposed && !failed && !document.hidden) frame = requestAnimationFrame(tick); }
  function resize() {
    if (!host.clientWidth || !host.clientHeight) return;
    renderer.setSize(host.clientWidth, host.clientHeight, false);
    const halfHeight = 1.6, aspect = host.clientWidth / host.clientHeight;
    camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect;
    camera.top = halfHeight; camera.bottom = -halfHeight;
    camera.updateProjectionMatrix(); requestDraw();
  }
  const observer = new ResizeObserver(resize); observer.observe(host);
  const visibility = () => { last = 0; if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else requestDraw(); };
  document.addEventListener('visibilitychange', visibility);
  const pointerMove = event => {
    if (event.pointerType !== 'mouse' || event.buttons || !animate) return;
    const rect = host.getBoundingClientRect();
    lookX = (event.clientX - rect.left) / rect.width * 2 - 1;
    lookY = (event.clientY - rect.top) / rect.height * 2 - 1;
  };
  const pointerLeave = () => { lookX = lookY = 0; };
  host.parentElement.addEventListener('pointermove', pointerMove);
  host.parentElement.addEventListener('pointerleave', pointerLeave);
  canvas.addEventListener('webglcontextlost', event => {
    if (disposed) return;
    event.preventDefault(); failed = true; cancelAnimationFrame(frame); frame = 0; onUnavailable();
  });
  paint(); resize();
  return {
    setSelection(value) { position = value; paint(); requestDraw(); },
    setCapability(tier, { immediate = false } = {}) {
      if (tier === capability) return;
      capability = tier;
      // Preserve the current blend if the person changes their mind mid-turn.
      neural.from.value.lerpVectors(neural.from.value, neural.to.value, THREE.MathUtils.smoothstep(neural.progress.value, 0, 1));
      neural.to.value.set(0, 0, 0, 0);
      if (Number.isInteger(tier) && tier >= 0 && tier < 4) neural.to.value.setComponent(tier, 1);
      neural.progress.value = immediate || !animate || !active ? 1 : 0;
      if (neural.progress.value === 1) neural.from.value.copy(neural.to.value);
      host.dataset.capability = tier === null ? 'unrated' : String(tier);
      requestDraw();
    },
    setEffort(value, { immediate = false } = {}) {
      const next = ({ low: 0, medium: .30, high: .60, xhigh: .82, max: 1, ultra: 1.15 })[value] ?? 0;
      effortTarget = next;
      steam.visible = next > 0;
      if (next === 0 || immediate || !animate || !active) steamState.level.value = effortTarget;
      requestDraw();
    },
    setState(state) {
      active = state.active; animate = state.animate;
      host.dataset.motion = animate ? 'on' : 'off';
      if (!active) { cancelAnimationFrame(frame); frame = 0; last = 0; }
      else requestDraw();
    },
    dispose() {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      host.parentElement.removeEventListener('pointermove', pointerMove);
      host.parentElement.removeEventListener('pointerleave', pointerLeave);
      geometries.forEach(geometry => geometry.dispose());
      cortex.dispose(); steamMaterial.dispose(); textures.forEach(texture => texture.dispose()); environment.dispose(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
    },
  };
}
