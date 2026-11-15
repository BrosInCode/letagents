import * as THREE from 'three';
import { createAvatarModel } from './avatar-models.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// One live renderer for the whole collection. All picker and roster portraits
// are snapshots of the same models, cached by character and finish.
export function createAvatarPreview(host, { character, characterNames, palette, onPortrait = () => {}, onUnavailable = () => {} }) {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Orbit, interactive 3D character. Drag or use arrow keys to turn. Click or press Enter to wave. Press Home to reset.');
  host.append(canvas);
  const hint = document.createElement('span');
  hint.className = 'avatar-hint';
  hint.textContent = 'Drag to turn · Click to wave';
  hint.setAttribute('aria-hidden', 'true');
  host.append(hint);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-3, 3, 1.9, -1.9, .1, 30);
  camera.position.set(0, 2.9, 8);
  camera.lookAt(0, 1.55, 0);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, .045);
  scene.environment = environment.texture;
  scene.environmentIntensity = .7;
  room.dispose();
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xcce7dd, 0x1b2523, 1.1));
  const key = new THREE.DirectionalLight(0xfff6e9, 2.5);
  key.position.set(-3, 6, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -3, right: 3, top: 4, bottom: -3, near: .1, far: 15 });
  key.shadow.normalBias = .025;
  key.shadow.bias = -.0001;
  key.shadow.radius = 4;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xa8d7cc, 2.5);
  rim.position.set(4, 4, -4);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xb9d2ed, .6);
  fill.position.set(4, 1, 4);
  scene.add(fill);

  function createMaterials(finish) {
    const material = (color, roughness = .45, metalness = .1) => new THREE.MeshPhysicalMaterial({ color, roughness, metalness, clearcoat: .25, clearcoatRoughness: .3 });
    const shell = material(finish.shell, .37, .16);
    const pale = material(finish.pale, .39, .1);
    const joint = material(finish.joint, .62, .18);
    const rubber = material(finish.rubber, .8, .02);
    const trim = material(finish.trim, .33, .3);
    const glass = material(finish.glass, .18, .24);
    glass.clearcoat = 1; glass.clearcoatRoughness = .14;
    const light = new THREE.MeshStandardMaterial({ color: finish.light, emissive: finish.emissive, emissiveIntensity: .75, roughness: .3 });
    return { shell, pale, joint, rubber, trim, glass, light };
  }
  const models = new Map();
  const arrivals = new Map();
  let robot, rig, head, antenna, arms, eyes, stage, materials;
  function activate(id) {
    if (stage) scene.remove(stage);
    if (!models.has(id)) {
      const ownMaterials = createMaterials(palette);
      const model = createAvatarModel(id, ownMaterials);
      model.stage = new THREE.Group();
      model.stage.add(model.robot);
      model.materials = ownMaterials;
      models.set(id, model);
    }
    ({ robot, rig, head, antenna, arms, eyes, stage, materials } = models.get(id));
    character = id;
    scene.add(stage);
  }
  function applyPalette(next) {
    palette = next;
    for (const name of ['shell', 'pale', 'joint', 'rubber', 'trim', 'glass']) materials[name].color.set(next[name]);
    materials.light.color.set(next.light);
    materials.light.emissive.set(next.emissive);
  }
  function opacity(model, value) {
    for (const mat of Object.values(model.materials)) {
      const transparent = value < .999;
      if (mat.transparent !== transparent) { mat.transparent = transparent; mat.needsUpdate = true; }
      mat.opacity = value;
    }
  }
  function rest(model) {
    model.stage.position.set(0, 0, 0);
    model.stage.rotation.set(0, 0, 0);
    model.stage.scale.setScalar(1);
    opacity(model, 1);
  }
  function settleArrival() {
    for (const [id] of arrivals) {
      const model = models.get(id);
      if (id !== character) scene.remove(model.stage);
      rest(model);
    }
    arrivals.clear();
    rest(models.get(character));
  }
  function beginArrival(previous, direction) {
    const leaving = arrivals.get(previous) || { x: 0, velocity: 0, target: 0 };
    leaving.target = -direction * 3.6;
    arrivals.set(previous, leaving);
    if (!arrivals.has(character)) arrivals.set(character, { x: direction * 3.6, velocity: 0, target: 0 });
    arrivals.get(character).target = 0;
    for (const [id] of arrivals) scene.add(models.get(id).stage);
    updateArrivals(0);
  }
  function updateArrivals(dt) {
    // Each character keeps its on-screen position and velocity when redirected.
    // A quick reversal brings the departing character back from where it is.
    for (const [id, movement] of arrivals) {
      const model = models.get(id);
      for (let left = dt; left > 0;) {
        const step = Math.min(left, 1 / 120); left -= step;
        movement.velocity += ((movement.target - movement.x) * 225 - movement.velocity * 28) * step;
        movement.x += movement.velocity * step;
      }
      const distance = Math.abs(movement.x);
      model.stage.position.set(movement.x, 0, -distance * .32);
      model.stage.rotation.y = movement.x * .26;
      model.stage.scale.setScalar(1 - Math.min(distance, 3.6) * .075);
      opacity(model, 1 - THREE.MathUtils.smoothstep(distance, .35, 3.6));
      if (Math.abs(movement.x - movement.target) < .005 && Math.abs(movement.velocity) < .035) {
        if (id !== character) scene.remove(model.stage);
        rest(model); arrivals.delete(id);
      }
    }
  }
  activate(character);
  const mesh = (parent, geometry, mat, xyz) => {
    const object = new THREE.Mesh(geometry, mat);
    object.position.set(...xyz); object.receiveShadow = true; parent.add(object); return object;
  };

  const ground = mesh(scene, new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: .1 }), [0, .014, 0]);
  ground.rotation.x = -Math.PI / 2;
  ground.castShadow = false;
  const contactCanvas = document.createElement('canvas');
  contactCanvas.width = contactCanvas.height = 128;
  const ctx = contactCanvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 5, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(0,0,0,.38)');
  gradient.addColorStop(.4, 'rgba(0,0,0,.22)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const contactTexture = new THREE.CanvasTexture(contactCanvas);
  const contact = mesh(scene, new THREE.PlaneGeometry(2.7, 2), new THREE.MeshBasicMaterial({ map: contactTexture, transparent: true, depthWrite: false }), [0, .018, 0]);
  contact.rotation.x = -Math.PI / 2;
  contact.castShadow = false;

  let enabled = false, moving = true, disposed = false, frame = 0, last = 0, elapsed = 0;
  let yaw = -.32, targetYaw = -.32, pitch = 0, targetPitch = 0, lookX = 0, lookY = 0;
  let dragging = false, pointerId = null, pointerX = 0, pointerY = 0, travel = 0;
  let waveTime = -10, lastBlink = -5, nextBlink = 2.4;
  function pose(time, dt = 0, instant = false) {
    const follow = instant ? 1 : 1 - Math.exp(-12 * dt);
    yaw += (targetYaw - yaw) * follow;
    pitch += (targetPitch - pitch) * follow;
    robot.rotation.set(pitch, yaw, 0);
    const idle = moving ? Math.sin(time * 1.8) : 0;
    rig.position.y = moving ? (idle + 1) * .012 : 0;
    head.rotation.x += ((moving ? lookY * .12 : 0) - head.rotation.x) * follow;
    head.rotation.y += ((moving ? lookX * .19 : 0) - head.rotation.y) * follow;
    head.rotation.z = moving ? Math.sin(time * .7) * .025 : 0;
    antenna.rotation.z = moving ? Math.sin(time * 1.8 - .3) * .035 : 0;
    arms[0].rotation.z = -.14 + idle * .035;
    const wave = time - waveTime;
    const envelope = moving && wave >= 0 && wave < 2.1 ? Math.sin(Math.PI * wave / 2.1) ** .5 : 0;
    arms[1].rotation.z = .14 + idle * .035 + envelope * (2.25 + Math.sin(wave * 13) * .19);
    arms[1].rotation.x = envelope * -.25;
    if (moving && time > nextBlink) { lastBlink = time; nextBlink = time + 3.6 + Math.random() * 2.8; }
    const blink = time - lastBlink;
    const eyeScale = moving && blink >= 0 && blink < .17 ? Math.max(.09, 1 - Math.sin(blink / .17 * Math.PI)) : 1;
    eyes.forEach(eye => eye.scale.y = eyeScale);
  }
  function draw() { renderer.render(scene, camera); }
  function tick(now) {
    frame = 0;
    if (!enabled || disposed || document.hidden) return;
    const dt = last ? Math.min((now - last) / 1000, .035) : 1 / 60;
    last = now;
    if (moving) elapsed += dt;
    pose(elapsed, dt, !moving);
    updateArrivals(dt);
    draw();
    if (moving || arrivals.size || Math.abs(yaw - targetYaw) > .0005 || Math.abs(pitch - targetPitch) > .0005) frame = requestAnimationFrame(tick);
  }
  function requestDraw() {
    if (!frame && enabled && !disposed && !document.hidden) frame = requestAnimationFrame(tick);
  }
  function resize() {
    const width = host.clientWidth, height = host.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    const halfHeight = 1.73;
    camera.left = -halfHeight * width / height;
    camera.right = halfHeight * width / height;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
    requestDraw();
  }
  // Capture each finish once, without changing the live pose or making another renderer.
  const portraitCamera = camera.clone();
  Object.assign(portraitCamera, { left: -1.82, right: 1.82, top: 1.82, bottom: -1.82 });
  portraitCamera.updateProjectionMatrix();
  const capturedFinishes = new Set();
  function capturePortrait(id) {
    const size = renderer.getSize(new THREE.Vector2());
    const parts = [stage, robot, rig, head, antenna, ...arms, ...eyes];
    const saved = parts.map(part => ({ position: part.position.clone(), quaternion: part.quaternion.clone(), scale: part.scale.clone() }));
    const groundVisible = ground.visible, contactVisible = contact.visible;
    const others = [...models.values()].filter(model => model.stage !== stage).map(model => [model.stage, model.stage.visible]);
    const savedMaterials = Object.values(materials).map(mat => [mat, mat.opacity, mat.transparent]);
    try {
      renderer.setSize(96, 96, false);
      others.forEach(([other]) => { other.visible = false; });
      rest(models.get(character));
      robot.rotation.set(0, -.32, 0);
      rig.position.y = .012;
      head.rotation.set(0, 0, 0);
      antenna.rotation.set(0, 0, 0);
      arms[0].rotation.set(0, 0, -.14);
      arms[1].rotation.set(0, 0, .14);
      eyes.forEach(eye => { eye.scale.y = 1; });
      ground.visible = contact.visible = false;
      renderer.render(scene, portraitCamera);
      onPortrait(canvas.toDataURL('image/png'), character, id);
      capturedFinishes.add(`${character}/${id}`);
    } finally {
      parts.forEach((part, i) => {
        part.position.copy(saved[i].position);
        part.quaternion.copy(saved[i].quaternion);
        part.scale.copy(saved[i].scale);
      });
      others.forEach(([other, visible]) => { other.visible = visible; });
      savedMaterials.forEach(([mat, alpha, transparent]) => { mat.opacity = alpha; mat.transparent = transparent; mat.needsUpdate = true; });
      ground.visible = groundVisible; contact.visible = contactVisible;
      renderer.setSize(size.x, size.y, false);
      if (enabled) draw();
    }
  }
  pose(0, 0, true);
  capturePortrait(palette.id);

  function wave() {
    if (!moving) return;
    waveTime = elapsed;
    requestDraw();
  }
  const onPointerDown = e => {
    if (e.button !== 0 || pointerId !== null) return;
    pointerId = e.pointerId; dragging = true; travel = 0;
    pointerX = e.clientX; pointerY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('is-dragging');
    canvas.focus({ preventScroll: true });
  };
  const onPointerMove = e => {
    if (dragging && e.pointerId === pointerId) {
      const dx = e.clientX - pointerX, dy = e.clientY - pointerY;
      travel += Math.abs(dx) + Math.abs(dy);
      targetYaw += dx * .014;
      targetPitch = THREE.MathUtils.clamp(targetPitch + dy * .005, -.28, .24);
      pointerX = e.clientX; pointerY = e.clientY;
      requestDraw();
    } else if (moving && e.pointerType === 'mouse') {
      const rect = canvas.getBoundingClientRect();
      lookX = (e.clientX - rect.left) / rect.width * 2 - 1;
      lookY = (e.clientY - rect.top) / rect.height * 2 - 1;
    }
  };
  const endPointer = e => {
    if (e.pointerId !== pointerId) return;
    if (e.type === 'pointerup' && travel < 5) wave();
    dragging = false; pointerId = null;
    canvas.classList.remove('is-dragging');
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('lostpointercapture', endPointer);
  canvas.addEventListener('pointerleave', () => { lookX = lookY = 0; });
  canvas.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Home') { targetYaw = -.32; targetPitch = 0; }
    if (e.key === 'ArrowLeft') targetYaw -= .3;
    if (e.key === 'ArrowRight') targetYaw += .3;
    if (e.key === 'ArrowUp') targetPitch = Math.max(-.28, targetPitch - .1);
    if (e.key === 'ArrowDown') targetPitch = Math.min(.24, targetPitch + .1);
    if (e.key === 'Enter' || e.key === ' ') wave();
    pose(elapsed, 0, true);
    draw();
  });
  const visibility = () => { last = 0; if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else requestDraw(); };
  document.addEventListener('visibilitychange', visibility);
  canvas.addEventListener('webglcontextlost', e => {
    if (disposed) return;
    e.preventDefault();
    enabled = false;
    cancelAnimationFrame(frame);
    frame = 0;
    onUnavailable();
  });
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  return {
    captureFrame() {
      if (disposed) return null;
      settleArrival();
      const groundVisible = ground.visible, contactVisible = contact.visible;
      try {
        ground.visible = contact.visible = false;
        draw();
        return canvas.toDataURL('image/png');
      } finally {
        ground.visible = groundVisible; contact.visible = contactVisible;
      }
    },
    setCharacter(id, next, { animate = false, direction = 1 } = {}) {
      if (disposed) return;
      const previous = character, changed = id !== character;
      if (changed) {
        activate(id);
        yaw = targetYaw = -.32; pitch = targetPitch = lookX = lookY = 0;
        waveTime = -10; lastBlink = -5; nextBlink = elapsed + 2.4;
        pose(elapsed, 0, true);
      }
      // Models keep separate finishes during their shared on-screen handoff.
      if (changed || next.id !== palette.id) applyPalette(next);
      if (!capturedFinishes.has(`${character}/${palette.id}`)) capturePortrait(palette.id);
      if (changed) {
        if (animate && enabled && moving) beginArrival(previous, direction);
        else settleArrival();
        requestDraw();
      }
    },
    setPalette(next) {
      if (disposed || next.id === palette.id) return;
      applyPalette(next);
      if (!capturedFinishes.has(`${character}/${next.id}`)) capturePortrait(next.id);
      requestDraw();
    },
    async primePortraits(entries) {
      // Work a character at a time. Never keep another canvas or renderer alive.
      for (const [id, finish] of entries) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (disposed) return;
        if (capturedFinishes.has(`${id}/${finish.id}`)) continue;
        const original = character, originalPalette = palette;
        try {
          activate(id); applyPalette(finish); capturePortrait(finish.id);
        } finally {
          activate(original); applyPalette(originalPalette);
          if (enabled) draw();
        }
      }
    },
    setState({ active, animate }) {
      const wasActive = enabled;
      enabled = active;
      moving = animate;
      if (!active || !animate) settleArrival();
      host.hidden = !active;
      hint.textContent = moving ? 'Drag to turn · Click to wave' : 'Drag to turn';
      canvas.setAttribute('aria-label', `${characterNames[character]}, interactive 3D character. Drag or use arrow keys to turn. ${moving ? 'Click or press Enter to wave. ' : ''}Press Home to reset.`);
      if (!enabled) { cancelAnimationFrame(frame); frame = 0; last = 0; }
      else { if (!wasActive) { targetYaw = -.32; targetPitch = 0; last = 0; } resize(); requestDraw(); }
      if (!moving) { waveTime = -10; lookX = lookY = 0; }
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      const geometries = new Set(), materials = new Set();
      for (const root of [scene, ...[...models.values()].map(model => model.stage)]) root.traverse(obj => { if (obj.geometry) geometries.add(obj.geometry); if (obj.material) materials.add(obj.material); });
      geometries.forEach(g => g.dispose());
      materials.forEach(m => m.dispose());
      contactTexture.dispose(); environment.dispose(); renderer.dispose(); renderer.forceContextLoss(); host.replaceChildren();
    }
  };
}
