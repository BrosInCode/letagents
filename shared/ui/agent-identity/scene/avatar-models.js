import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Each character is a complete, articulated model. Materials are shared by the
// single preview renderer; picker portraits are still images of these same meshes.
export function createAvatarModel(id, materials) {
  const { shell, pale, joint, rubber, trim, glass, light } = materials;
  const robot = new THREE.Group();
  robot.name = id;
  const rig = new THREE.Group();
  robot.add(rig);
  const mesh = (parent, geometry, mat, position = [0, 0, 0]) => {
    const obj = new THREE.Mesh(geometry, mat);
    obj.position.set(...position);
    obj.castShadow = true;
    obj.receiveShadow = true;
    parent.add(obj);
    return obj;
  };
  const box = (parent, w, h, d, r, mat, xyz) => {
    // Keep a broad, rounded silhouette even on shallow inset panels.
    const roundDepth = Math.max(d, r * 2);
    const geometry = new RoundedBoxGeometry(w, h, roundDepth, 5, r);
    geometry.scale(1, 1, d / roundDepth);
    return mesh(parent, geometry, mat, xyz);
  };
  const ball = (parent, radius, mat, xyz, scale) => {
    const obj = mesh(parent, new THREE.SphereGeometry(radius, 32, 24), mat, xyz);
    if (scale) obj.scale.set(...scale);
    return obj;
  };
  const cylinder = (parent, radius, height, mat, xyz) => mesh(parent, new THREE.CylinderGeometry(radius, radius, height, 32), mat, xyz);
  const tube = (parent, points, radius, mat) => mesh(parent, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p))), 28, radius, 8, false), mat);


  if (id === 'orbit') {
  // Feet sit on the ground; separate soft soles make their weight legible.
  for (const side of [-1, 1]) {
    cylinder(rig, .125, .26, joint, [side * .27, .45, 0]);
    box(rig, .43, .13, .59, .06, rubber, [side * .28, .09, .06]);
    box(rig, .44, .27, .56, .12, shell, [side * .28, .23, .06]);
    box(rig, .23, .025, .05, .012, pale, [side * .28, .305, .31]);
  }
  const torso = box(rig, 1.03, .93, .72, .27, shell, [0, .99, 0]);
  torso.rotation.z = -.025;
  box(rig, .73, .56, .12, .17, pale, [0, 1.04, .345]);
  const chestRing = cylinder(rig, .12, .035, trim, [0, 1.07, .422]);
  chestRing.rotation.x = Math.PI / 2;
  const chestLight = ball(rig, .073, light, [0, 1.07, .45], [1, 1, .5]);
  box(rig, .2, .022, .018, .01, trim, [0, .77, .41]);
  // Back panel and vents reward turning the character.
  box(rig, .64, .57, .075, .12, trim, [0, 1.04, -.36]);
  for (let i = 0; i < 3; i++) box(rig, .3, .035, .02, .016, rubber, [0, 1.11 - i * .09, -.405]);
  cylinder(rig, .22, .22, joint, [0, 1.48, 0]);

  const arms = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(side * .61, 1.32, 0);
    rig.add(arm);
    ball(arm, .17, joint, [0, 0, 0]);
    box(arm, .27, .55, .32, .13, shell, [side * .035, -.25, .015]);
    ball(arm, .15, pale, [side * .045, -.51, .025], [1, 1.08, 1]);
    tube(arm, [[-.065, -.59, .15], [0, -.61, .16], [.065, -.59, .15]], .009, trim);
    arm.rotation.z = side * .14;
    arms.push(arm);
  }

  const head = new THREE.Group();
  head.position.y = 2.09;
  rig.add(head);
  box(head, 1.99, 1.34, 1.12, .38, shell);
  // A narrow rim, recessed face and restrained reflections — not a shiny ball.
  box(head, 1.72, 1.04, .13, .32, trim, [0, 0, .523]);
  box(head, 1.59, .91, .085, .29, glass, [0, 0, .606]);
  for (const side of [-1, 1]) {
    const pod = cylinder(head, .235, .17, trim, [side * 1.015, .005, -.01]);
    pod.rotation.z = Math.PI / 2;
    const ear = cylinder(head, .18, .045, pale, [side * 1.115, .005, -.01]);
    ear.rotation.z = Math.PI / 2;
    const pin = cylinder(head, .045, .05, joint, [side * 1.145, .005, -.01]);
    pin.rotation.z = Math.PI / 2;
  }
  // The rear seam and small fasteners make this a complete model from every angle.
  box(head, 1.43, .79, .035, .25, trim, [0, 0, -.56]);
  box(head, 1.36, .72, .04, .23, shell, [0, 0, -.58]);
  for (const side of [-1, 1]) {
    const screw = cylinder(head, .035, .025, joint, [side * .51, -.2, -.606]);
    screw.rotation.x = Math.PI / 2;
  }
  const antenna = new THREE.Group();
  antenna.position.y = .63;
  head.add(antenna);
  cylinder(antenna, .095, .06, trim, [0, .025, 0]);
  cylinder(antenna, .038, .3, pale, [0, .19, 0]);
  ball(antenna, .125, pale, [0, .39, 0]);
  ball(antenna, .046, light, [0, .42, .105], [1, 1, .4]);
  const eyes = [];
  for (const side of [-1, 1]) eyes.push(box(head, .15, .27, .047, .074, light, [side * .35, .045, .668]));
  tube(head, [[-.12, -.2, .674], [0, -.235, .682], [.12, -.2, .674]], .017, light);
  // Tiny cheek indicators disappear at small size, keeping the portrait simple.
  for (const side of [-1, 1]) box(head, .105, .024, .012, .01, trim, [side * .54, -.14, .66]);

    return { robot, rig, head, antenna, arms, eyes };
  }
  const head = new THREE.Group();
  head.position.y = 2.05;
  rig.add(head);
  const antenna = new THREE.Group();
  head.add(antenna);
  const arms = [], eyes = [];
  const group = (parent, xyz = [0, 0, 0]) => {
    const g = new THREE.Group(); g.position.set(...xyz); parent.add(g); return g;
  };
  const eye = (x, y, z, size = .1, mat = glass, shape = 'round') => {
    const g = group(head, [x, y, z]);
    if (shape === 'square') box(g, size * 1.6, size * 1.6, .045, .028, mat);
    else ball(g, size, mat, [0, 0, 0], [.8, 1.13, .48]);
    if (mat === glass) ball(g, size * .25, pale, [-size * .19, size * .3, size * .39]);
    eyes.push(g); return g;
  };
  const smile = (y, z, width = .18, mat = glass) => tube(head, [[-width, y, z], [0, y - .055, z + .015], [width, y, z]], .018, mat);
  const arcEye = (x, y, z, inverted = false) => {
    const g = group(head, [x, y, z]);
    tube(g, [[-.09, 0, 0], [0, inverted ? -.035 : .065, .01], [.09, 0, 0]], .023, light);
    eyes.push(g);
  };
  const solid = (parent, shape, depth, bevel, mat, xyz = [0, 0, 0]) => {
    const geometry = new THREE.ExtrudeGeometry(shape, { depth, steps: 1, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 24 });
    geometry.translate(0, 0, -depth / 2);
    return mesh(parent, geometry, mat, xyz);
  };
  const triangle = (parent, width, height, depth, mat, xyz) => {
    const shape = new THREE.Shape();
    shape.moveTo(-width / 2, 0); shape.lineTo(0, height); shape.lineTo(width / 2, 0); shape.closePath();
    return solid(parent, shape, depth, .055, mat, xyz);
  };
  const starShape = (radius, inner, points = 5) => {
    const shape = new THREE.Shape();
    for (let i = 0; i < points * 2; i++) {
      const a = Math.PI / 2 + i * Math.PI / points, r = i % 2 ? inner : radius;
      if (!i) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    shape.closePath(); return shape;
  };
  const ring = (parent, radius, thickness, mat, xyz, rotation = [Math.PI / 2, 0, 0]) => {
    const r = mesh(parent, new THREE.TorusGeometry(radius, thickness, 12, 48), mat, xyz);
    r.rotation.set(...rotation); return r;
  };
  const body = (kind = 'soft', width = 1, height = .95) => {
    const y = .98;
    if (kind === 'box') box(rig, width, height, .72, .15, shell, [0, y, 0]);
    else ball(rig, .5, shell, [0, y, 0], [width, height * 1.12, .8]);
    if (kind !== 'plain') ball(rig, .34, pale, [0, y - .04, .33], [width * .88, height * 1.05, .23]);
    cylinder(rig, .17, .21, joint, [0, 1.43, 0]);
    for (const side of [-1, 1]) {
      const x = side * width * .28;
      cylinder(rig, .11, .23, joint, [x, .43, 0]);
      if (kind === 'box') {
        box(rig, .4, .26, .55, .085, shell, [x, .23, .09]);
        box(rig, .4, .075, .56, .03, rubber, [x, .1, .09]);
      } else {
        ball(rig, .21, shell, [x, .22, .09], [1, .75, 1.32]);
        ball(rig, .18, rubber, [x, .115, .09], [1.06, .27, 1.35]);
      }
      const arm = group(rig, [side * width * .55, 1.22, 0]);
      if (kind === 'box') box(arm, .25, .5, .29, .095, shell, [side * .025, -.2, 0]);
      else ball(arm, .17, shell, [side * .035, -.2, 0], [.9, 1.8, 1]);
      ball(arm, .135, pale, [side * .055, -.43, .02]);
      arm.rotation.z = side * .14; arms.push(arm);
    }
  };
  const earPods = (width, y = 0, radius = .19) => {
    for (const side of [-1, 1]) {
      const p = cylinder(head, radius, .16, trim, [side * width, y, 0]); p.rotation.z = Math.PI / 2;
      const cap = cylinder(head, radius * .67, .04, pale, [side * (width + .09), y, 0]); cap.rotation.z = Math.PI / 2;
    }
  };
  const pointEars = (width = .57, y = .43, height = .52) => {
    for (const side of [-1, 1]) {
      const g = group(head, [side * width, y, -.02]); g.rotation.z = -side * .12;
      triangle(g, .47, height, .32, shell, [0, 0, 0]);
      triangle(g, .26, height * .62, .035, pale, [0, .075, .205]);
    }
  };
  const cheeks = (y = -.22, z = .59, width = .22) => {
    for (const side of [-1, 1]) ball(head, width, pale, [side * .21, y, z], [1.2, .7, .45]);
    ball(head, .075, glass, [0, y + .08, z + .11], [1, .7, .65]);
    tube(head, [[0, y + .025, z + .11], [0, y - .07, z + .09]], .015, glass);
  };

  switch (id) {
    case 'prism': {
      body('box', .96, .9);
      box(head, 1.76, 1.32, 1.16, .13, shell);
      box(head, 1.51, .83, .09, .09, trim, [0, -.055, .58]);
      box(head, 1.36, .68, .065, .07, glass, [0, -.055, .639]);
      box(head, 1.23, .105, .7, .04, pale, [0, .67, -.06]);
      earPods(.91, -.02, .16);
      eye(-.31, .015, .688, .1, light, 'square'); eye(.31, .015, .688, .1, light, 'square');
      box(head, .2, .035, .025, .015, light, [0, -.24, .69]);
      box(rig, .24, .15, .04, .025, trim, [0, .99, .43]);
      box(head, 1.23, .88, .05, .08, trim, [0, 0, -.58]);
      for (let i = 0; i < 4; i++) box(head, .09, .31, .03, .025, joint, [-.27 + i * .18, 0, -.62]);
      break;
    }
    case 'tide': {
      body('soft', .85, .9);
      ball(head, .8, shell, [0, 0, 0], [1.35, .82, .82]);
      ball(head, .7, trim, [0, -.01, .37], [1.28, .65, .46]);
      ball(head, .65, glass, [0, -.01, .46], [1.28, .6, .4]);
      eye(-.35, .04, .704, .105, light); eye(.35, .04, .704, .105, light);
      smile(-.18, .71, .14, light); earPods(1.01, -.04, .18);
      cylinder(antenna, .18, .09, pale, [0, .66, -.05]);
      ring(head, .61, .025, pale, [0, 0, -.19], [0, Math.PI / 2, 0]);
      ring(rig, .36, .04, trim, [0, .64, 0]);
      break;
    }
    case 'spark': {
      body('soft', 1.03, 1.02);
      ball(head, .78, shell, [0, -.015, 0], [1.05, .86, .78]);
      pointEars(.53, .4, .6); cheeks(-.23, .56, .28);
      eye(-.29, .07, .578, .095); eye(.29, .07, .578, .095);
      tube(rig, [[0, .65, -.27], [.55, .62, -.65], [.88, 1.03, -.56], [.88, 1.48, -.4]], .23, shell);
      ball(rig, .235, pale, [.88, 1.48, -.4], [.95, 1.15, .94]);
      ring(rig, .26, .035, trim, [0, 1.39, 0]);
      break;
    }
    case 'bloom': {
      body('soft', .94, .94);
      box(head, 1.48, 1.45, 1.03, .48, shell);
      box(head, 1.2, .91, .1, .4, trim, [0, -.03, .5]);
      box(head, 1.07, .78, .08, .35, glass, [0, -.03, .57]);
      arcEye(-.26, .06, .626); arcEye(.26, .06, .626);
      smile(-.17, .635, .13, light);
      for (const side of [-1, 1]) ball(head, .065, pale, [side * .36, -.14, .626], [1.4, .5, .25]);
      tube(head, [[-.7, -.15, 0], [-.68, .57, 0], [0, .78, 0], [.68, .57, 0], [.7, -.15, 0]], .055, pale);
      earPods(.75, -.1, .17);
      break;
    }
    case 'beacon': {
      body('box', .83, .85); head.position.y = 1.74;
      const profile = [[0, -.52], [.48, -.52], [.66, -.27], [.69, .13], [.55, .55], [.28, .93], [0, 1.12]].map(([x,y])=>new THREE.Vector2(x,y));
      mesh(head, new THREE.LatheGeometry(profile, 48), shell);
      box(head, 1.11, .48, .13, .21, trim, [0, .05, .61]);
      box(head, .96, .36, .08, .16, glass, [0, .05, .7]);
      eye(-.25, .065, .756, .075, light); eye(.25, .065, .756, .075, light);
      ball(antenna, .08, light, [0, 1.11, 0]);
      for (const side of [-1, 1]) {
        const fin=triangle(head, .29, .57, .23, pale, [side * .64, -.48, -.03]); fin.rotation.z = -side * .3;
      }
      ring(head, .48, .035, trim, [0, -.49, 0]);
      break;
    }
    case 'fern': {
      body('plain', .95, .91);
      ring(rig, .47, .065, pale, [0, 1.21, 0]);
      box(head, 1.57, 1.2, 1.02, .37, shell);
      box(head, 1.24, .72, .1, .29, glass, [0, -.025, .51]);
      eye(-.27, .01, .581, .085, light); eye(.27, .01, .581, .085, light); smile(-.21, .59, .14, light);
      tube(antenna, [[0, .55, 0], [0, .82, 0], [.05, 1.03, 0]], .035, joint);
      for (const side of [-1, 1]) {
        const leaf=ball(antenna,.26,side<0?shell:pale,[side*.22,.85,0],[1.35,.53,.38]); leaf.rotation.z=side*.52;
        tube(antenna, [[side*.03,.76,.09],[side*.22,.85,.1],[side*.44,.96,.04]], .011, trim);
      }
      for (let i=0;i<3;i++) box(rig,.025,.43,.02,.01,trim,[-.18+i*.18,.95,.45]);
      break;
    }
    case 'pip': {
      body('soft', .9, .92); head.position.y=1.83;
      ball(head,.69,shell,[0,0,0],[1.08,.88,.84]);
      for(const side of [-1,1]) {
        const ear=group(head,[side*.33,.48,-.06]);ear.rotation.z=-side*.13;
        ball(ear,.22,shell,[0,.4,0],[.9,2.1,.75]);
        ball(ear,.15,pale,[0,.42,.13],[.82,2.13,.28]);
      }
      eye(-.25,.03,.567,.09);eye(.25,.03,.567,.09);cheeks(-.18,.56,.18);
      ball(rig,.23,pale,[0,.7,-.46]);
      break;
    }
    case 'pebble': {
      body('soft',1.1,1.05);
      ball(head,.78,pale,[0,0,0],[1.04,.94,.85]);
      for(const side of [-1,1]) {
        ball(head,.245,shell,[side*.58,.56,-.03]);
        ball(head,.14,joint,[side*.6,.58,.17],[1,1,.24]);
        const patch=ball(head,.22,joint,[side*.29,.045,.577],[1,1.22,.35]);patch.rotation.z=side*-.3;
        eye(side*.29,.06,.65,.086);
      }
      cheeks(-.23,.635,.19);
      ball(rig,.13,shell,[0,.69,-.41]);
      break;
    }
    case 'moss': {
      body('soft',1.07,.89); head.position.y=1.92;
      ball(head,.76,shell,[0,-.05,0],[1.15,.73,.8]);
      for(const side of [-1,1]) {
        ball(head,.32,shell,[side*.47,.42,.1]);
        ball(head,.237,pale,[side*.47,.45,.29],[1,1,.55]);
        eye(side*.47,.46,.423,.117);
        ball(head,.065,trim,[side*.18,.05,.595],[.55,.6,.3]);
        for(let i=0;i<3;i++) ball(rig,.085,pale,[side*.3+(i-1)*.115,.18,.33],[.75,.58,1.4]);
      }
      smile(-.18,.6,.33); break;
    }
    case 'wren': {
      body('soft',1.12,1.08); head.position.y=2.0;
      ball(head,.78,shell,[0,0,0],[1.02,.97,.84]);
      for(const side of [-1,1]) {
        triangle(head,.43,.36,.22,shell,[side*.51,.49,-.1]);
        ball(head,.34,pale,[side*.31,.04,.53],[1,1.1,.43]);
        eye(side*.31,.07,.687,.14);
        ball(arms[side<0?0:1],.21,shell,[side*.02,-.22,.07],[.7,1.5,1]);
      }
      const beak=mesh(head,new THREE.ConeGeometry(.13,.26,4),trim,[0,-.13,.79]);beak.rotation.x=Math.PI/2;
      for(let i=0;i<3;i++) ball(rig,.09,trim,[(i-1)*.2,1.02-(i%2)*.1,.41],[.4,.65,.22]);
      break;
    }
    case 'ember': {
      body('soft',.95,.94);
      ball(head,.74,shell,[0,0,0],[1.04,.91,.8]);pointEars(.5,.4,.49);
      cheeks(-.19,.56,.24);
      for(const side of [-1,1]) {
        const g=group(head,[side*.28,.075,.579]);
        tube(g,[[-.1,.02,0],[0,-.015,.015],[.1,.02,0]],.026,glass);eyes.push(g);
        for(const shift of [-.04,.04])tube(head,[[side*.4,-.21+shift,.57],[side*.64,-.16+shift,.51]],.012,trim);
      }
      tube(rig,[[0,.65,-.32],[.61,.58,-.52],[.86,1,-.47],[.83,1.35,-.39],[.63,1.41,-.31]],.12,shell);
      ring(rig,.25,.05,trim,[0,1.39,0]);ball(rig,.065,pale,[0,1.34,.28]); break;
    }
    case 'cosmo': {
      body('box',1.08,.96);
      ball(head,.88,pale,[0,0,0],[1,1,.91]);
      ball(head,.79,trim,[0,0,.29],[.93,.82,.66]);
      ball(head,.73,glass,[0,0,.39],[.94,.81,.57]);
      eye(-.29,.06,.802,.09,light);eye(.29,.06,.802,.09,light);smile(-.18,.812,.14,light);
      earPods(.87,0,.25);ring(head,.58,.06,trim,[0,-.61,0]);
      box(rig,.81,.83,.36,.15,trim,[0,1.04,-.47]);
      for(const side of [-1,1])cylinder(rig,.12,.57,pale,[side*.32,1.03,-.67]);
      box(rig,.42,.3,.06,.05,trim,[0,1.02,.43]);
      for(const side of [-1,1])ball(rig,.04,light,[side*.09,1.07,.478]);break;
    }
    case 'nimbus': {
      body('soft',.78,.82);head.position.y=2.02;
      const s=new THREE.Shape();s.moveTo(-.79,-.37);
      s.bezierCurveTo(-1.2,-.32,-1.12,.31,-.73,.34);
      s.bezierCurveTo(-.77,.87,-.18,1.02,.07,.61);
      s.bezierCurveTo(.39,.94,.87,.66,.8,.26);
      s.bezierCurveTo(1.21,.12,1.1,-.38,.76,-.4);
      s.quadraticCurveTo(0,-.57,-.79,-.37);s.closePath();
      solid(head,s,.61,.15,shell);
      eye(-.29,.015,.474,.1);eye(.29,.015,.474,.1);smile(-.18,.48,.13);
      for(const side of [-1,1])ball(head,.105,pale,[side*.49,-.15,.453],[1.2,.5,.25]);break;
    }
    case 'comet': {
      body('soft',.75,.84);head.position.y=2.05;
      solid(head,starShape(.94,.5),.47,.115,shell);
      eye(-.23,.035,.362,.085);eye(.23,.035,.362,.085);smile(-.16,.37,.12);
      solid(rig,starShape(.125,.066),.025,.015,pale,[0,.99,.42]);
      break;
    }
    case 'lune': {
      body('soft',.74,.86);head.position.y=2.03;
      const s=new THREE.Shape();s.moveTo(.38,.87);
      s.bezierCurveTo(-.62,1.15,-1.19,.28,-.68,-.55);
      s.bezierCurveTo(-.4,-1.02,.15,-1.02,.55,-.69);
      s.bezierCurveTo(-.15,-.68,-.38,-.19,-.19,.32);
      s.quadraticCurveTo(.01,.73,.38,.87);s.closePath();
      solid(head,s,.58,.095,shell);
      eye(-.57,.14,.391,.075);eye(-.29,.08,.391,.075);smile(-.11,.398,.08);
      const satellite=solid(antenna,starShape(.22,.115),.17,.035,pale,[.58,.25,.03]);satellite.rotation.z=.16;
      ball(antenna,.065,light,[.73,-.21,0]);
      break;
    }
    case 'ripple': {
      body('soft',.86,.86);head.position.y=1.98;
      const s=new THREE.Shape();s.moveTo(.04,1);
      s.bezierCurveTo(.15,.59,.81,.29,.75,-.17);
      s.bezierCurveTo(.7,-.91,-.68,-.91,-.74,-.17);
      s.bezierCurveTo(-.79,.28,-.19,.61,.04,1);s.closePath();
      solid(head,s,.56,.15,shell);
      eye(-.25,-.04,.44,.09);eye(.25,-.04,.44,.09);smile(-.25,.45,.14);
      ring(rig,.28,.04,pale,[0,1.4,0]);
      ring(rig,.37,.035,trim,[0,.69,0]);break;
    }
    case 'vesper': {
      body('box',.8,.83);
      const shape=new THREE.Shape();shape.moveTo(0,.89);shape.lineTo(.78,.4);shape.lineTo(.69,-.48);shape.lineTo(0,-.79);shape.lineTo(-.69,-.48);shape.lineTo(-.78,.4);shape.closePath();
      const jewel=solid(head,shape,.61,.095,shell);
      jewel.geometry.computeVertexNormals();
      // A crown of facets gives the jewel depth without obscuring its face.
      const facet=mesh(head,new THREE.ConeGeometry(.76,.41,6),pale,[0,.56,0]);facet.rotation.y=Math.PI/6;
      box(head,.96,.41,.08,.17,glass,[0,-.035,.41]);
      eye(-.24,-.01,.465,.066,light);eye(.24,-.01,.465,.066,light);
      mesh(rig,new THREE.OctahedronGeometry(.125),pale,[0,1.01,.43]);
      break;
    }
    default: throw new Error(`Unknown avatar: ${id}`);
  }
  return { robot, rig, head, antenna, arms, eyes };
}
