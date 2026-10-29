/* SHAWA CEO — 3D view of a location.
   The scene (room layout from the real Mangal cafe photo, animated staff
   avatars walking their role routes, camera presets, click-to-pick) is
   ported from the verified «SHAWA — точки в 3D» prototype. Staff data comes
   from the CEO API (/api/locations/:id/scene): real employees of the
   location, or the demo roster the server flags as demo.
   Three.js r128 is lazy-loaded from CDN on first use, like Tesseract. */

const THREE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
let threePromise = null;
export function ensureThree() {
  if (window.THREE) return Promise.resolve(true);
  if (!threePromise) {
    threePromise = new Promise(resolve => {
      const script = document.createElement('script');
      script.src = THREE_CDN;
      script.onload = () => resolve(Boolean(window.THREE));
      script.onerror = () => resolve(false);
      document.head.appendChild(script);
    });
  }
  return threePromise;
}

export const SCENE_ROLE_META = {
  chef:     { title: 'Шеф-повар',      titleEn: 'Chef',          color: 0x2B2B2B, shirt: '#2B2B2B', hat: 'chef' },
  manager:  { title: 'Менеджер смены', titleEn: 'Shift manager', color: 0x2E4057, shirt: '#2E4057', hat: 'cap' },
  cashier:  { title: 'Кассир',         titleEn: 'Cashier',       color: 0xC05A2E, shirt: '#C05A2E', hat: 'cap' },
  grill:    { title: 'Повар гриля',    titleEn: 'Grill cook',    color: 0x4A4A48, shirt: '#4A4A48', hat: 'cap' },
  shawarma: { title: 'Повар шаурмы',   titleEn: 'Shawarma cook', color: 0x5D4037, shirt: '#5D4037', hat: 'cap' },
  helper:   { title: 'Помощник кухни', titleEn: 'Kitchen helper', color: 0x8A6D1F, shirt: '#B98A1D', hat: 'cap' },
  waiter:   { title: 'Официант',       titleEn: 'Waiter',        color: 0x1F1F1F, shirt: '#1F1F1F', hat: 'none' },
  cleaner:  { title: 'Уборщица',       titleEn: 'Cleaner',       color: 0x33666B, shirt: '#33666B', hat: 'none' }
};

/* Role routes inside the room layout (x: -10..10, z: kitchen -14 .. entrance +14) */
const ROUTES = {
  cashier:  [ { x: 1.2, z: -7.4 }, { x: 0.2, z: -7.6 }, { x: 1.8, z: -7.5 } ],
  chef:     [ { x: -3.4, z: -8.6 }, { x: -1.2, z: -7.2 }, { x: -5.2, z: -9.4 }, { x: -2.2, z: -10.6 } ],
  grill:    [ { x: -5.6, z: -10.8 }, { x: -4.2, z: -11.2 }, { x: -6.4, z: -9.8 } ],
  shawarma: [ { x: -0.8, z: -11.0 }, { x: 0.4, z: -10.6 }, { x: -1.6, z: -10.2 } ],
  helper:   [ { x: -7.6, z: -8.8 }, { x: -4.6, z: -7.4 }, { x: 2.6, z: -8.6 }, { x: -7.8, z: -3.4 }, { x: -4.6, z: -7.4 } ],
  waiter:   [ { x: 1.6, z: -5.2 }, { x: 5.6, z: -3.4 }, { x: 6.4, z: -6.8 }, { x: 5.8, z: 0.6 }, { x: 6.4, z: 3.2 }, { x: 5.6, z: 6.4 }, { x: 2.2, z: -1.2 }, { x: 1.6, z: -5.2 } ],
  cleaner:  [ { x: -3.4, z: 2.5 }, { x: 2.8, z: 4.5 }, { x: 4.2, z: -1.5 }, { x: -1.5, z: -3.2 }, { x: -5.5, z: 5.5 }, { x: 0.5, z: 9.5 }, { x: -3.4, z: 2.5 } ],
  manager:  [ { x: -0.5, z: -3.4 }, { x: 4.6, z: 2.2 }, { x: 1.2, z: 6.8 }, { x: -4.8, z: -1.2 }, { x: -0.5, z: -3.4 } ]
};
const CAMS = {
  hall:    { theta: 0.55, phi: 1.02, radius: 27 },
  top:     { theta: 0.55, phi: 0.25, radius: 30 },
  kitchen: { theta: 0.1, phi: 1.12, radius: 15 },
  tables:  { theta: -0.7, phi: 1.08, radius: 17 }
};

/* Fort Lauderdale — real proportions from the owner's LiDAR scan
   (Scaniverse, 2026-10-23; see goals/shawa-ceo/files/scans/fort-lauderdale/measurements.md).
   Re-measured 2026-10-23 by face-plane detection on the raw mesh (not density
   slices): storefront glass z +2.38, counter front face z -1.16 (entrance ->
   counter 3.54 m), back wall z -8.3, walls x -3.6/+3.65, counter top ~1.0,
   table tops y 0.79, soffit underside 3.16, ceiling ~5.1. Scale anchors
   (counter/table heights, 1.82 m double doors) read true — no Z distortion.
   Cameras sit INSIDE the room: the default 'hall' view stands at the entrance,
   so the open entrance -> counter zone reads at its true size. */
const FL_ROUTES = {
  cashier:  [ { x: 0.1, z: -2.25 }, { x: -0.6, z: -2.35 }, { x: 0.7, z: -2.3 } ],
  chef:     [ { x: -1.4, z: -4.2 }, { x: -0.5, z: -6.0 }, { x: -1.8, z: -7.2 }, { x: -0.7, z: -3.2 } ],
  grill:    [ { x: -0.55, z: -6.9 }, { x: -0.55, z: -5.7 }, { x: -0.6, z: -7.7 } ],
  shawarma: [ { x: 0.95, z: -7.3 }, { x: 0.9, z: -6.5 }, { x: 1.05, z: -7.85 } ],
  helper:   [ { x: -2.3, z: -3.2 }, { x: -0.9, z: -2.4 }, { x: 1.9, z: -4.4 }, { x: -2.35, z: -6.4 }, { x: -0.9, z: -2.4 } ],
  waiter:   [ { x: -0.3, z: -0.5 }, { x: 2.0, z: -5.6 }, { x: 2.0, z: -2.5 }, { x: 2.0, z: 0.5 }, { x: 2.0, z: 1.7 }, { x: -0.3, z: -0.5 } ],
  cleaner:  [ { x: -1.6, z: 1.3 }, { x: 1.2, z: -0.7 }, { x: -2.0, z: -3.4 }, { x: 1.8, z: 0.7 }, { x: -0.8, z: 1.8 }, { x: -1.6, z: 1.3 } ],
  manager:  [ { x: 0.4, z: -0.2 }, { x: 2.0, z: 1.2 }, { x: -1.6, z: -2.6 }, { x: 1.1, z: -5.2 }, { x: 0.4, z: -0.2 } ]
};
const FL_CAMS = {
  hall:    { theta: 0.378, phi: 1.253, radius: 7.7 },
  top:     { theta: 0.35, phi: 0.32, radius: 14.5 },
  kitchen: { theta: 0.036, phi: 1.293, radius: 5.83 },
  tables:  { theta: -0.407, phi: 1.324, radius: 5.73 }
};
const FL_TARGET = { hall: [-0.5, 0.7, -4.6], top: [0, 0.3, -2.95], kitchen: [0.2, 0.6, -6.2], tables: [2.2, 0.6, -3.2] };

export function mountScene3D(holder, { lang = 'ru', onPick = () => {}, layout = 'generic' } = {}) {
  const noop = { setStaff() {}, spawn() {}, remove() {}, highlight() {}, setCam() {}, destroy() {} };
  if (!window.THREE) {
    holder.innerHTML = `<div class="s3-gl-fail">${lang === 'en' ? 'Could not load the 3D engine.<br>Check your connection and reload the page.' : 'Не удалось загрузить 3D-движок.<br>Проверьте интернет и откройте страницу ещё раз.'}</div>`;
    return noop;
  }
  const THREE = window.THREE;
  const isFL = layout === 'fort-lauderdale';
  const L_ROUTES = isFL ? FL_ROUTES : ROUTES;
  const L_CAMS = isFL ? FL_CAMS : CAMS;
  const L_ENTRANCE = isFL ? { x: 0.4, z: 1.95 } : { x: 0, z: 13.2 };
  const L_HOME_TARGET = isFL ? FL_TARGET.hall : [0, 0.6, -1.5];
  const R_MIN = isFL ? 3.5 : 11, R_MAX = isFL ? 30 : 42;
  const roleTitle = (role) => {
    const meta = SCENE_ROLE_META[role] || SCENE_ROLE_META.helper;
    return lang === 'en' ? meta.titleEn : meta.title;
  };

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  holder.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1B1510);
  scene.fog = new THREE.Fog(0x1B1510, 40, 78);
  const camera = new THREE.PerspectiveCamera(isFL ? 52 : 46, 1, 0.1, 200);
  const camTarget = new THREE.Vector3(L_HOME_TARGET[0], L_HOME_TARGET[1], L_HOME_TARGET[2]);
  let camTheta = L_CAMS.hall.theta, camPhi = L_CAMS.hall.phi, camRadius = L_CAMS.hall.radius;
  let camGoal = { theta: camTheta, phi: camPhi, radius: camRadius, tx: L_HOME_TARGET[0], ty: L_HOME_TARGET[1], tz: L_HOME_TARGET[2] };

  scene.add(new THREE.HemisphereLight(0xFFF2DC, 0x3A2A1A, 0.85));
  const sun = new THREE.DirectionalLight(0xFFE7C0, 0.75); sun.position.set(8, 14, 8); scene.add(sun);
  const warm = new THREE.PointLight(0xFFB45E, 0.9, 30); warm.position.set(0, 4.6, -6); scene.add(warm);
  const warm2 = new THREE.PointLight(0xFFC98A, 0.55, 24); warm2.position.set(6, 4.4, 3); scene.add(warm2);

  let spitMesh = null;
  const staffGroup = new THREE.Group();
  const selRing = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.72, 28),
    new THREE.MeshBasicMaterial({ color: 0xFFC94D, side: THREE.DoubleSide, transparent: true, opacity: 0.95 }));
  selRing.rotation.x = -Math.PI / 2; selRing.position.y = 0.03; selRing.visible = false;

  function makeCanvas(w, h, draw) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    return new THREE.CanvasTexture(c);
  }
  function woodTexture() {
    const t = makeCanvas(512, 512, (g) => {
      g.fillStyle = '#C9B08C'; g.fillRect(0, 0, 512, 512);
      const rows = 8;
      for (let i = 0; i < rows; i++) {
        const y = i * 64, shade = ['#CDB693', '#C2A67F', '#D3BC9A', '#BEA37E'][i % 4];
        g.fillStyle = shade; g.fillRect(0, y, 512, 62);
        g.strokeStyle = 'rgba(90,60,30,.35)'; g.lineWidth = 2; g.strokeRect(-2, y, 516, 64);
        g.strokeStyle = 'rgba(120,85,45,.18)'; g.lineWidth = 1;
        for (let k = 0; k < 5; k++) { const gy = y + 8 + k * 12 + ((i * 7 + k * 13) % 7); g.beginPath(); g.moveTo(0, gy); g.bezierCurveTo(150, gy + 3, 330, gy - 3, 512, gy + 2); g.stroke(); }
        g.fillStyle = 'rgba(90,60,30,.35)'; g.fillRect((i * 173) % 512, y, 2, 64);
      }
    });
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 4); return t;
  }
  function ribTexture() {
    const t = makeCanvas(256, 128, (g) => {
      g.fillStyle = '#F3EAD3'; g.fillRect(0, 0, 256, 128);
      for (let x = 0; x < 256; x += 10) { g.fillStyle = 'rgba(140,110,70,.28)'; g.fillRect(x, 0, 2, 128); }
      const gr = g.createLinearGradient(0, 90, 0, 128); gr.addColorStop(0, 'rgba(255,190,90,0)'); gr.addColorStop(1, 'rgba(255,170,60,.45)');
      g.fillStyle = gr; g.fillRect(0, 0, 256, 128);
    });
    t.wrapS = THREE.RepeatWrapping; t.repeat.set(6, 1); return t;
  }
  function wallMangTexture() {
    return makeCanvas(1024, 320, (g) => {
      g.fillStyle = '#4A382A'; g.fillRect(0, 0, 1024, 320);
      for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(${140 + Math.random() * 60 | 0},${100 + Math.random() * 40 | 0},70,${Math.random() * .14})`; g.fillRect(Math.random() * 1024, Math.random() * 320, 3, 3); }
      g.font = '900 128px Arial'; g.textAlign = 'center';
      g.fillStyle = 'rgba(0,0,0,.35)'; g.fillText('MANGAL', 515, 182);
      g.fillStyle = '#E8C586'; g.fillText('MANGAL', 512, 178);
      g.font = '700 30px Arial'; g.fillStyle = '#D8C6A4';
      g.fillText('C H A R C O A L   ·   M E D I T E R R A N E A N   G R I L L', 512, 248);
    });
  }
  function screenTexture(title, sub, c1, c2) {
    return makeCanvas(256, 160, (g) => {
      const gr = g.createLinearGradient(0, 0, 256, 160); gr.addColorStop(0, c1); gr.addColorStop(1, c2);
      g.fillStyle = gr; g.fillRect(0, 0, 256, 160);
      g.fillStyle = 'rgba(255,255,255,.16)';
      g.beginPath(); g.ellipse(70, 60, 52, 38, 0.4, 0, 7); g.fill();
      g.beginPath(); g.ellipse(185, 95, 60, 42, -0.3, 0, 7); g.fill();
      g.fillStyle = 'rgba(20,12,6,.78)'; g.fillRect(0, 106, 256, 54);
      g.fillStyle = '#FFE9C4'; g.font = '900 26px Arial'; g.textAlign = 'center'; g.fillText(title, 128, 140);
      g.fillStyle = '#F5EAD2'; g.font = '700 13px Arial'; g.fillText(sub, 128, 122);
    });
  }
  function mat(color, rough) { return new THREE.MeshStandardMaterial({ color, roughness: rough == null ? 0.9 : rough, metalness: 0.02 }); }
  function box(w, h, d, color, x, y, z, material) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material || mat(color));
    m.position.set(x, y, z); return m;
  }

  function buildRoom() {
    const g = new THREE.Group(); scene.add(g);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(21, 29), new THREE.MeshStandardMaterial({ map: woodTexture(), roughness: 0.85 }));
    floor.rotation.x = -Math.PI / 2; g.add(floor);
    g.add(box(5.4, 0.04, 2.4, 0x232323, 0, 0.02, 12.6));
    const back = new THREE.Mesh(new THREE.PlaneGeometry(21, 6.4), new THREE.MeshStandardMaterial({ map: wallMangTexture(), roughness: 0.95 }));
    back.position.set(0, 3.2, -14.5); g.add(back);
    const left = new THREE.Mesh(new THREE.PlaneGeometry(29, 6.4), mat(0xE9E2D2));
    left.rotation.y = Math.PI / 2; left.position.set(-10.5, 3.2, 0); g.add(left);
    const right = new THREE.Mesh(new THREE.PlaneGeometry(29, 6.4), mat(0x7A4B32));
    right.rotation.y = -Math.PI / 2; right.position.set(10.5, 3.2, 0); g.add(right);
    const front = new THREE.Mesh(new THREE.PlaneGeometry(21, 6.4), mat(0x2A241C));
    front.rotation.y = Math.PI; front.position.set(0, 3.2, 14.5); g.add(front);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(21, 29), mat(0x191512));
    ceil.rotation.x = Math.PI / 2; ceil.position.y = 6.4; g.add(ceil);
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x9FB6BD, roughness: 0.15, metalness: 0.4, transparent: true, opacity: 0.5 });
    const d1 = new THREE.Mesh(new THREE.BoxGeometry(1.7, 3.4, 0.12), doorMat); d1.position.set(-0.95, 1.7, 14.42); g.add(d1);
    const d2 = d1.clone(); d2.position.x = 0.95; g.add(d2);
    g.add(box(4.2, 0.28, 0.3, 0xC8C8C8, 0, 3.55, 14.42));

    /* L-shaped counter, light wood */
    const ribMat = new THREE.MeshStandardMaterial({ map: ribTexture(), roughness: 0.8 });
    const topMat = mat(0xD9B98A, 0.5);
    const c1 = new THREE.Mesh(new THREE.BoxGeometry(11.4, 1.12, 1.25), ribMat); c1.position.set(-3.6, 0.56, -6); g.add(c1);
    g.add(box(11.7, 0.09, 1.5, 0, -3.6, 1.16, -6, topMat));
    const c2 = new THREE.Mesh(new THREE.BoxGeometry(1.25, 1.12, 9.2), ribMat); c2.position.set(-9.2, 0.56, -1.6); g.add(c2);
    g.add(box(1.5, 0.09, 9.5, 0, -9.2, 1.16, -1.6, topMat));
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xCDE6EA, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.35 });
    [[-6.4, -6], [-3.4, -6], [0.6, -6]].forEach(p => {
      const v = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.55, 0.8), glassMat); v.position.set(p[0], 1.5, p[1]); g.add(v);
    });
    /* till */
    g.add(box(0.62, 0.14, 0.5, 0xEDEDED, 1.3, 1.28, -6.1));
    const tillScr = box(0.66, 0.46, 0.05, 0x222831, 1.3, 1.62, -6.32); tillScr.rotation.x = -0.16; g.add(tillScr);
    const tillGlow = box(0.58, 0.38, 0.02, 0x7FD4A8, 1.3, 1.62, -6.29); tillGlow.rotation.x = -0.16; g.add(tillGlow);
    /* pass */
    g.add(box(3.4, 0.06, 0.7, 0xB9BDC2, -0.6, 1.62, -6.7, mat(0xB9BDC2, 0.35)));
    [-2.1, -0.6, 0.9].forEach(x => { g.add(box(0.05, 0.42, 0.05, 0x8A8F94, x, 1.4, -6.7)); });

    /* fridge display by the entrance */
    const fridge = new THREE.Group(); fridge.position.set(-9.15, 0, 3.6); g.add(fridge);
    fridge.add(box(1.35, 2.15, 2.6, 0xD98E4A, 0, 1.07, 0));
    const fglass = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.5, 2.3), glassMat); fglass.position.set(0.7, 1.3, 0); fridge.add(fglass);
    for (let fi = 0; fi < 3; fi++) fridge.add(box(0.5, 0.05, 2.2, 0xFFFFFF, 0.35, 0.6 + fi * 0.5, 0));
    const fSign = makeCanvas(128, 256, (g2) => {
      g2.fillStyle = '#20242A'; g2.fillRect(0, 0, 128, 256);
      g2.save(); g2.translate(64, 128); g2.rotate(-Math.PI / 2); g2.fillStyle = '#F3C87E';
      g2.font = '900 44px Arial'; g2.textAlign = 'center'; g2.fillText('MANGAL', 0, 14); g2.restore();
    });
    const fPlane = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.15), new THREE.MeshBasicMaterial({ map: fSign }));
    fPlane.rotation.y = Math.PI / 2; fPlane.rotation.z = Math.PI / 2; fPlane.position.set(0.72, 1.05, 0); fridge.add(fPlane);

    /* open kitchen behind the counter */
    g.add(box(12.6, 0.1, 0.9, 0x3C3F45, -3.4, 3.1, -11.6));
    g.add(box(2.6, 1.5, 0.7, 0x565B63, -3.4, 2.2, -12.4, mat(0x565B63, 0.4)));
    g.add(box(3.0, 0.95, 1.3, 0x33363B, -5.2, 0.48, -11.6, mat(0x33363B, 0.5)));
    g.add(box(2.7, 0.1, 1.0, 0xFF6A22, -5.2, 1.0, -11.6, new THREE.MeshBasicMaterial({ color: 0xE85A17 })));
    for (let si = 0; si < 5; si++) {
      const sk = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.15, 6), mat(0xC8C8C8, 0.3));
      sk.rotation.z = Math.PI / 2; sk.rotation.y = 0.25; sk.position.set(-5.2, 1.12, -12.0 + si * 0.22); g.add(sk);
      g.add(box(0.55, 0.16, 0.16, 0x9A5A30, -5.2, 1.12, -12.0 + si * 0.22));
    }
    /* rotating shawarma spit */
    spitMesh = new THREE.Group(); spitMesh.position.set(-0.7, 0, -11.4); g.add(spitMesh);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.3, 8), mat(0xB9BDC2, 0.3)); pole.position.y = 1.15; spitMesh.add(pole);
    const meatCone = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.5, 1.5, 12), mat(0xA05A28, 0.95)); meatCone.position.y = 1.25; spitMesh.add(meatCone);
    g.add(box(1.1, 0.85, 1.0, 0x44484F, -0.7, 0.42, -11.4, mat(0x44484F, 0.5)));
    g.add(box(0.16, 1.5, 0.7, 0xFF7A2E, -1.45, 1.3, -11.4, new THREE.MeshBasicMaterial({ color: 0xD8541E })));
    g.add(box(2.6, 0.9, 1.1, 0x9BA0A6, -8.6, 0.45, -11.4, mat(0x9BA0A6, 0.35)));
    g.add(box(3.2, 0.08, 1.0, 0xC9CDD2, 2.2, 0.92, -10.6, mat(0xC9CDD2, 0.3)));
    g.add(box(3.2, 0.85, 0.95, 0x7C8187, 2.2, 0.43, -10.6));
    for (let sh = 0; sh < 3; sh++) g.add(box(2.2, 0.06, 0.7, 0x6E6A61, 4.6, 0.8 + sh * 0.62, -13.6));
    [0.8, 1.42, 2.04].forEach(y => { [-0.6, 0.1, 0.7].forEach(dx => { g.add(box(0.42, 0.34, 0.5, 0xC8A165, 4.6 + dx, y + 0.2, -13.6)); }); });

    /* menu screens above the counter */
    const screens = [
      ['SHAWARMA', 'курица · говядина · люля', '#7A2E14', '#C05A2E'],
      ['KEBABS', 'большие тарелки', '#31435C', '#7A94B8'],
      ['LULA', 'кубиде · люля-кебаб', '#5C4314', '#C9973F'],
      ['PLATES', 'рис · салаты · соусы', '#2E4A2A', '#6FA05E'],
      ['МЕНЮ', 'цены и составы', '#3A3A3A', '#8A8A8A']
    ];
    screens.forEach((sc, i) => {
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(2.25, 1.4), new THREE.MeshBasicMaterial({ map: screenTexture(sc[0], sc[1], sc[2], sc[3]) }));
      scr.position.set(-7.4 + i * 2.5, 3.35, -6.9); g.add(scr);
      g.add(box(2.35, 1.5, 0.07, 0x111111, -7.4 + i * 2.5, 3.35, -6.96));
    });

    /* tables, chairs and rust banquettes along the right wall */
    [-7.5, -4, -0.5, 3, 6.5, 10].forEach(z => {
      g.add(box(0.14, 2.6, 1.05, 0xC05A2E, 9.75, 1.3, z));
      g.add(box(0.55, 0.5, 2.6, 0xB45327, 9.45, 0.25, z));
      g.add(box(1.5, 0.08, 1.05, 0x6E4A2C, 8.35, 0.78, z, mat(0x6E4A2C, 0.45)));
      g.add(box(0.12, 0.75, 0.12, 0x2B2B2B, 8.35, 0.38, z));
      [-0.42, 0.42].forEach(dz => {
        g.add(box(0.5, 0.06, 0.5, 0xD9C29A, 7.45, 0.5, z + dz));
        g.add(box(0.5, 0.55, 0.06, 0x8A6A42, 7.24, 0.82, z + dz));
        g.add(box(0.06, 0.5, 0.06, 0x2B2B2B, 7.3, 0.25, z + dz - 0.18));
        g.add(box(0.06, 0.5, 0.06, 0x2B2B2B, 7.3, 0.25, z + dz + 0.18));
      });
    });
    addGuest(g, 8.9, -4, 0x3E5C48); addGuest(g, 8.9, 3, 0x54486E); addGuest(g, 7.5, -0.5, 0x74553A);

    /* hanging greenery and dome lights */
    [[-7, -4], [-2, -9], [3, -2], [7, -7], [-5, 4], [4, 6], [0, 10], [-8, 9], [8, 1]].forEach((p, i) => {
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.1, 5), mat(0x222222));
      stem.position.set(p[0], 5.85, p[1]); g.add(stem);
      for (let b = 0; b < 5; b++) {
        const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.42 + ((i + b) % 3) * 0.13, 0), mat([0x3F7031, 0x4C8440, 0x356026][(i + b) % 3], 1));
        blob.position.set(p[0] + Math.sin(b * 2.4) * 0.42, 5.15 - Math.abs(Math.cos(b * 1.7)) * 0.35, p[1] + Math.cos(b * 2.1) * 0.42);
        g.add(blob);
      }
      const vine = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.02, 1.15, 5), mat(0x3F7031, 1));
      vine.position.set(p[0] + 0.3, 4.6, p[1] - 0.2); g.add(vine);
    });
    [[-4, -6.5], [2.5, -3], [6.5, 4], [-1.5, 3.5], [-7.5, 7.5]].forEach(p => {
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.5, 5), mat(0x111111));
      cord.position.set(p[0], 5.65, p[1]); g.add(cord);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.52, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x17181A, 0.4));
      dome.rotation.x = Math.PI; dome.position.set(p[0], 5.05, p[1]); g.add(dome);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), new THREE.MeshBasicMaterial({ color: 0xFFD9A0 }));
      bulb.position.set(p[0], 4.82, p[1]); g.add(bulb);
    });
  }
  /* Fort Lauderdale room — re-measured from the LiDAR scan by face planes
     (meters, see FL_ROUTES note). Hall 7.3 wide (x -3.65..3.65) x 10.7 deep
     (back wall z -8.3, storefront z +2.4), ceiling 5.2, soffit underside 3.16
     with its front at z -1.82, L-counter along the left wall + front leg with
     its face at z -1.16, display-case run continuing along the left wall to
     the entrance, 7 tables with banquettes along the right wall. */
  function buildRoomFL() {
    const g = new THREE.Group(); scene.add(g);
    const floorTex = woodTexture(); floorTex.repeat.set(2, 3);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(7.3, 10.7), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.85 }));
    floor.rotation.x = -Math.PI / 2; floor.position.set(0, 0, -2.95); g.add(floor);
    /* entrance mat just inside the double doors */
    g.add(box(1.8, 0.03, 0.95, 0x232323, 0.4, 0.015, 1.85));
    /* walls */
    const back = new THREE.Mesh(new THREE.PlaneGeometry(7.3, 5.2), new THREE.MeshStandardMaterial({ map: wallMangTexture(), roughness: 0.95 }));
    back.position.set(0, 2.6, -8.3); g.add(back);
    /* service doorway in the back wall (right side, from the photos) */
    g.add(box(1.0, 2.2, 0.05, 0x14100C, 2.3, 1.1, -8.27));
    const left = new THREE.Mesh(new THREE.PlaneGeometry(10.7, 5.2), mat(0xE9E2D2));
    left.rotation.y = Math.PI / 2; left.position.set(-3.65, 2.6, -2.95); g.add(left);
    const right = new THREE.Mesh(new THREE.PlaneGeometry(10.7, 5.2), mat(0x7A4B32));
    right.rotation.y = -Math.PI / 2; right.position.set(3.65, 2.6, -2.95); g.add(right);
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(7.3, 10.7), mat(0x191512));
    ceil.rotation.x = Math.PI / 2; ceil.position.set(0, 5.2, -2.95); g.add(ceil);
    /* glass storefront at z +2.4 (scan plane +2.38): mullions at x -2.15 and
       -0.52, double doors x -0.52..+1.30 (two 0.91 m leaves, head at y 2.2),
       one wide pane to the right corner */
    const glassMat = new THREE.MeshStandardMaterial({ color: 0xCDE6EA, roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.32 });
    const frameMat = mat(0xC8C8C8, 0.4);
    [[-2.9, 1.5], [-1.34, 1.62], [2.48, 2.35]].forEach(seg => {
      const pane = new THREE.Mesh(new THREE.BoxGeometry(seg[1], 3.35, 0.08), glassMat);
      pane.position.set(seg[0], 1.675, 2.4); g.add(pane);
    });
    [-0.065, 0.845].forEach(dx => {
      const leaf = new THREE.Mesh(new THREE.BoxGeometry(0.91, 2.2, 0.08), glassMat);
      leaf.position.set(dx, 1.1, 2.4); g.add(leaf);
    });
    const transom = new THREE.Mesh(new THREE.BoxGeometry(1.82, 1.15, 0.08), glassMat);
    transom.position.set(0.39, 2.775, 2.4); g.add(transom);
    [-3.65, -2.15, -0.52, 1.3, 3.65].forEach(fx => { g.add(box(0.08, 3.35, 0.12, 0, fx, 1.675, 2.4, frameMat)); });
    g.add(box(0.06, 2.2, 0.12, 0, 0.39, 1.1, 2.4, frameMat));
    g.add(box(1.9, 0.09, 0.14, 0, 0.39, 2.24, 2.4, frameMat));
    [0.28, 0.5].forEach(hx => {
      const pull = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.5, 6), mat(0x9A9A9A, 0.3));
      pull.position.set(hx, 1.05, 2.48); g.add(pull);
    });
    g.add(box(7.3, 0.22, 0.24, 0, 0, 3.42, 2.4, frameMat));
    g.add(box(7.3, 1.75, 0.24, 0x2A241C, 0, 4.28, 2.4));
    /* soffit over kitchen + counter zone: underside y 3.16, front edge z -1.82 */
    g.add(box(7.3, 0.18, 6.48, 0x241C14, 0, 3.22, -5.06));
    g.add(box(6.9, 0.06, 0.3, 0xFFC98A, 0, 3.1, -1.88, new THREE.MeshBasicMaterial({ color: 0xFFC98A })));

    /* L-shaped counter (scan planes): left leg front face x -2.68, runs
       z -8.3..-1.2; front leg face z -1.16, runs x -3.35..+0.50; tops ~1.02 */
    const ribMat = new THREE.MeshStandardMaterial({ map: ribTexture(), roughness: 0.8 });
    const topMat = mat(0xD9B98A, 0.5);
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.67, 1.02, 7.1), ribMat); legL.position.set(-3.01, 0.51, -4.75); g.add(legL);
    g.add(box(0.82, 0.06, 7.25, 0, -3.01, 1.05, -4.75, topMat));
    const legF = new THREE.Mesh(new THREE.BoxGeometry(3.85, 1.02, 0.7), ribMat); legF.position.set(-1.43, 0.51, -1.51); g.add(legF);
    g.add(box(4.0, 0.06, 0.85, 0, -1.43, 1.05, -1.51, topMat));
    [[-6.6], [-4.9], [-3.2]].forEach(p => {
      const v = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 1.3), glassMat); v.position.set(-3.0, 1.33, p[0]); g.add(v);
    });
    [[-2.4], [-0.9]].forEach(p => {
      const v = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.5, 0.5), glassMat); v.position.set(p[0], 1.33, -1.5); g.add(v);
    });
    /* fireplace insert in the front face (from the photos) */
    g.add(box(1.0, 0.38, 0.05, 0x1A1512, 0.55, 0.42, -1.14));
    g.add(box(0.85, 0.22, 0.02, 0xE8762C, 0.55, 0.42, -1.11, new THREE.MeshBasicMaterial({ color: 0xC05A2E })));
    /* till on the front leg */
    g.add(box(0.5, 0.12, 0.4, 0xEDEDED, 0.2, 1.14, -1.55));
    const tillScr = box(0.52, 0.38, 0.04, 0x222831, 0.2, 1.41, -1.72); tillScr.rotation.x = -0.16; g.add(tillScr);
    const tillGlow = box(0.45, 0.31, 0.02, 0x7FD4A8, 0.2, 1.41, -1.69); tillGlow.rotation.x = -0.16; g.add(tillGlow);
    /* pass shelf on the staff side of the front leg */
    g.add(box(1.8, 0.05, 0.4, 0xB9BDC2, -0.7, 1.3, -2.1, mat(0xB9BDC2, 0.35)));
    [-1.4, -0.7, 0.0].forEach(x => { g.add(box(0.04, 0.3, 0.04, 0x8A8F94, x, 1.15, -2.1)); });
    /* display-case run continuing along the left wall to the entrance
       (scan: glass guards z -1.37..+1.84 at x ~-2.9, low top ~0.88) */
    g.add(box(0.65, 0.89, 3.1, 0xE9E2D2, -3.28, 0.445, 0.35, ribMat));
    const caseGlass = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 3.0), glassMat); caseGlass.position.set(-3.3, 1.14, 0.35); g.add(caseGlass);
    g.add(box(0.67, 0.95, 0.06, 0xC97A2E, -3.28, 0.48, 1.93));

    /* open kitchen behind the front counter */
    g.add(box(5.6, 0.1, 0.7, 0x3C3F45, 0.2, 3.05, -8.05));
    g.add(box(1.6, 1.3, 0.6, 0x565B63, 0.2, 2.25, -8.1, mat(0x565B63, 0.4)));
    /* grill line (equipment line 1 of the scan, x ~ +0.1) */
    g.add(box(0.9, 0.95, 3.4, 0x33363B, 0.1, 0.48, -6.6, mat(0x33363B, 0.5)));
    g.add(box(0.95, 0.08, 3.2, 0xFF6A22, 0.1, 0.99, -6.6, new THREE.MeshBasicMaterial({ color: 0xE85A17 })));
    for (let si = 0; si < 5; si++) {
      const sk = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6), mat(0xC8C8C8, 0.3));
      sk.rotation.x = Math.PI / 2; sk.position.set(0.1, 1.1, -7.7 + si * 0.55); g.add(sk);
      g.add(box(0.14, 0.14, 0.5, 0x9A5A30, 0.1, 1.1, -7.7 + si * 0.55));
    }
    /* rotating shawarma spit (equipment line 2 of the scan, x ~ +1.6) */
    spitMesh = new THREE.Group(); spitMesh.position.set(1.6, 0, -7.6); g.add(spitMesh);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.0, 8), mat(0xB9BDC2, 0.3)); pole.position.y = 1.0; spitMesh.add(pole);
    const meatCone = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.42, 1.3, 12), mat(0xA05A28, 0.95)); meatCone.position.y = 1.1; spitMesh.add(meatCone);
    g.add(box(0.9, 0.8, 0.85, 0x44484F, 1.6, 0.4, -7.6, mat(0x44484F, 0.5)));
    g.add(box(0.13, 1.3, 0.6, 0xFF7A2E, 0.98, 1.15, -7.6, new THREE.MeshBasicMaterial({ color: 0xD8541E })));
    /* prep tables + back shelves */
    g.add(box(0.8, 0.85, 2.6, 0x7C8187, 2.9, 0.43, -6.2));
    g.add(box(0.9, 0.07, 2.7, 0xC9CDD2, 2.9, 0.9, -6.2, mat(0xC9CDD2, 0.3)));
    for (let sh = 0; sh < 3; sh++) g.add(box(2.2, 0.06, 0.6, 0x6E6A61, -1.8, 0.9 + sh * 0.6, -8.05));
    [1.0, 1.6, 2.2].forEach(y => { [-2.3, -1.8, -1.3].forEach(dx => { g.add(box(0.36, 0.3, 0.42, 0xC8A165, dx, y + 0.18, -8.05)); }); });

    /* menu screens on the soffit front above the counter */
    const screens = [
      ['SHAWARMA', 'курица · говядина', '#7A2E14', '#C05A2E'],
      ['KEBABS', 'большие тарелки', '#31435C', '#7A94B8'],
      ['LULA', 'кубиде · люля-кебаб', '#5C4314', '#C9973F'],
      ['МЕНЮ', 'цены и составы', '#3A3A3A', '#8A8A8A']
    ];
    screens.forEach((sc, i) => {
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(1.55, 0.97), new THREE.MeshBasicMaterial({ map: screenTexture(sc[0], sc[1], sc[2], sc[3]) }));
      scr.position.set(-2.75 + i * 1.72, 2.6, -1.79); g.add(scr);
      g.add(box(1.62, 1.04, 0.06, 0x111111, -2.75 + i * 1.72, 2.6, -1.83));
    });

    /* tables + rust banquettes along the right wall — 7 tables, ~1.55 m pitch.
       Scan: front three top clusters at z -1.11 / +0.62 / +2.12, tops y 0.79,
       footprint ~0.75 (x) x ~1.1 (z, long side along the wall). */
    [2.12, 0.57, -0.98, -2.53, -4.08, -5.63, -7.18].forEach(z => {
      g.add(box(0.55, 0.5, 1.15, 0xB45327, 3.32, 0.25, z));
      g.add(box(0.14, 0.85, 1.15, 0xC05A2E, 3.56, 0.9, z));
      g.add(box(0.8, 0.07, 1.05, 0x6E4A2C, 2.95, 0.755, z, mat(0x6E4A2C, 0.45)));
      g.add(box(0.1, 0.72, 0.1, 0x2B2B2B, 2.95, 0.36, z));
      [-0.28, 0.28].forEach(dz => {
        g.add(box(0.45, 0.05, 0.45, 0xD9C29A, 2.3, 0.48, z + dz));
        g.add(box(0.45, 0.5, 0.05, 0x8A6A42, 2.1, 0.78, z + dz));
        g.add(box(0.05, 0.46, 0.05, 0x2B2B2B, 2.32, 0.23, z + dz - 0.16));
        g.add(box(0.05, 0.46, 0.05, 0x2B2B2B, 2.32, 0.23, z + dz + 0.16));
      });
    });
    addGuest(g, 3.05, -0.98, 0x3E5C48); addGuest(g, 3.05, 2.12, 0x54486E); addGuest(g, 3.05, -5.63, 0x74553A);

    /* hanging greenery and dome lights (below the 5.2 m ceiling) */
    [[-2.2, -0.6], [1.8, -4.6], [-1.8, 1.8], [2.4, 0.8], [0.2, -6.8]].forEach((p, i) => {
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.0, 5), mat(0x222222));
      stem.position.set(p[0], 4.7, p[1]); g.add(stem);
      for (let b = 0; b < 5; b++) {
        const blob = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3 + ((i + b) % 3) * 0.09, 0), mat([0x3F7031, 0x4C8440, 0x356026][(i + b) % 3], 1));
        blob.position.set(p[0] + Math.sin(b * 2.4) * 0.3, 4.05 - Math.abs(Math.cos(b * 1.7)) * 0.25, p[1] + Math.cos(b * 2.1) * 0.3);
        g.add(blob);
      }
    });
    [[-1.2, -4.2], [2.2, -1.6], [-0.6, 1.2], [1.4, -7.2]].forEach(p => {
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1.2, 5), mat(0x111111));
      cord.position.set(p[0], 4.6, p[1]); g.add(cord);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.38, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x17181A, 0.4));
      dome.rotation.x = Math.PI; dome.position.set(p[0], 4.05, p[1]); g.add(dome);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color: 0xFFD9A0 }));
      bulb.position.set(p[0], 3.88, p[1]); g.add(bulb);
    });
  }
  function addGuest(g, x, z, color) {
    const grp = new THREE.Group(); grp.position.set(x, 0, z); grp.rotation.y = -Math.PI / 2; g.add(grp);
    grp.add(box(0.52, 0.5, 0.52, color, 0, 0.72, 0));
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 12, 10), mat(0xD9A37E, 0.7)); head.position.y = 1.32; grp.add(head);
    grp.add(box(0.5, 0.42, 0.3, 0x3A3A3A, 0, 0.22, 0));
  }

  /* ---------- people ---------- */
  function labelSprite(text, colorCss) {
    const c = document.createElement('canvas'); c.width = 256; c.height = 64;
    const g = c.getContext('2d');
    g.fillStyle = 'rgba(18,14,9,.82)';
    g.beginPath();
    if (g.roundRect) { g.roundRect(28, 8, 200, 46, 23); } else { g.rect(28, 8, 200, 46); }
    g.fill();
    g.fillStyle = colorCss; g.beginPath(); g.arc(52, 31, 9, 0, 7); g.fill();
    g.fillStyle = '#FFF6E2'; g.font = '700 25px Arial'; g.textAlign = 'center';
    g.fillText(text, 140, 40);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
    sp.scale.set(2.1, 0.52, 1); sp.position.y = 2.28; return sp;
  }
  function createPerson(person) {
    const r = SCENE_ROLE_META[person.role] || SCENE_ROLE_META.helper;
    const grp = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: r.color, roughness: 0.9 });
    const pantsMat = mat(0x2E2A26, 0.95);
    const skinMat = mat(0xD9A37E, 0.65);
    function limb(w, h, d, material, px, py) {
      const pivot = new THREE.Group(); pivot.position.set(px, py, 0);
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); m.position.y = -h / 2; pivot.add(m);
      grp.add(pivot); return pivot;
    }
    const legL = limb(0.17, 0.78, 0.19, pantsMat, -0.12, 0.8);
    const legR = limb(0.17, 0.78, 0.19, pantsMat, 0.12, 0.8);
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.66, 0.32), bodyMat); torso.position.y = 1.13; grp.add(torso);
    if (['chef', 'grill', 'shawarma', 'waiter', 'helper'].includes(person.role)) {
      grp.add(box(0.46, 0.52, 0.03, 0xF1E7D0, 0, 1.06, 0.18));
    }
    const armL = limb(0.13, 0.62, 0.15, bodyMat, -0.36, 1.42);
    const armR = limb(0.13, 0.62, 0.15, bodyMat, 0.36, 1.42);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.21, 14, 12), skinMat); head.position.y = 1.68; grp.add(head);
    if (r.hat === 'chef') {
      const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.3, 12), mat(0xFFFFFF, 0.8)); hat.position.y = 1.92; grp.add(hat);
      const hatTop = new THREE.Mesh(new THREE.SphereGeometry(0.23, 12, 8), mat(0xFFFFFF, 0.8)); hatTop.position.y = 2.05; grp.add(hatTop);
    } else if (r.hat === 'cap') {
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.215, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(0x1E1E1E, 0.8)); cap.position.y = 1.72; grp.add(cap);
      grp.add(box(0.3, 0.04, 0.22, 0x1E1E1E, 0, 1.74, 0.26));
    }
    if (person.role === 'waiter') {
      const tray = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.03, 14), mat(0xC8C8C8, 0.3));
      tray.position.set(0.1, -0.66, 0.12); armR.add(tray);
      armR.add(box(0.09, 0.14, 0.09, 0xFFFFFF, 0.08, -0.74, 0.12));
      armR.rotation.x = -1.25;
    }
    if (person.role === 'cleaner') {
      const mop = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.25, 6), mat(0x8A6A42, 0.8));
      mop.position.set(0.1, -0.5, 0.25); mop.rotation.x = 0.5; armR.add(mop);
      armR.add(box(0.2, 0.22, 0.12, 0xB9C4C9, 0.1, -1.05, 0.55));
    }
    grp.add(labelSprite(roleTitle(person.role), r.shirt));
    grp.traverse(o => { o.userData.staffKey = person.key; });
    return { group: grp, legL, legR, armL, armR };
  }

  const avatars = {};
  let selectedKey = null;
  function nearestWaypoint(route, p) {
    let bi = 0, bd = 1e9;
    route.forEach((w, i) => { const d = (w.x - p.x) * (w.x - p.x) + (w.z - p.z) * (w.z - p.z); if (d < bd) { bd = d; bi = i; } });
    return bi;
  }
  function placeAvatar(person, atEntrance) {
    removeAvatar(person.key);
    const p = createPerson(person);
    const route = (L_ROUTES[person.role] || L_ROUTES.helper).map(w => ({ x: w.x, z: w.z }));
    const start = atEntrance ? { x: L_ENTRANCE.x, z: L_ENTRANCE.z } : route[0];
    p.group.position.set(start.x, 0, start.z);
    staffGroup.add(p.group);
    avatars[person.key] = {
      group: p.group, legL: p.legL, legR: p.legR, armL: p.armL, armR: p.armR,
      route, idx: 0, wait: Math.random() * 1.5, phase: Math.random() * 6.28,
      speed: 0.85 + Math.random() * 0.4, arriving: Boolean(atEntrance), person
    };
    if (atEntrance) avatars[person.key].idx = nearestWaypoint(route, start);
  }
  function removeAvatar(key) {
    if (avatars[key]) { staffGroup.remove(avatars[key].group); delete avatars[key]; }
    if (selectedKey === key) selRing.visible = false;
  }

  if (isFL) buildRoomFL(); else buildRoom();
  scene.add(staffGroup);
  scene.add(selRing);

  /* ---------- pointer: orbit + pick ---------- */
  const raycaster = new THREE.Raycaster();
  let pointerDown = null;
  const el = renderer.domElement;
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', (e) => { pointerDown = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY }; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => {
    if (!pointerDown) return;
    camGoal.theta -= (e.clientX - pointerDown.lx) * 0.005;
    camGoal.phi = Math.max(0.18, Math.min(1.42, camGoal.phi - (e.clientY - pointerDown.ly) * 0.004));
    pointerDown.lx = e.clientX; pointerDown.ly = e.clientY;
  });
  el.addEventListener('pointerup', (e) => {
    if (pointerDown && Math.hypot(e.clientX - pointerDown.x, e.clientY - pointerDown.y) < 6) pick(e);
    pointerDown = null;
  });
  el.addEventListener('wheel', (e) => { e.preventDefault(); camGoal.radius = Math.max(R_MIN, Math.min(R_MAX, camGoal.radius + e.deltaY * 0.02)); }, { passive: false });
  let pinch = 0;
  el.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      if (pinch) camGoal.radius = Math.max(R_MIN, Math.min(R_MAX, camGoal.radius + (pinch - d) * 0.05));
      pinch = d;
    }
  }, { passive: true });
  el.addEventListener('touchend', () => { pinch = 0; });
  function pick(e) {
    const rect = el.getBoundingClientRect();
    const mouse = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(staffGroup.children, true);
    for (let i = 0; i < hits.length; i++) {
      const key = hits[i].object.userData.staffKey;
      if (key) { onPick(key); return; }
    }
  }

  /* ---------- animation loop ---------- */
  let rafId = null, clockT = performance.now() / 1000, lastSize = '', destroyed = false;
  function resize() {
    const w = holder.clientWidth, h = holder.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  resize();
  const onWindowResize = () => resize();
  window.addEventListener('resize', onWindowResize);
  function loop() {
    if (destroyed) return;
    rafId = requestAnimationFrame(loop);
    const now = performance.now() / 1000, dt = Math.min(0.05, now - clockT); clockT = now;
    const t = now;
    if (spitMesh) spitMesh.rotation.y += dt * 0.7;
    Object.keys(avatars).forEach(key => {
      const a = avatars[key], pos = a.group.position;
      const target = a.route[a.idx];
      const dx = target.x - pos.x, dz = target.z - pos.z, dist = Math.hypot(dx, dz);
      if (a.wait > 0 && dist < 0.25) {
        a.wait -= dt;
        a.legL.rotation.x *= 0.8; a.legR.rotation.x *= 0.8;
        a.armL.rotation.x = Math.sin(t * 2.2 + a.phase) * 0.45 - 0.2;
        if (a.person.role !== 'waiter') a.armR.rotation.x = Math.sin(t * 2.7 + a.phase + 1) * 0.55 - 0.25;
        a.group.position.y = Math.abs(Math.sin(t * 1.6 + a.phase)) * 0.012;
        if (a.wait <= 0) { a.idx = (a.idx + 1) % a.route.length; if (a.arriving) a.arriving = false; }
        return;
      }
      if (dist < 0.12) {
        a.wait = a.arriving ? 0 : (1.2 + Math.random() * 2.6);
        a.idx = (a.idx + 1) % a.route.length;
        if (a.arriving) { a.arriving = false; a.wait = 0.5; }
        return;
      }
      const sp = a.speed * (a.arriving ? 1.5 : 1);
      pos.x += dx / dist * sp * dt; pos.z += dz / dist * sp * dt;
      const targetRot = Math.atan2(dx, dz), cur = a.group.rotation.y;
      const diff = ((targetRot - cur + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      a.group.rotation.y = cur + diff * Math.min(1, dt * 9);
      const swing = Math.sin(t * 7.5 + a.phase) * 0.5;
      a.legL.rotation.x = swing; a.legR.rotation.x = -swing;
      a.armL.rotation.x = -swing * 0.7;
      if (a.person.role !== 'waiter' && a.person.role !== 'cleaner') a.armR.rotation.x = swing * 0.7;
      if (a.person.role === 'cleaner') { a.armR.rotation.x = -0.5 + Math.sin(t * 3 + a.phase) * 0.22; }
      a.group.position.y = Math.abs(Math.sin(t * 7.5 + a.phase)) * 0.03;
    });
    if (selRing.visible && selectedKey && avatars[selectedKey]) {
      const p = avatars[selectedKey].group.position;
      selRing.position.x = p.x; selRing.position.z = p.z;
      const s = 1 + Math.sin(t * 4) * 0.1; selRing.scale.set(s, s, 1);
    }
    camTheta += (camGoal.theta - camTheta) * 0.07;
    camPhi += (camGoal.phi - camPhi) * 0.07;
    camRadius += (camGoal.radius - camRadius) * 0.07;
    camTarget.x += (camGoal.tx - camTarget.x) * 0.07;
    camTarget.y += (camGoal.ty - camTarget.y) * 0.07;
    camTarget.z += (camGoal.tz - camTarget.z) * 0.07;
    camera.position.set(
      camTarget.x + camRadius * Math.sin(camPhi) * Math.sin(camTheta),
      camTarget.y + camRadius * Math.cos(camPhi),
      camTarget.z + camRadius * Math.sin(camPhi) * Math.cos(camTheta)
    );
    camera.lookAt(camTarget);
    const sizeKey = holder.clientWidth + 'x' + holder.clientHeight;
    if (sizeKey !== lastSize) { lastSize = sizeKey; resize(); }
    renderer.render(scene, camera);
  }
  loop();

  function applyHighlight() {
    selRing.visible = Boolean(selectedKey && avatars[selectedKey]);
  }

  return {
    setStaff(persons) {
      Object.keys(avatars).forEach(removeAvatar);
      (persons || []).forEach(p => { if (p.status === 'on' || p.status === 'called') placeAvatar(p, false); });
      applyHighlight();
    },
    spawn(person) { placeAvatar(person, true); },
    remove: removeAvatar,
    highlight(key) {
      selectedKey = key || null;
      applyHighlight();
    },
    setCam(name) {
      const c = L_CAMS[name];
      if (!c) return;
      const tgt = (isFL && FL_TARGET[name]) ? FL_TARGET[name] : L_HOME_TARGET;
      camGoal = { theta: c.theta, phi: c.phi, radius: c.radius, tx: tgt[0], ty: tgt[1], tz: tgt[2] };
    },
    destroy() {
      destroyed = true;
      if (rafId != null) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onWindowResize);
      renderer.dispose();
      holder.innerHTML = '';
    }
  };
}
