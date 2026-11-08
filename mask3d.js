// Gold Venetian mask in three.js. Shared by the landing hero and the app.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { TessellateModifier } from 'three/addons/modifiers/TessellateModifier.js';

// Mask outline, same path as the SVG logo (viewBox 200x110), mapped to world units.
const P = (x, y) => [(x - 100) / 50, -(y - 55) / 50];

function maskShape() {
  const s = new THREE.Shape();
  s.moveTo(...P(100, 30));
  const c = (a, b, c2, d, e, f) => s.bezierCurveTo(...P(a, b), ...P(c2, d), ...P(e, f));
  c(70, 4, 22, 2, 6, 26); c(-2, 40, 6, 70, 30, 86); c(52, 100, 80, 92, 100, 70);
  c(120, 92, 148, 100, 170, 86); c(194, 70, 202, 40, 194, 26); c(178, 2, 130, 4, 100, 30);
  const eye = (cx, cy, rot) => {
    const h = new THREE.Path(); const [x, y] = P(cx, cy);
    h.absellipse(x, y, 24 / 50, 14 / 50, 0, Math.PI * 2, true, rot); return h;
  };
  s.holes.push(eye(56, 50, 0.14), eye(144, 50, -0.14));
  return s;
}

// Curve the flat extrusion so it wraps like a face mask.
function bend(geo, k) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    p.setZ(i, p.getZ(i) - k * x * x - 0.06 * y * y);
  }
  // smooth across the curved face, keep the rim edge crisp
  return toCreasedNormals(geo, Math.PI / 4);
}

export function mountMask(el, { particles = true, interactive = true, dist = 9.4 } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (e) { return null; }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  el.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  cam.position.set(0, 0, dist);

  const rig = new THREE.Group(); scene.add(rig);

  // mask body
  const geo = new THREE.ExtrudeGeometry(maskShape(), {
    depth: 0.1, bevelEnabled: true, bevelThickness: 0.07, bevelSize: 0.05, bevelSegments: 8, curveSegments: 64,
  });
  geo.center();
  // split the big flat triangles so the bend becomes a smooth curve
  const body = bend(new TessellateModifier(0.07, 8).modify(geo), 0.22);
  const gold = new THREE.MeshPhysicalMaterial({ color: 0xd8ab58, metalness: 1, roughness: 0.26, clearcoat: 0.5, clearcoatRoughness: 0.2 });
  const mask = new THREE.Mesh(body, gold); rig.add(mask);

  // gem between the eyes
  const gem = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.13, 1),
    new THREE.MeshPhysicalMaterial({ color: 0xa3182f, metalness: 0.1, roughness: 0.05, clearcoat: 1, emissive: 0x3a0610 }),
  );
  const [gx, gy] = P(100, 44); gem.position.set(gx, gy, 0.22); gem.scale.set(1, 1.3, 0.7); rig.add(gem);

  // filigree beads along the brow
  const bead = new THREE.SphereGeometry(0.035, 16, 16);
  const beadMat = new THREE.MeshPhysicalMaterial({ color: 0xf6e3b0, metalness: 1, roughness: 0.15 });
  for (let i = 0; i <= 14; i++) {
    const t = i / 14, x = -1.55 + t * 3.1, y = 0.62 - Math.abs(x) * 0.05 + Math.sin(t * Math.PI) * 0.06;
    if (Math.abs(x) < 0.25) continue;
    const b = new THREE.Mesh(bead, beadMat); b.position.set(x, y, 0.2 - 0.22 * x * x); rig.add(b);
  }

  // silk ribbons trailing from the sides
  const ribMat = new THREE.MeshPhysicalMaterial({ color: 0x8e2b3a, roughness: 0.45, sheen: 1, sheenColor: 0xff8fa0, side: THREE.DoubleSide });
  const ribbons = [-1, 1].map((sd) => {
    const pts = [];
    for (let i = 0; i < 8; i++) pts.push(new THREE.Vector3(sd * (1.85 + i * 0.12), 0.45 - i * 0.32, -0.75 - i * 0.05));
    const curve = new THREE.CatmullRomCurve3(pts);
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, 80, 0.035, 8, false), ribMat);
    m.userData = { sd, base: pts.map((p) => p.clone()) };
    rig.add(m); return m;
  });

  // light
  const key = new THREE.DirectionalLight(0xfff1d6, 2.2); key.position.set(3, 4, 5); scene.add(key);
  const rim = new THREE.PointLight(0xc23a52, 30, 20); rim.position.set(-3, -1, -2); scene.add(rim);
  const fill = new THREE.PointLight(0xf3d58d, 12, 20); fill.position.set(2.5, -2, 3); scene.add(fill);

  // gold dust
  let dust;
  if (particles) {
    const n = 520, pos = new Float32Array(n * 3), sz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = 2.4 + Math.random() * 2.6, th = Math.random() * Math.PI * 2, ph = (Math.random() - 0.5) * 1.6;
      pos.set([Math.cos(th) * r, Math.sin(ph) * r * 0.6, Math.sin(th) * r - 1.5], i * 3); sz[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('size', new THREE.BufferAttribute(sz, 1));
    const m = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { t: { value: 0 }, px: { value: renderer.getPixelRatio() } },
      vertexShader: `attribute float size;uniform float t;uniform float px;varying float a;
        void main(){vec3 p=position;p.y+=sin(t*.6+position.x*1.7)*.12;vec4 mv=modelViewMatrix*vec4(p,1.);
        a=.35+.65*fract(size*7.+t*.15);gl_PointSize=(2.+size*5.)*px*(6./-mv.z);gl_Position=projectionMatrix*mv;}`,
      fragmentShader: `varying float a;void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;
        gl_FragColor=vec4(vec3(1.,.82,.48),smoothstep(.5,0.,d)*a*.8);}`,
    });
    dust = new THREE.Points(g, m); scene.add(dust);
  }

  // mouse
  const target = { x: 0, y: 0 }, cur = { x: 0, y: 0 };
  const onMove = (e) => { target.x = e.clientX / innerWidth - 0.5; target.y = e.clientY / innerHeight - 0.5; };
  if (interactive) addEventListener('pointermove', onMove);

  const size = () => {
    const w = el.clientWidth, h = el.clientHeight || w;
    renderer.setSize(w, h, false); renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%';
    cam.aspect = w / h; cam.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(size); ro.observe(el); size();

  let raf, t0 = performance.now();
  const frame = (now) => {
    const t = (now - t0) / 1000;
    cur.x += (target.x - cur.x) * 0.05; cur.y += (target.y - cur.y) * 0.05;
    rig.rotation.y = Math.sin(t * 0.45) * 0.32 + cur.x * 0.7;
    rig.rotation.x = -0.05 + cur.y * 0.35 + Math.sin(t * 0.7) * 0.03;
    rig.position.y = Math.sin(t * 0.9) * 0.08;
    gem.rotation.y = t * 0.8;
    ribbons.forEach((m) => {
      const pts = m.userData.base.map((p, i) => new THREE.Vector3(p.x + Math.sin(t * 1.6 + i * 0.7) * 0.05 * i, p.y, p.z + Math.cos(t * 1.3 + i * 0.6) * 0.07 * i));
      m.geometry.dispose(); m.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 80, 0.035, 8, false);
    });
    if (dust) { dust.rotation.y = t * 0.04; dust.material.uniforms.t.value = t; }
    renderer.render(scene, cam);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); removeEventListener('pointermove', onMove); renderer.dispose(); el.removeChild(renderer.domElement); },
  };
}
