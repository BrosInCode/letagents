// The first-launch sculpture, with the room formation and exchange shared by the landing hero.
const tau = Math.PI * 2;
const arrivalDuration = 1.7;
const roomReady = 2.65;
const exchangeDuration = 10.8;
const amber = '#f5d9a7';
const agentLight = '#93f0cf';

export const handoffStillTime = roomReady + 6.8;

export function createHandoffPainter(paint) {
  let seed = 81931;
  function noise() {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  }

  function mix(from, to, value) {
    return from + (to - from) * value;
  }

  function clamp(value, low = 0, high = 1) {
    return Math.min(high, Math.max(low, value));
  }

  function ease(value) {
    return 1 - (1 - clamp(value)) ** 3.4;
  }

  function smooth(value) {
    const x = clamp(value);
    return x * x * (3 - 2 * x);
  }

  function roomEdge(angle, level) {
    const x = Math.cos(angle);
    const z = Math.sin(angle);
    const radius = 1 + .055 * Math.sin(angle * 3 + level * 4);
    return {
      x: Math.sign(x) * Math.abs(x) ** .52 * radius,
      z: Math.sign(z) * Math.abs(z) ** .52 * radius * .85,
      y: level,
    };
  }

  // Only the projection changes from frame to frame. Keep the room mesh in model space.
  function edgePoints(level, start, end) {
    return Array.from({ length: 73 }, (_, step) => roomEdge(mix(start, end, step / 72), level));
  }
  const first = -3.94;
  const last = -.30;
  const floorLines = Array.from({ length: 5 }, (_, band) => edgePoints(-band * .028, 0, tau));
  const wallRows = Array.from({ length: 25 }, (_, row) => edgePoints(row / 24 * .96, first, last));
  const wallColumns = Array.from({ length: 58 }, (_, column) => {
    const angle = mix(first, last, column / 57);
    return Array.from({ length: 21 }, (_, step) => roomEdge(angle, step / 20 * .96));
  });
  const wallBaseReversed = [...wallRows[0]].reverse();

  function generatePoints() {
    const particles = [];
    const count = 176;
    for (let strand = 0; strand < 22; strand++) {
      const offset = noise() * .045;
      for (let step = 0; step < count; step++) {
        const u = (step + noise() * .53) / count * tau + offset;
        const variation = noise();
        const floor = strand < 5;
        const level = floor ? -.11 + strand * .024 : (strand - 5) / 16 * .96;
        const roomAngle = floor ? u : -3.94 + u / tau * 3.64;
        const roomPoint = roomEdge(roomAngle, level);
        particles.push({
          u,
          strand,
          variation,
          delay: variation * .4 + Math.sin(u) ** 2 * .22,
          drift: noise(),
          exitY: noise() - .5,
          roomPoint,
        });
      }
    }
    return particles;
  }
  const points = generatePoints();


  function drawOrbit(cx, cy, size, opacity) {
    if (opacity < .01) return;
    paint.save();
    paint.translate(cx, cy);
    paint.rotate(-.24);
    paint.strokeStyle = ('rgba(161,226,199,0.12)');
    paint.globalAlpha = opacity;
    paint.lineWidth = .7;
    paint.beginPath();
    paint.ellipse(0, 0, size * 1.42, size * .44, 0, .07, 2.74);
    paint.stroke();
    paint.strokeStyle = 'rgba(206,214,194,0.08)';
    paint.beginPath();
    paint.ellipse(0, 0, size * 1.49, size * .4, 0, 3.09, 5.99);
    paint.stroke();
    paint.restore();
  }

  // Layer a small translucent core under the point field. Angular harmonics keep
  // its silhouette connected while the surface folds change with the same motion.
  function drawCore(cx, cy, r, t, opacity) {
    if (opacity < .015 || r < 1) return;
    paint.save();
    paint.translate(cx, cy);
    paint.rotate(-.31);
    paint.globalAlpha = opacity;

    paint.beginPath();
    for (let i = 0; i <= 100; i++) {
      const a = i / 100 * tau;
      const wave = 1 + .13 * Math.sin(3 * a + t * .82) + .08 * Math.cos(5 * a - t * .61);
      const x = Math.cos(a) * r * wave;
      const y = Math.sin(a) * r * wave * .88;
      if (i === 0) paint.moveTo(x, y);
      else paint.lineTo(x, y);
    }
    paint.closePath();

    const edge = paint.createLinearGradient(-r, .3 * r, r, -.55 * r);
    edge.addColorStop(0, '#ddd5bca6');
    edge.addColorStop(.34, '#789f8b57');
    edge.addColorStop(.58, '#204d3c83');
    edge.addColorStop(1, '#88e4c1ba');
    paint.fillStyle = '#11251c87';
    paint.fill();
    paint.strokeStyle = edge;
    paint.lineWidth = .9;
    paint.shadowColor = '#76dab985';
    paint.shadowBlur = 19;
    paint.stroke();
    paint.shadowBlur = 0;
    paint.clip();

    const glow = paint.createRadialGradient(-r * .42, -r * .58, r * .04, -r * .21, -r * .43, r * 1.4);
    glow.addColorStop(0, '#c5d7ae51');
    glow.addColorStop(.38, '#325b4550');
    glow.addColorStop(.72, '#14291e22');
    glow.addColorStop(1, '#07100b75');
    paint.fillStyle = glow;
    paint.fillRect(-r * 1.3, -r * 1.3, r * 2.6, r * 2.6);

    const caustic = paint.createLinearGradient(-r, r * .8, r, -r * .6);
    caustic.addColorStop(0, '#f2e1b24f');
    caustic.addColorStop(.41, '#c0ccb111');
    caustic.addColorStop(.76, '#a4efd638');
    caustic.addColorStop(1, '#a4efd686');
    paint.strokeStyle = caustic;
    paint.lineWidth = .6;
    for (let line = 0; line < 36; line++) {
      const v = line / 35;
      paint.globalAlpha = opacity * (.46 + Math.sin(v * Math.PI) * .43);
      paint.beginPath();
      for (let i = 0; i <= 72; i++) {
        const u = i / 72;
        const x = (u * 2.5 - 1.25) * r;
        const fold = Math.sin(u * 7.4 + v * 3.9 - t * .58) * .29;
        const y = (v * 2.3 - 1.15 + fold + .14 * Math.sin(u * 12 + t * .63)) * r;
        if (i === 0) paint.moveTo(x, y);
        else paint.lineTo(x, y);
      }
      paint.stroke();
    }
    paint.restore();
  }

  // The broad streams share the sculpture's palette and time. They travel from
  // beyond the viewport so the welcome reads as a space, even in a wide window.
  function drawCurrents(t, opacity, width, height) {
    if (opacity < .01) return;
    const warm = '#d2c8a3';
    const cool = '#7cdbb6';
    const horizontal = width;
    const vertical = height;
    const wave = Math.sin(t * .36);
    const sweep = Math.cos(t * .25);
    const streams = [
      {
        color: warm,
        x: [-.15, .21, .64, 1.13],
        y: [.68 + wave * .04, .56, -.20 + sweep * .06, .20],
        direction: 1,
      },
      {
        color: cool,
        themed: true,
        x: [1.14, .72, .27, -.13],
        y: [.77 - sweep * .04, .33, -.15 + wave * .04, .30],
        direction: -1,
      },
    ];
    paint.save();
    for (const stream of streams) {
      const [ax, bx, cx, dx] = stream.x.map((x) => x * horizontal);
      const [ay, by, cy, dy] = stream.y.map((y) => y * vertical);
      const tint = paint.createLinearGradient(ax, ay, dx, dy);
      const color = (alpha) => stream.themed ? (stream.color + alpha) : stream.color + alpha;
      tint.addColorStop(0, color('07'));
      tint.addColorStop(.18, color('29'));
      tint.addColorStop(.62, color('15'));
      tint.addColorStop(1, color('08'));
      paint.strokeStyle = tint;
      paint.lineWidth = .66;
      for (let strand = 0; strand < 14; strand++) {
        const spread = (strand - 6.5) * .016 * vertical;
        const breathing = Math.sin(t * .48 + strand * .33) * vertical * .017;
        paint.globalAlpha = opacity * (.28 + .52 * Math.sin(strand / 13 * Math.PI));
        paint.beginPath();
        paint.moveTo(ax, ay + spread * .32);
        paint.bezierCurveTo(bx, by + spread * 1.4 + breathing, cx, cy - spread * 1.15 + breathing, dx, dy + spread * .45);
        paint.stroke();
      }

      paint.fillStyle = stream.color;
      for (let point = 0; point < 162; point++) {
        const sample = points[point * 17 + (stream.direction > 0 ? 290 : 0)];
        const u = (sample.drift + t * (.026 + sample.variation * .019)) % 1;
        const v = 1 - u;
        const z = sample.exitY * vertical * .17;
        const x = v ** 3 * ax + 3 * v * v * u * bx + 3 * v * u * u * cx + u ** 3 * dx;
        const y = v ** 3 * ay + 3 * v * v * u * by + 3 * v * u * u * cy + u ** 3 * dy
          + z * Math.sin(u * Math.PI) + Math.sin(t * .62 + point * 2.4) * 3;
        const spark = .65 + sample.variation * .67;
        paint.globalAlpha = opacity * Math.sin(u * Math.PI) * (.13 + sample.variation * .25);
        paint.fillRect(x, y, spark, spark);
      }
    }
    paint.restore();
  }

  function projectRoom(point, room, projected = {}) {
    const depth = point.x * room.sine + point.z * room.cosine;
    const span = room.size / (1 - depth * .07);
    projected.x = room.x + (point.x * room.cosine - point.z * room.sine) * span;
    projected.y = room.y + (depth * .43 - point.y * .93) * span;
    projected.depth = depth;
    return projected;
  }

  const projectedPoint = {};
  function traceLine(room, points, move = true) {
    for (let step = 0; step < points.length; step++) {
      const point = projectRoom(points[step], room, projectedPoint);
      if (step === 0 && move) paint.moveTo(point.x, point.y);
      else paint.lineTo(point.x, point.y);
    }
  }

  function drawRoom(room, assembly, opacity) {
    if (assembly < .02 || opacity < .01) return;
    const floor = ease(assembly * 1.9);
    const walls = smooth((assembly - .16) / .84);
    paint.save();

    const floorTint = paint.createRadialGradient(room.x, room.y, 0, room.x, room.y, room.size * 1.35);
    floorTint.addColorStop(0, '#72a89042');
    floorTint.addColorStop(.63, '#20463b4f');
    floorTint.addColorStop(1, '#10171103');
    paint.globalAlpha = floor * opacity;
    paint.fillStyle = floorTint;
    paint.beginPath();
    traceLine(room, floorLines[0]);
    paint.closePath();
    paint.fill();

    const rim = paint.createLinearGradient(room.x - room.size, 0, room.x + room.size, 0);
    rim.addColorStop(0, '#edcf9c');
    rim.addColorStop(.46, '#869f89');
    rim.addColorStop(1, '#9bebcd');
    paint.strokeStyle = rim;
    paint.lineWidth = .8;
    for (let band = 0; band < 5; band++) {
      paint.globalAlpha = floor * opacity * (band === 0 ? .67 : .16 - .023 * band);
      paint.beginPath();
      traceLine(room, floorLines[band]);
      paint.closePath();
      paint.stroke();
    }

    paint.globalAlpha = walls * opacity;
    const veil = paint.createLinearGradient(0, room.y - room.size, 0, room.y + room.size * .4);
    veil.addColorStop(0, '#5c92775e');
    veil.addColorStop(.62, '#244b3a3b');
    veil.addColorStop(1, '#23433408');
    paint.fillStyle = veil;
    paint.beginPath();
    traceLine(room, wallRows[24]);
    traceLine(room, wallBaseReversed, false);
    paint.closePath();
    paint.fill();

    for (let row = 0; row <= 24; row++) {
      const level = row / 24 * .96;
      paint.globalAlpha = walls * opacity * (row === 24 ? .68 : .11 + .12 * level);
      paint.lineWidth = row === 24 ? 1.2 : .65;
      paint.beginPath();
      traceLine(room, wallRows[row]);
      paint.stroke();
    }
    for (let column = 0; column <= 57; column++) {
      const edge = column === 0 || column === 57;
      paint.globalAlpha = walls * opacity * (edge ? .53 : .10);
      paint.lineWidth = edge ? .96 : .55;
      paint.beginPath();
      traceLine(room, wallColumns[column]);
      paint.stroke();
    }
    paint.restore();
  }

  function drawPresence(point, ground, room, t, isAgent, activity, opacity) {
    const color = (alpha = '') => isAgent ? agentLight + alpha : amber + alpha;
    const radius = room.size * (isAgent ? .124 : .136);
    const bloom = paint.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius * 2.6);
    bloom.addColorStop(0, color('72'));
    bloom.addColorStop(.32, color('34'));
    bloom.addColorStop(1, color('00'));
    paint.save();
    paint.globalAlpha = opacity * (.65 + activity * .35);
    paint.fillStyle = bloom;
    paint.fillRect(point.x - radius * 2.6, point.y - radius * 2.6, radius * 5.2, radius * 5.2);
    paint.strokeStyle = color();
    paint.lineWidth = .8;
    paint.globalAlpha = opacity * .17;
    paint.setLineDash([1, 4]);
    paint.beginPath();
    paint.moveTo(point.x, point.y + radius * .6);
    paint.lineTo(ground.x, ground.y);
    paint.stroke();
    paint.setLineDash([]);
    paint.globalAlpha = opacity * (.30 + activity * .27);
    paint.beginPath();
    paint.ellipse(ground.x, ground.y, radius * 1.16, radius * .37, 0, 0, tau);
    paint.stroke();

    paint.fillStyle = color();
    for (let index = 0; index < 122; index++) {
      const a = index * 2.399963 + t * (isAgent ? -.9 : .70);
      const vertical = index / 121 * 2 - 1;
      const section = Math.sqrt(1 - vertical ** 2);
      const y = vertical * radius;
      const face = Math.sin(a) * section;
      const rib = isAgent ? .8 + .20 * Math.abs(Math.cos(a * 2)) : .85 + .15 * Math.sin(a * 3 + t);
      const x = Math.cos(a) * section * radius * rib;
      paint.globalAlpha = opacity * (.28 + .57 * (face + 1) / 2);
      paint.beginPath();
      paint.arc(point.x + x + y * (isAgent ? .16 : -.21), point.y + y * (isAgent ? .95 : .93), index % 17 === 0 ? 1.5 : .86, 0, tau);
      paint.fill();
    }
    paint.restore();
  }

  function sampleArc(from, to, u, rise) {
    return {
      x: mix(from.x, to.x, u),
      y: mix(from.y, to.y, u) - Math.sin(u * Math.PI) * rise,
    };
  }

  function drawPacket(point, size, t, ordered, opacity) {
    const color = paint.createLinearGradient(point.x - size, point.y, point.x + size, point.y);
    color.addColorStop(0, amber);
    color.addColorStop(mix(1, 0, ordered), agentLight);
    color.addColorStop(1, '#e0fff3');
    paint.fillStyle = color;
    paint.strokeStyle = color;
    for (let index = 0; index < 68; index++) {
      const a = index * 2.399963;
      const u = index / 67;
      const looseX = Math.cos(a + t * 2.1) * (.52 + .48 * Math.sin(index * 6.4) ** 2);
      const looseY = Math.sin(a - t * 1.43) * .65;
      const checkX = u < .36 ? mix(-.56, -.16, u / .36) : mix(-.16, .65, (u - .36) / .64);
      const checkY = u < .36 ? mix(.03, .44, u / .36) : mix(.44, -.42, (u - .36) / .64);
      paint.globalAlpha = opacity * (.6 + .4 * Math.sin(index * 3.2 + t * 3.2) ** 2);
      paint.beginPath();
      paint.arc(point.x + size * mix(looseX, checkX, ordered), point.y + size * mix(looseY, checkY, ordered),
        index % 13 === 0 ? 1.8 : .95, 0, tau);
      paint.fill();
    }
    if (ordered > .75) {
      paint.globalAlpha = opacity * smooth((ordered - .75) / .25) * .85;
      paint.lineWidth = Math.max(1.55, size * .11);
      paint.lineCap = 'round';
      paint.lineJoin = 'round';
      paint.beginPath();
      paint.moveTo(point.x - size * .56, point.y + size * .03);
      paint.lineTo(point.x - size * .16, point.y + size * .44);
      paint.lineTo(point.x + size * .65, point.y - size * .42);
      paint.stroke();
    }
  }

  function drawReceipt(room, origin, phase, opacity) {
    if (phase <= 0 || phase >= 1.34) return;
    paint.save();
    paint.strokeStyle = agentLight;
    paint.lineWidth = .9;
    for (let band = 0; band < 3; band++) {
      const echo = smooth((phase - band * .11) / 1.12);
      if (echo <= 0 || echo >= 1) continue;
      const spread = room.size * (.07 + echo * .88);
      paint.globalAlpha = opacity * Math.sin(echo * Math.PI) * (.33 - band * .07);
      paint.beginPath();
      paint.ellipse(origin.x, origin.y, spread, spread * .36, 0, -Math.PI * .3, Math.PI * .32);
      paint.stroke();
    }
    paint.restore();
  }

  function drawExchange(room, t, opacity, moving) {
    const phase = Math.max(0, t - roomReady) % exchangeDuration;
    const stage = t < roomReady ? 'assemble' : phase < 2.45 ? 'send' : phase < 4.28 ? 'work' : phase < 5.83 ? 'return' : 'complete';
    const presence = opacity * smooth((t - 1.25) / 1.4);
    if (presence < .01) return;

    const anchors = [-.55, .55].map((side) => {
      const base = { x: side * .79, z: side * -.64, y: 0 };
      return {
        ground: projectRoom(base, room),
        light: projectRoom({ ...base, y: .44 + Math.sin(t * 1.15 + side * 4) * .017 }, room),
      };
    });
    const working = stage === 'work' ? Math.sin(clamp((phase - 2.45) / 1.83) * Math.PI) : 0;
    const receipt = phase - 5.83;
    if (moving) drawReceipt(room, anchors[0].ground, receipt, presence);
    const senderActivity = stage === 'send' ? .5 : .9 * (1 - smooth(receipt / .7)) * Number(receipt >= 0);
    drawPresence(anchors[0].light, anchors[0].ground, room, t, false, senderActivity, presence);
    drawPresence(anchors[1].light, anchors[1].ground, room, t, true, working, presence);
    if (t < roomReady) return;

    const receive = smooth((phase - 2.51) / 1.48);
    const returning = phase >= 4.28;
    const travel = returning ? smooth((phase - 4.28) / 1.55) : smooth((phase - .9) / 1.55);
    const from = anchors[returning ? 1 : 0].light;
    const to = anchors[returning ? 0 : 1].light;
    const above = -room.size * .22;
    const packetStart = { x: from.x, y: from.y + above };
    const packetEnd = { x: to.x, y: to.y + above };
    const rise = room.size * (returning ? .09 : .20);
    const packetOpacity = presence * smooth(phase / .60) * (1 - smooth((phase - 8.4) / 1.4));
    paint.save();

    if (travel > 0 && travel < 1) {
      paint.fillStyle = returning ? agentLight : amber;
      for (let index = 1; index <= 27; index++) {
        const u = travel - index * .012;
        if (u < 0) continue;
        const point = sampleArc(packetStart, packetEnd, u, rise);
        paint.globalAlpha = packetOpacity * (1 - index / 28) * .68;
        paint.beginPath();
        paint.arc(point.x, point.y + Math.sin(t * 4 + index * .46) * index * .18, 2.3 - index * .054, 0, tau);
        paint.fill();
      }
    }
    const point = sampleArc(packetStart, packetEnd, travel, rise);
    if (working > 0) {
      paint.strokeStyle = agentLight;
      paint.lineWidth = .8;
      for (let index = 0; index < 3; index++) {
        const wave = ((phase - 2.45) * 1.52 + index / 3) % 1;
        paint.globalAlpha = working * presence * (1 - wave) * .45;
        paint.beginPath();
        paint.ellipse(point.x, point.y, room.size * (.055 + wave * .19), room.size * (.045 + wave * .12), -.2, 0, tau);
        paint.stroke();
      }
    }
    drawPacket(point, room.size * .13, t, receive, packetOpacity);
    paint.restore();
  }

  function render(width, height, t, moving, mark) {
    if (!paint || !width || !height) return;
    paint.clearRect(0, 0, width, height);
    const sculptureX = width * .5;
    const sculptureY = height * .43;
    const size = Math.min(width * .37, height * .4, 278);
    const arrival = moving ? ease((t - .03) / arrivalDuration) : 1;
    const azimuth = -.35 + (moving ? Math.sin(t * .56) * .1 : 0);
    const incline = -.31;
    const ca = Math.cos(azimuth);
    const sa = Math.sin(azimuth);
    const ci = Math.cos(incline);
    const si = Math.sin(incline);
    const roll = -.3;
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const cx = sculptureX;
    const cy = sculptureY;
    const density = width < 520 ? 2 : 1;
    const assembly = moving ? smooth((t - .56) / (roomReady - .56)) : 1;
    const gathering = moving && assembly < 1;
    const roomScale = Math.min(size, width * .32);
    const yaw = .72 + Math.sin(t * .47) * .052;
    const room = {
      x: cx,
      y: cy + roomScale * .36,
      size: roomScale,
      sine: Math.sin(yaw),
      cosine: Math.cos(yaw),
    };
    const collapse = mark ? 1 - (1 - clamp(mark.progress)) ** 2.25 : 0;
    const sceneOpacity = (1 - collapse) ** 2;
    const particleOpacity = 1 - smooth((collapse - .84) / .16);

    drawCurrents(t, (moving ? ease(t / .95) : 1) * (1 - assembly * .45) * sceneOpacity, width, height);
    drawOrbit(cx, cy, size, arrival * (1 - assembly) * sceneOpacity);
    drawCore(cx + size * .02, cy - size * .01, size * (.48 + arrival * .075), t,
      ease((arrival - .16) / .84) * (1 - assembly) ** 2 * sceneOpacity);
    drawRoom(room, assembly, sceneOpacity);
    for (let index = 0; index < points.length; index += density) {
      const point = points[index];
      const strand = point.strand;
      const tint = strand < 11 ? 0 : 1;
      const formed = projectRoom(point.roomPoint, room, projectedPoint);
      const laid = assembly === 1 ? 1 : smooth((assembly - point.delay * .40) / (1 - point.delay * .40));
      let shellX = formed.x;
      let shellY = formed.y;
      let perspective = 1 / (1 - formed.depth * .07);
      let depth = formed.depth * .34;
      const ribbon = (strand % 11 - 5) * .033;
      const angle = point.u + t * (tint ? -.11 : .08);
      const gathered = gathering ? ease((t - point.delay) / (arrivalDuration - .33)) : 1;
      if (laid < 1) {
        const curl = angle * 3 + tint * .39 + t * .25;
        const beat = Math.sin(angle * 5 - t * 1.06);
        const tube = ribbon * Math.cos(angle * 2.2 + t * .33) + (point.variation - .5) * .029;
        const radius = .765 + (.37 + tube * .48) * Math.cos(curl) + .035 * beat + ribbon * .49;
        const x = radius * Math.cos(angle * 2);
        const y = radius * Math.sin(angle * 2) * .88;
        const z = (.49 + tube) * Math.sin(curl) + ribbon * Math.sin(angle * 3) + tube * .6;
        const rotatedX = x * ca + z * sa;
        const aroundZ = z * ca - x * sa;
        const rotatedY = y * ci - aroundZ * si;
        const originalDepth = y * si + aroundZ * ci;
        const lens = 3.5 / (3.5 - originalDepth);
        const edge = (1 - gathered) ** 1.6;
        const side = tint ? 1 : -1;
        const burstX = side * edge * width * (.38 + point.drift * .37);
        const burstY = edge * height * ((point.exitY + side * .19) * .89);
        shellX = mix(cx + (rotatedX * cr - rotatedY * sr) * lens * size + burstX, formed.x, laid);
        shellY = mix(cy + (rotatedY * cr + rotatedX * sr) * lens * size + burstY, formed.y, laid);
        depth = mix(originalDepth, depth, laid);
        perspective = mix(lens, perspective, laid);
      }
      const face = clamp((depth + .47) / .96);
      const glint = .58 + .42 * Math.sin(angle * 4 + t * 1.75 + ribbon * 5) ** 2;
      const orbitShine = clamp(.21 + face * .67 + point.variation * .12);
      const alpha = (Math.min(1, gathered * 2.5 + .13) * glint * orbitShine) * (1 - laid * .32) * particleOpacity;
      if (alpha < .028) continue;
      const shimmer = point.variation > .985;
      const diameter = (shimmer ? 2.3 : .65 + point.variation * .91) * perspective * (density === 2 ? 1.05 : 1);
      paint.globalAlpha = alpha;
      let cool = laid > .5 ? formed.x > cx + room.size * (point.variation - .5) * .7 : tint;
      if (mark) {
        const destination = mark.points[Math.floor(point.variation * mark.points.length)];
        const progress = clamp(collapse + Math.sin(point.u * 2) * Math.sin(collapse * Math.PI) * .13);
        const curl = Math.sin(progress * Math.PI) * (1 - point.variation) * size * .54;
        shellX = mix(shellX, mark.x + destination.x * mark.scale, progress) + Math.cos(point.u * 2) * curl;
        shellY = mix(shellY, mark.y + destination.y * mark.scale, progress) + Math.sin(point.u * 2) * curl;
        if (progress > .72) cool = destination.accent;
      }
      paint.fillStyle = cool
        ? (shimmer ? '#d7fff3' : '#77e4c2')
        : (shimmer ? '#fffdf4' : '#f3edda');
      paint.fillRect(shellX, shellY, diameter, diameter);
      if (shimmer && face > .64) {
        paint.globalAlpha = alpha * .12;
        paint.fillRect(shellX - diameter * .65, shellY - diameter * .65, diameter * 2.4, diameter * 2.4);
      }
    }

    paint.globalAlpha = arrival * .26 * sceneOpacity;
    for (let index = 2; index < 73; index++) {
      const point = points[index * 23];
      const a = index * 2.399963 + t * .08;
      const r = size * (1.05 + point.variation * .8);
      paint.fillStyle = index % 3 ? '#a9c9b6' : '#d0ceb8';
      paint.fillRect(cx + Math.cos(a) * r, cy + Math.sin(a) * r * .57 - Math.cos(a) * r * .12, 1, 1);
    }
    paint.globalAlpha = 1;
    drawExchange(room, t, sceneOpacity, moving);
  }

  return render;
}
