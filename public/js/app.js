/* Star Scout: d3-geo stereographic projection on canvas.
 *
 * Rendering is split into two layers for speed:
 *   1. base layer (offscreen canvas), redrawn only when the view changes:
 *      background, blurred Milky Way, grid, constellation lines, faint stars, labels
 *   2. overlay, composited every frame (~30 fps cap): bright stars with glow,
 *      diffraction spikes and twinkle, hover ring, selection reticle, tour marker
 * Hover = nearest star within a pixel radius; click = side panel + Gemma explainer.
 */
(function () {
  "use strict";
  const DEG = Math.PI / 180;
  const HOVER_RADIUS = 14;          // px
  const CLIP_ANGLE = 100;           // deg from view center that is drawn
  const TOUR_DWELL_MS = 11000;
  const BRIGHT_MAG = 3.0;           // stars brighter than this are drawn in the animated overlay
  const SPIKE_MAG = 1.5;            // diffraction spikes for these
  const FRAME_MS = 33;              // overlay refresh cap when idle (twinkle)
  const params = new URLSearchParams(location.search);
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const canvas = $("sky"), ctx = canvas.getContext("2d");
  const base = document.createElement("canvas"), bctx = base.getContext("2d");
  const mwCanvas = document.createElement("canvas"), mctx = mwCanvas.getContext("2d");
  const bgCanvas = document.createElement("canvas"), bgctx = bgCanvas.getContext("2d");
  const tooltip = $("tooltip"), panel = $("panel"), chat = $("chat");
  const askForm = $("ask-form"), askInput = $("ask-input");
  const banner = $("mode-banner");

  // ---------- State ----------
  let stars = [], bright = [], mw = null, lines = null, linesByCon = new Map(), conNames = {};
  let W = 0, H = 0, DPR = 1, baseScale = 1;
  let zoom = 1;
  let rotate = [-(+params.get("ra") || 83), -(+params.get("dec") || 2), 0]; // start near Orion
  let offsetX = 0, offsetTarget = 0;   // shift the view left when the panel is open
  const show = { lines: true, mw: true, labels: true, planets: true };
  let planets = [], ecl = null, eclG = null, questOutline = null;
  let hovered = null, selected = null, tourStar = null, questHint = null, questFound = null;
  let kidMode = true;
  try { kidMode = localStorage.getItem("starmap.kids") !== "0"; } catch (_) {}
  let hoverSince = 0, selectSince = 0;
  let screen = null; // Float32Array [x,y,...]; NaN when hidden
  let viewDirty = true, lastFrame = 0, interacting = 0;
  // ---------- Views: "dome" (stereographic, equatorial) | "pano" (Hammer-Aitoff, galactic) ----------
  const SQRT2 = Math.SQRT2;
  function hammerRaw(l, p) {
    const cp = Math.cos(p), d = Math.sqrt(1 + cp * Math.cos(l / 2));
    return [2 * SQRT2 * cp * Math.sin(l / 2) / d, SQRT2 * Math.sin(p) / d];
  }
  hammerRaw.invert = function (x, y) {
    const z = Math.sqrt(Math.max(0, 1 - x * x / 16 - y * y / 4));
    return [2 * Math.atan2(z * x, 2 * (2 * z * z - 1)), Math.asin(Math.max(-1, Math.min(1, z * y)))];
  };
  // J2000 equatorial -> galactic (IAU) rotation matrix
  const GAL = [[-0.0548755604, -0.8734370902, -0.4838350155], [0.4941094279, -0.4448296300, 0.7469822445], [-0.8676661490, -0.1980763734, 0.4559837762]];
  function eqToGal(ra, dec) {
    const c = Math.cos(dec * DEG), x = c * Math.cos(ra * DEG), y = c * Math.sin(ra * DEG), z = Math.sin(dec * DEG);
    const gx = GAL[0][0] * x + GAL[0][1] * y + GAL[0][2] * z, gy = GAL[1][0] * x + GAL[1][1] * y + GAL[1][2] * z, gz = GAL[2][0] * x + GAL[2][1] * y + GAL[2][2] * z;
    return [Math.atan2(gy, gx) / DEG, Math.asin(Math.max(-1, Math.min(1, gz))) / DEG];
  }
  function geoToGal(geo) {
    // deep-copy a GeoJSON FeatureCollection with every [ra,dec] position converted to [l,b]
    const conv = (c) => typeof c[0] === "number" ? eqToGal(c[0] < 0 ? c[0] + 360 : c[0], c[1]) : c.map(conv);
    return { type: "FeatureCollection", features: geo.features.map((f) => ({ ...f, geometry: { type: f.geometry.type, coordinates: conv(f.geometry.coordinates) } })) };
  }
  const LANDMARKS = [[0, 0, "Galactic Center · Sagittarius"], [-79.5, -32.9, "Large Magellanic Cloud"], [-57.2, -44.3, "Small Magellanic Cloud"], [80, 1, "Cygnus"], [-72.4, -0.6, "Carina"], [180, 0, "Anticenter"]];
  let view = "dome", panY = 0, mwG = null, linesG = null, linesByConG = new Map();
  const viewState = { dome: null, pano: { rotate: [0, 0, 0], zoom: 1, panY: 0 } };
  const isPano = () => view === "pano";
  const coord = (s) => isPano() ? s._g : [s.ra, s.dec];
  let projection, mwProjection, bpath, mpath;
  function buildProjections() {
    if (isPano()) {
      projection = d3.geoProjection(hammerRaw).reflectX(true).precision(0.7);
      mwProjection = d3.geoProjection(hammerRaw).reflectX(true).precision(1.2);
    } else {
      projection = d3.geoStereographic().reflectX(true).clipAngle(CLIP_ANGLE).precision(0.7);
      mwProjection = d3.geoStereographic().reflectX(true).clipAngle(CLIP_ANGLE).precision(1.2);
    }
    bpath = d3.geoPath(projection, bctx);
    mpath = d3.geoPath(mwProjection, mctx);
  }
  buildProjections();
  function viewScale() {
    // pano: fit the 2√2 : √2 ellipse into the window (leaving room for header/footer)
    return isPano() ? Math.min((W - 40) / (4 * SQRT2), (H - 130) / (2 * SQRT2)) : baseScale;
  }
  function clampPan() {
    if (!isPano()) return;
    const half = SQRT2 * viewScale() * zoom, room = Math.max(0, half - (H / 2 - 70));
    panY = Math.max(-room, Math.min(room, panY));
  }
  const wrap180 = (a) => ((a + 180) % 360 + 360) % 360 - 180;
  const graticule = d3.geoGraticule().step([15, 10])();
  let noisePattern = null;
  const spriteCache = new Map();

  // ---------- Helpers ----------
  function bvToRgbArr(bv) {
    // Approximation after Mitchell Charity's blackbody table (B-V -> sRGB).
    if (bv == null || isNaN(bv)) bv = 0.6;
    bv = Math.max(-0.4, Math.min(2.0, bv));
    let r, g, b, t;
    if (bv < 0.0) { t = (bv + 0.4) / 0.4; r = 0.61 + 0.11 * t + 0.1 * t * t; }
    else if (bv < 0.4) { t = bv / 0.4; r = 0.83 + 0.17 * t; }
    else r = 1.0;
    if (bv < 0.0) { t = (bv + 0.4) / 0.4; g = 0.70 + 0.07 * t + 0.1 * t * t; }
    else if (bv < 0.4) { t = bv / 0.4; g = 0.87 + 0.11 * t; }
    else if (bv < 1.6) { t = (bv - 0.4) / 1.2; g = 0.98 - 0.16 * t; }
    else { t = (bv - 1.6) / 0.4; g = 0.82 - 0.5 * t * t; }
    if (bv < 0.4) b = 1.0;
    else if (bv < 1.5) { t = (bv - 0.4) / 1.1; b = 1.0 - 0.47 * t + 0.1 * t * t; }
    else { t = (bv - 1.5) / 0.44; b = 0.63 - 0.6 * t * t; }
    const c = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    return [c(r), c(g), c(b)];
  }
  const rgb = (a, al) => al == null ? `rgb(${a[0]},${a[1]},${a[2]})` : `rgba(${a[0]},${a[1]},${a[2]},${al})`;
  function objRadius(s) { return s._r ? s._r * Math.pow(zoom, 0.25) : starRadius(s.mag); }
  function starRadius(mag) {
    const z = Math.pow(zoom, 0.35);
    return Math.max(0.45, (6.9 - mag) * 0.6) * z * (view === "pano" ? 0.82 : 1);
  }
  function fmtRA(deg) {
    const h = deg / 15, hh = Math.floor(h), m = (h - hh) * 60, mm = Math.floor(m), ss = Math.round((m - mm) * 60);
    return `${hh}h ${String(mm).padStart(2, "0")}m ${String(ss).padStart(2, "0")}s`;
  }
  function fmtDec(deg) {
    const s = deg < 0 ? "−" : "+", a = Math.abs(deg), d = Math.floor(a), m = (a - d) * 60, mm = Math.floor(m), ss = Math.round((m - mm) * 60);
    return `${s}${d}° ${String(mm).padStart(2, "0")}′ ${String(ss).padStart(2, "0")}″`;
  }
  function fmtDist(s) {
    return s.dist_ly ? `${s.dist_ly < 100 ? s.dist_ly : Math.round(s.dist_ly).toLocaleString()} ly` : "unknown";
  }
  const SPECT_DESC = {
    O: ["Blue", "> 30,000 K"], B: ["Blue-white", "10–30k K"], A: ["White", "7.5–10k K"], F: ["Yellow-white", "6–7.5k K"],
    G: ["Yellow (Sun-like)", "5.2–6k K"], K: ["Orange", "3.7–5.2k K"], M: ["Red", "2.4–3.7k K"],
    C: ["Carbon star", "cool"], S: ["S-type", "cool"], W: ["Wolf-Rayet", "very hot"],
  };
  function lumClass(sp) {
    if (!sp) return "";
    if (/III/.test(sp)) return "giant";
    if (/IV/.test(sp)) return "subgiant";
    if (/II/.test(sp)) return "bright giant";
    if (/I[ab]?(?![IV])/.test(sp) && !/V/.test(sp)) return "supergiant";
    if (/V/.test(sp)) return "main-sequence";
    return "";
  }
  function fmtAU(au) {
    if (au == null) return "?";
    if (au < 0.01) return `${Math.round(au * 149597870.7).toLocaleString()} km`;
    return `${au < 10 ? au.toFixed(2) : au.toFixed(1)} AU`;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function center() { return isPano() ? [-rotate[0], 0] : [-rotate[0], -rotate[1]]; }
  function invalidate() { viewDirty = true; }
  function isVisible(s) { return isPano() || d3.geoDistance([s.ra, s.dec], center()) < (CLIP_ANGLE - 1) * DEG; }

  function starPayload(s) {
    if (s.kind) { // Solar System object (only the Sun is shown): star-like payload for /api/explain
      const { id, name, kind, type, ra, dec, dist_au, sun_au, con } = s;
      const mag = s.appmag ?? s.mag; // the Sun is drawn like a mag ~0.3 star, but its real magnitude is -26.7
      return { id, name, proper: name, kind, type, ra: +ra.toFixed(2), dec: +dec.toFixed(2), mag, dist_au, sun_au, con, con_name: conNames[con] || con };
    }
    const { id, name, proper, hip, ra, dec, mag, dist_ly, spect, con, ci } = s;
    return { id, name, proper, hip, ra, dec, mag, dist_ly, spect, con, con_name: conNames[con] || con, ci };
  }

  // ---------- Textures ----------
  function makeNoise(size) {
    // tileable multi-octave value noise -> alpha texture (dust lanes / mottling for the Milky Way)
    const c = document.createElement("canvas"); c.width = c.height = size;
    const g = c.getContext("2d"), img = g.createImageData(size, size);
    const octaves = [[8, 0.5], [16, 0.28], [32, 0.15], [64, 0.07]];
    const grids = octaves.map(([n]) => { const a = new Float32Array(n * n); for (let i = 0; i < a.length; i++) a[i] = Math.random(); return a; });
    const sm = (t) => t * t * (3 - 2 * t);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let v = 0;
      octaves.forEach(([n, amp], o) => {
        const fx = x / size * n, fy = y / size * n, x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = sm(fx - x0), ty = sm(fy - y0), gr = grids[o];
        const at = (i, j) => gr[((j % n + n) % n) * n + ((i % n + n) % n)];
        const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
        const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
        v += (a + (b - a) * ty) * amp;
      });
      const k = (y * size + x) * 4;
      const d = Math.max(0, Math.min(1, (v - 0.42) * 2.2)); // contrast: only the darker blobs carve
      img.data[k] = img.data[k + 1] = img.data[k + 2] = 0; img.data[k + 3] = Math.round(d * 200);
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  function glowSprite(col) {
    // cached radial-glow sprite per (quantized) star color
    const key = col.join(",");
    let s = spriteCache.get(key);
    if (s) return s;
    s = document.createElement("canvas"); s.width = s.height = 64;
    const g = s.getContext("2d"), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, rgb(col, 0.9)); gr.addColorStop(0.12, rgb(col, 0.45)); gr.addColorStop(0.35, rgb(col, 0.12)); gr.addColorStop(1, rgb(col, 0));
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    spriteCache.set(key, s);
    return s;
  }

  function paintBackground() {
    bgCanvas.width = canvas.width; bgCanvas.height = canvas.height;
    const g = bgctx; g.setTransform(DPR, 0, 0, DPR, 0, 0);
    const R = Math.hypot(W, H) * 0.65;
    const bg = g.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.5, R);
    bg.addColorStop(0, "#0c1330"); bg.addColorStop(0.45, "#070b1d"); bg.addColorStop(1, "#010208");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    // faint nebula tints
    const blobs = [[0.18, 0.25, 0.45, "rgba(120,60,200,0.10)"], [0.82, 0.7, 0.5, "rgba(30,120,180,0.09)"], [0.6, 0.15, 0.3, "rgba(200,80,140,0.05)"]];
    g.globalCompositeOperation = "lighter";
    for (const [x, y, r, c] of blobs) {
      const gr = g.createRadialGradient(W * x, H * y, 0, W * x, H * y, Math.max(W, H) * r);
      gr.addColorStop(0, c); gr.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    }
    g.globalCompositeOperation = "source-over";
    // vignette
    const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, R);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,0.55)");
    g.fillStyle = v; g.fillRect(0, 0, W, H);
  }

  // ---------- Layout ----------
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    for (const c of [canvas, base]) { c.width = Math.round(W * DPR); c.height = Math.round(H * DPR); }
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    mwCanvas.width = Math.ceil(W / 2); mwCanvas.height = Math.ceil(H / 2);
    baseScale = Math.max(W, H) * 0.42;
    updateOffsetTarget();
    paintBackground();
    invalidate();
  }
  function updateOffsetTarget() {
    const open = panel.classList.contains("open");
    offsetTarget = open && W > 720 ? (panel.offsetWidth + 16) / 2 : 0;
  }

  // ---------- Base layer ----------
  function renderBase() {
    const cxs = W / 2 - offsetX, cys = H / 2 + (isPano() ? panY : 0);
    projection.translate([cxs, cys]).scale(viewScale() * zoom).rotate(rotate);
    const L = isPano() ? linesG : lines, LBC = isPano() ? linesByConG : linesByCon, MW = isPano() ? mwG : mw;
    const g = bctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1; g.filter = "none";
    g.drawImage(bgCanvas, 0, 0);
    g.setTransform(DPR, 0, 0, DPR, 0, 0);

    // sky dome edge glow
    g.beginPath(); bpath({ type: "Sphere" });
    g.fillStyle = isPano() ? "rgba(30,45,110,0.16)" : "rgba(40,60,140,0.06)"; g.fill();
    g.strokeStyle = isPano() ? "rgba(140,170,255,0.28)" : "rgba(120,150,255,0.12)"; g.lineWidth = 1.2; g.stroke();

    if (show.mw && MW) drawMilkyWay(g, cxs, cys, MW);

    g.beginPath(); bpath(graticule);
    g.strokeStyle = "rgba(120,150,255,0.05)"; g.lineWidth = 1; g.stroke();

    const focus = selected || tourStar;
    if (show.lines && L) {
      g.beginPath(); bpath(L);
      g.strokeStyle = "rgba(130,165,255,0.2)"; g.lineWidth = 0.9; g.stroke();
    }
    if (questOutline) drawQuestOutline(g);
    if (show.planets && ecl) drawEcliptic(g);
    if (focus && !focus.kind && focus.con && LBC.has(focus.con)) {
      const f = LBC.get(focus.con);
      g.save();
      g.beginPath(); bpath(f);
      g.strokeStyle = focus === tourStar && !selected ? "rgba(255,210,124,0.22)" : "rgba(140,200,255,0.25)";
      g.lineWidth = 5; g.lineCap = "round"; g.lineJoin = "round"; g.stroke();
      g.strokeStyle = focus === tourStar && !selected ? "rgba(255,220,150,0.85)" : "rgba(170,215,255,0.85)";
      g.lineWidth = 1.4; g.stroke();
      // constellation name near the centroid of its line vertices
      const pts = f.geometry.coordinates.flat().filter((p) => isPano() ? Math.abs(wrap180(p[0] + rotate[0])) < 170 : d3.geoDistance(p, center()) < (CLIP_ANGLE - 5) * DEG).map((p) => projection(p));
      if (pts.length) {
        const mx = d3.mean(pts, (p) => p[0]), my = d3.min(pts, (p) => p[1]);
        g.font = "600 12px " + getComputedStyle(document.body).fontFamily;
        g.textAlign = "center"; g.textBaseline = "bottom";
        g.fillStyle = "rgba(200,220,255,0.75)";
        g.fillText((conNames[focus.con] || focus.con).toUpperCase().split("").join("\u2009"), mx, my - 14);
        g.textAlign = "left";
      }
      g.restore();
    }

    // stars: positions for all, draw faint ones here (bright ones go in overlay)
    const c = center(), cl = Math.cos(c[1] * DEG), sl = Math.sin(c[1] * DEG);
    const cx = cl * Math.cos(c[0] * DEG), cy = cl * Math.sin(c[0] * DEG), cz = sl;
    const cosClip = Math.cos((CLIP_ANGLE - 1) * DEG);
    const pano = isPano();
    const magLimit = (pano ? (interacting > 0 ? 4.5 : 5.0) : 5.4) + Math.log2(zoom) * 0.9;
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      if (s.mag > magLimit || (s.kind && !show.planets) || (!pano && s._x * cx + s._y * cy + s._z * cz < cosClip)) { screen[2 * i] = NaN; continue; }
      const p = projection(pano ? s._g : [s.ra, s.dec]);
      const x = p[0], y = p[1];
      if (x < -30 || y < -30 || x > W + 30 || y > H + 30) { screen[2 * i] = NaN; continue; }
      screen[2 * i] = x; screen[2 * i + 1] = y;
      if (s.mag < BRIGHT_MAG) continue;
      const r = starRadius(s.mag);
      if (s.mag < 4.3) { // small soft halo for mid-bright stars
        g.globalAlpha = 0.18; g.fillStyle = s._color;
        g.beginPath(); g.arc(x, y, r * 2.6, 0, 2 * Math.PI); g.fill();
      }
      g.globalAlpha = s.mag > 5.6 ? 0.55 : s.mag > 4.8 ? 0.75 : 0.95;
      g.fillStyle = s._color; g.beginPath(); g.arc(x, y, r, 0, 2 * Math.PI); g.fill();
    }
    g.globalAlpha = 1;

    if (show.labels) {
      const labelMag = 1.7 + Math.log2(zoom) * 1.1;
      g.font = "500 11px " + getComputedStyle(document.body).fontFamily;
      g.textBaseline = "middle";
      g.shadowColor = "rgba(0,0,0,0.9)"; g.shadowBlur = 4;
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        if (!s.proper || s.mag > labelMag || isNaN(screen[2 * i]) || s === selected) continue;
        g.fillStyle = s === tourStar ? "rgba(255,220,150,0.95)" : "rgba(205,218,255,0.72)";
        g.fillText(s.name, screen[2 * i] + starRadius(s.mag) + 5, screen[2 * i + 1] + 0.5);
      }
      g.shadowBlur = 0;
    }
    updatePlanetScreen();
    if (pano && show.labels) {
      g.font = "italic 500 11.5px " + getComputedStyle(document.body).fontFamily;
      g.textAlign = "center"; g.textBaseline = "middle";
      g.shadowColor = "rgba(0,0,0,0.9)"; g.shadowBlur = 5;
      for (const [l, b, name] of LANDMARKS) {
        if (Math.abs(wrap180(l + rotate[0])) > 172) continue;
        const p = projection([l, b]); if (!p) continue;
        const gc = l === 0;
        g.fillStyle = gc ? "rgba(255,226,180,0.8)" : "rgba(190,205,255,0.5)";
        g.fillText(name, p[0], p[1] + (gc ? Math.max(30, viewScale() * zoom * 0.2) : 16));
        if (gc) { g.beginPath(); g.arc(p[0], p[1], 9, 0, 2 * Math.PI); g.strokeStyle = "rgba(255,220,170,0.35)"; g.lineWidth = 1; g.setLineDash([3, 4]); g.stroke(); g.setLineDash([]); }
      }
      g.shadowBlur = 0; g.textAlign = "left";
    }
  }

  // ---------- Solar System on the map ----------
  function visEq(ra, dec) { return isPano() || d3.geoDistance([ra, dec], center()) < (CLIP_ANGLE - 2) * DEG; }
  function updatePlanetScreen() {
    for (const p of planets) {
      p._sx = NaN;
      if (!show.planets || !visEq(p.ra, p.dec)) continue;
      const q = projection(coord(p)); if (!q) continue;
      if (q[0] < -40 || q[1] < -40 || q[0] > W + 40 || q[1] > H + 40) continue;
      p._sx = q[0]; p._sy = q[1];
    }
  }
  function drawEcliptic(g) {
    g.save();
    g.beginPath(); bpath(isPano() ? eclG : ecl);
    g.setLineDash([7, 7]); g.strokeStyle = "rgba(255,206,110,0.42)"; g.lineWidth = 1.3; g.stroke(); g.setLineDash([]);
    // label: a visible point of the ecliptic near the screen center, rotated along the line
    let best = null, bd = Infinity;
    const pts = ecl.features[0].geometry.coordinates;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ra, dec] = pts[i]; if (!visEq(ra, dec) || !visEq(pts[i + 1][0], pts[i + 1][1])) continue;
      const a = projection(coord({ ra, dec, _g: eqToGal(ra, dec) })), b = projection(coord({ ra: pts[i + 1][0], dec: pts[i + 1][1], _g: eqToGal(pts[i + 1][0], pts[i + 1][1]) }));
      if (!a || !b || a[0] < 140 || a[0] > W - 220 || a[1] < 100 || a[1] > H - 70 || Math.hypot(b[0] - a[0], b[1] - a[1]) > 200) continue;
      let d = Math.hypot(a[0] - W * 0.42, a[1] - H * 0.55);
      for (const p of planets) if (!isNaN(p._sx) && Math.hypot(p._sx - a[0], p._sy - a[1]) < 150) d += 400;
      if (d < bd) { bd = d; best = [a, b]; }
    }
    if (best && !questOutline) { // hide while a quest outline label is showing
      const [a, b] = best; let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
      g.translate(a[0], a[1]); g.rotate(ang);
      g.font = "italic 600 11.5px " + getComputedStyle(document.body).fontFamily;
      g.textAlign = "center"; g.textBaseline = "bottom"; g.shadowColor = "rgba(0,0,0,.9)"; g.shadowBlur = 4;
      g.fillStyle = "rgba(255,214,130,0.85)"; g.fillText("Sun's yearly path (ecliptic)", 0, -6);
    }
    g.restore();
  }
  function drawQuestOutline(g) {
    const o = questOutline, f = isPano() ? o.geoG : o.geo;
    g.save();
    g.lineCap = "round"; g.lineJoin = "round";
    g.beginPath(); bpath(f);
    g.strokeStyle = "rgba(255,200,90,0.16)"; g.lineWidth = 14; g.stroke();
    g.strokeStyle = "rgba(255,210,110,0.35)"; g.lineWidth = 6; g.stroke();
    g.strokeStyle = "rgba(255,236,170,0.98)"; g.lineWidth = 2.2; g.stroke();
    const pts = o.pts.filter((p) => visEq(p[0], p[1])).map((p) => projection(coord({ ra: p[0], dec: p[1], _g: eqToGal(p[0], p[1]) }))).filter(Boolean);
    if (pts.length) {
      const mx = d3.mean(pts, (p) => p[0]), my = d3.min(pts, (p) => p[1]);
      g.font = "800 17px " + getComputedStyle(document.body).fontFamily;
      g.textAlign = "center"; g.textBaseline = "bottom"; g.shadowColor = "rgba(0,0,0,.95)"; g.shadowBlur = 8;
      g.fillStyle = "rgba(255,226,150,1)";
      g.fillText(o.label.toUpperCase().split("").join("\u2009"), mx, my - 22);
    }
    g.restore();
  }
  function setQuestOutline(o) {
    // o = { con: "Ori", label } or { stars: [star objects in order], label }; null clears
    if (!o) { questOutline = null; invalidate(); return; }
    let geo = null;
    if (o.con && linesByCon.has(o.con)) geo = linesByCon.get(o.con);
    else if (o.stars && o.stars.length > 1) geo = { type: "Feature", geometry: { type: "LineString", coordinates: o.stars.map((x) => [x.ra, x.dec]) } };
    if (!geo) { questOutline = null; invalidate(); return; }
    const coords = geo.geometry.type === "LineString" ? geo.geometry.coordinates : geo.geometry.coordinates.flat();
    questOutline = { geo, geoG: geoToGal({ type: "FeatureCollection", features: [geo] }), pts: coords, label: o.label || conNames[o.con] || "" };
    invalidate();
  }
  function drawPlanets(now) {
    const font = getComputedStyle(document.body).fontFamily;
    for (const p of planets) {
      if (isNaN(p._sx)) continue;
      const x = p._sx, y = p._sy, r = objRadius(p), col = p._col;
      const pulse = reduceMotion ? 0 : Math.sin(now / 900 + p.ra) * 0.08;
      // soft halo
      const hr = r * (p.kind === "sun" ? 6 : 3.6) * (1 + pulse);
      const h = ctx.createRadialGradient(x, y, r * 0.5, x, y, hr);
      h.addColorStop(0, rgb(col, p.kind === "sun" ? 0.6 : 0.42)); h.addColorStop(1, rgb(col, 0));
      ctx.fillStyle = h; ctx.beginPath(); ctx.arc(x, y, hr, 0, 2 * Math.PI); ctx.fill();
      if (p._ring) { ctx.strokeStyle = rgb(col, 0.8); ctx.lineWidth = 1.6; ctx.beginPath(); ctx.ellipse(x, y, r * 2, r * 0.6, -0.4, 0, 2 * Math.PI); ctx.stroke(); }
      const gr = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
      gr.addColorStop(0, "#fff"); gr.addColorStop(0.3, rgb(col)); gr.addColorStop(1, rgb(col.map((v) => v * 0.45 | 0)));
      ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 1; ctx.stroke();
      // label pill (distinct from star labels)
      if (p === selected) continue;
      ctx.font = "700 12px " + font;
      const tw = ctx.measureText(p.name).width, lx = x + r + (p._ring ? r + 6 : 8), ly = y;
      ctx.fillStyle = "rgba(10,14,34,0.72)"; ctx.strokeStyle = rgb(col, 0.65); ctx.lineWidth = 1;
      ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(lx, ly - 10, tw + 16, 20, 10); else ctx.rect(lx, ly - 10, tw + 16, 20);
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = rgb(col.map((v) => Math.min(255, v + 50))); ctx.textBaseline = "middle"; ctx.textAlign = "left";
      ctx.fillText(p.name, lx + 8, ly + 0.5);
    }
  }

  let mwBlur = null;
  function drawMilkyWay(g, cxs, cys, MW) {
    // draw density layers at half resolution, carve with drifting noise, then composite blurred (bloom) + sharp
    mwProjection.translate([cxs / 2, cys / 2]).scale(viewScale() * zoom / 2).rotate(rotate);
    const m = mctx;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = "source-over"; m.clearRect(0, 0, mwCanvas.width, mwCanvas.height);
    m.globalCompositeOperation = "lighter";
    const cols = [[90, 110, 190, 0.10], [120, 135, 210, 0.10], [160, 165, 225, 0.11], [205, 195, 230, 0.12], [255, 235, 210, 0.14]];
    const boost = isPano() ? 1.35 : 1;
    MW.features.forEach((f, i) => {
      const c = cols[Math.min(i, cols.length - 1)];
      m.beginPath(); mpath(f);
      m.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${c[3] * boost})`; m.fill();
    });
    if (isPano()) {
      // hero glow: a soft band along the galactic plane plus the warm central bulge
      m.save();
      m.beginPath(); mpath({ type: "Sphere" }); m.clip();
      const sc = viewScale() * zoom / 2, y0 = cys / 2, bh = sc * 0.32;
      const band = m.createLinearGradient(0, y0 - bh, 0, y0 + bh);
      band.addColorStop(0, "rgba(90,110,200,0)"); band.addColorStop(0.5, "rgba(150,160,230,0.16)"); band.addColorStop(1, "rgba(90,110,200,0)");
      m.fillStyle = band; m.fillRect(0, y0 - bh, mwCanvas.width, bh * 2);
      if (Math.abs(wrap180(rotate[0])) < 120) {
        const c = mwProjection([0, -1]);
        if (c) {
          m.translate(c[0], c[1]); m.scale(1.9, 1);
          const R = sc * 0.42, gb = m.createRadialGradient(0, 0, 0, 0, 0, R);
          gb.addColorStop(0, "rgba(255,226,180,0.36)"); gb.addColorStop(0.3, "rgba(255,200,160,0.16)"); gb.addColorStop(1, "rgba(255,190,150,0)");
          m.fillStyle = gb; m.beginPath(); m.arc(0, 0, R, 0, 2 * Math.PI); m.fill();
        }
      }
      m.restore();
    }
    if (noisePattern) {
      // pattern moves with the sky (approx) so dust lanes don't slide when panning
      const pxPerDeg = viewScale() * zoom * DEG / (isPano() ? 2 : 4);
      const sc = Math.max(0.6, zoom * 0.9);
      noisePattern.setTransform(new DOMMatrix().translate(-rotate[0] * pxPerDeg, isPano() ? panY / 2 : -rotate[1] * pxPerDeg).scale(sc));
      m.globalCompositeOperation = "destination-out";
      m.fillStyle = noisePattern; m.fillRect(0, 0, mwCanvas.width, mwCanvas.height);
    }
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = "lighter";
    const fast = interacting > 0; // skip the blur pass while dragging/flying on slow machines
    if (fast) {
      g.globalAlpha = 0.85;
      g.drawImage(mwCanvas, 0, 0, base.width, base.height);
    } else {
      // blur at half resolution (4x fewer pixels), then upscale: same look, much cheaper
      if (!mwBlur) mwBlur = document.createElement("canvas");
      if (mwBlur.width !== mwCanvas.width || mwBlur.height !== mwCanvas.height) { mwBlur.width = mwCanvas.width; mwBlur.height = mwCanvas.height; }
      const bctx2 = mwBlur.getContext("2d");
      bctx2.setTransform(1, 0, 0, 1, 0, 0);
      bctx2.globalCompositeOperation = "source-over"; bctx2.filter = "none";
      bctx2.clearRect(0, 0, mwBlur.width, mwBlur.height);
      bctx2.filter = `blur(${(4.5 * DPR).toFixed(1)}px)`;
      bctx2.drawImage(mwCanvas, 0, 0);
      bctx2.filter = "none";
      g.globalAlpha = 1.0;
      g.drawImage(mwBlur, 0, 0, base.width, base.height);
      g.globalAlpha = 0.55;
      g.drawImage(mwCanvas, 0, 0, base.width, base.height);
    }
    g.restore();
  }

  // ---------- Overlay (every frame) ----------
  function drawOverlay(now) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over"; ctx.globalAlpha = 1;
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const t = reduceMotion ? 0 : now / 1000;

    // bright stars: glow sprite + twinkle + core + spikes
    ctx.globalCompositeOperation = "lighter";
    for (const s of bright) {
      const i = s._i, x = screen[2 * i]; if (isNaN(x)) continue;
      const y = screen[2 * i + 1], r = starRadius(s.mag);
      const tw = reduceMotion ? 1 : 1 + 0.12 * Math.sin(t * s._tf + s._tp) + 0.06 * Math.sin(t * s._tf * 2.7 + s._tp * 1.7);
      const gs = r * (s.mag < SPIKE_MAG ? 7.5 : 5.5) * tw;
      ctx.globalAlpha = Math.min(1, 0.55 + (BRIGHT_MAG - s.mag) * 0.12) * tw;
      ctx.drawImage(s._sprite, x - gs, y - gs, gs * 2, gs * 2);
      if (s.mag < SPIKE_MAG) {
        const L = r * (7 + (SPIKE_MAG - s.mag) * 3.2) * tw;
        ctx.globalAlpha = 0.5 * tw;
        spike(x, y, L, s._col, 0);
        ctx.globalAlpha = 0.22 * tw;
        spike(x, y, L * 0.55, s._col, Math.PI / 4);
      }
    }
    ctx.globalCompositeOperation = "source-over";
    for (const s of bright) {
      const i = s._i, x = screen[2 * i]; if (isNaN(x)) continue;
      const y = screen[2 * i + 1], r = starRadius(s.mag);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = s._color; ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.globalAlpha = 1;

    if (show.planets) drawPlanets(now);
    // markers
    if (tourStar && tourStar !== selected) reticle(tourStar, [255, 210, 124], now, true);
    if (selected) reticle(selected, [140, 200, 255], now, false);
    if (questFound && questFound !== selected) reticle(questFound, [120, 235, 160], now, false);
    if (questHint) hintRing(questHint, now);
    if (hovered && hovered !== selected) hoverRing(hovered, now);
  }

  function spike(x, y, L, col, ang) {
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    for (let k = 0; k < 2; k++) {
      const gr = ctx.createLinearGradient(-L, 0, L, 0);
      gr.addColorStop(0, rgb(col, 0)); gr.addColorStop(0.5, rgb([255, 255, 255], 0.9)); gr.addColorStop(1, rgb(col, 0));
      ctx.fillStyle = gr; ctx.fillRect(-L, -0.6, L * 2, 1.2);
      ctx.rotate(Math.PI / 2);
    }
    ctx.restore();
  }

  function starScreenPos(s) {
    const x = screen[2 * s._i];
    if (!isNaN(x)) return [x, screen[2 * s._i + 1]];
    if (!isVisible(s)) return null;
    return projection(coord(s));
  }

  function hoverRing(s, now) {
    const p = starScreenPos(s); if (!p) return;
    const age = Math.min(1, (now - hoverSince) / 180);
    const pulse = reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(now / 260);
    const R = objRadius(s) + 7 + pulse * 2.5;
    ctx.save();
    ctx.globalAlpha = age;
    ctx.beginPath(); ctx.arc(p[0], p[1], R + 5, 0, 2 * Math.PI);
    ctx.strokeStyle = `rgba(255,255,255,${0.08 + pulse * 0.08})`; ctx.lineWidth = 6; ctx.stroke();
    ctx.beginPath(); ctx.arc(p[0], p[1], R, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.3; ctx.stroke();
    ctx.restore();
  }

  function hintRing(s, now) {
    // big, friendly pulsing ring for quest hints (after 2 misses)
    const p = starScreenPos(s); if (!p) return;
    const k = reduceMotion ? 0.5 : (now % 1400) / 1400;
    ctx.save();
    for (const off of [0, 0.5]) {
      const q = (k + off) % 1;
      ctx.globalAlpha = (1 - q) * 0.9;
      ctx.beginPath(); ctx.arc(p[0], p[1], 10 + q * 46, 0, 2 * Math.PI);
      ctx.strokeStyle = "rgb(255,214,110)"; ctx.lineWidth = 3 * (1 - q) + 1; ctx.stroke();
    }
    ctx.restore();
  }

  function reticle(s, col, now, isTour) {
    const p = starScreenPos(s); if (!p) return;
    const [x, y] = p;
    const age = Math.min(1, (now - selectSince) / 450), e = d3.easeBackOut(age);
    const r0 = objRadius(s) + 12;
    const R = r0 + (1 - e) * 30;
    const rot = reduceMotion ? 0 : now / 2600;
    const pulse = reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(now / 420);
    ctx.save();
    ctx.globalAlpha = Math.min(1, age * 1.5);
    // soft halo
    const halo = ctx.createRadialGradient(x, y, R * 0.6, x, y, R * 2);
    halo.addColorStop(0, rgb(col, 0.12 + 0.06 * pulse)); halo.addColorStop(1, rgb(col, 0));
    ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y, R * 2, 0, 2 * Math.PI); ctx.fill();
    // inner ring
    ctx.strokeStyle = rgb(col, 0.9); ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(x, y, R, 0, 2 * Math.PI); ctx.stroke();
    // rotating dashed outer ring
    ctx.translate(x, y); ctx.rotate(rot);
    ctx.setLineDash([6, 8]); ctx.strokeStyle = rgb(col, 0.45 + 0.2 * pulse); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, R + 8, 0, 2 * Math.PI); ctx.stroke(); ctx.setLineDash([]);
    // 4 tick marks
    ctx.strokeStyle = rgb(col, 0.95); ctx.lineWidth = 1.8; ctx.lineCap = "round";
    for (let k = 0; k < 4; k++) {
      ctx.beginPath(); ctx.moveTo(R + 4, 0); ctx.lineTo(R + 13, 0); ctx.stroke();
      ctx.rotate(Math.PI / 2);
    }
    ctx.restore();
    // name label
    ctx.save();
    ctx.globalAlpha = Math.min(1, age * 1.5);
    ctx.font = "650 13px " + getComputedStyle(document.body).fontFamily;
    ctx.textBaseline = "middle"; ctx.shadowColor = "rgba(0,0,0,.9)"; ctx.shadowBlur = 6;
    ctx.fillStyle = rgb(col.map((v) => Math.min(255, v + 40)));
    ctx.fillText(s.name, x + R + 18, y);
    ctx.restore();
  }

  function loop(now) {
    // ease the view offset toward the panel-aware target
    if (Math.abs(offsetTarget - offsetX) > 0.5) { offsetX += (offsetTarget - offsetX) * 0.14; invalidate(); }
    else if (offsetX !== offsetTarget) { offsetX = offsetTarget; invalidate(); }
    const animating = !reduceMotion || hovered || selected || tourStar;
    if (viewDirty) { renderBase(); viewDirty = false; drawOverlay(now); lastFrame = now; }
    else if (animating && now - lastFrame >= FRAME_MS && !document.hidden) { drawOverlay(now); lastFrame = now; }
    requestAnimationFrame(loop);
  }

  // ---------- Picking ----------
  function pick(mx, my) {
    let best = null, bestScore = Infinity;
    for (const p of planets) { // Solar System objects win when the pointer is on them
      if (isNaN(p._sx)) continue;
      const d = Math.hypot(p._sx - mx, p._sy - my);
      if (d < objRadius(p) + 10 && d < bestScore) { bestScore = d; best = p; }
    }
    if (best) return best;
    for (let i = 0; i < stars.length; i++) {
      const x = screen[2 * i]; if (isNaN(x)) continue;
      const dx = x - mx, dy = screen[2 * i + 1] - my;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > HOVER_RADIUS + starRadius(stars[i].mag)) continue;
      const score = d - (6.5 - stars[i].mag) * 0.9; // prefer brighter stars when close
      if (score < bestScore) { bestScore = score; best = stars[i]; }
    }
    return best;
  }

  function showTooltip(s, mx, my) {
    if (!s) { tooltip.hidden = true; tooltip._for = null; return; }
    if (tooltip._for !== s && s.kind) {
      tooltip.innerHTML =
        `<div class="t-name"><span class="t-dot" style="background:${s._color};color:${s._color}"></span>${esc(s.name)} <span class="t-ss">Solar System</span></div>` +
        `<div class="t-sub">${esc(s.type)} · <b>${esc(fmtAU(s.dist_au))}</b> from Earth${s.con ? ` · in ${esc(conNames[s.con] || s.con)}` : ""}</div>` +
        `<div class="t-hint">Click to ask Gemma ✦</div>`;
      tooltip._for = s; tooltip.hidden = false;
    } else if (tooltip._for !== s) {
      const sp = s.spect ? SPECT_DESC[s.spect.trim()[0]] : null;
      tooltip.innerHTML =
        `<div class="t-name"><span class="t-dot" style="background:${s._color};color:${s._color}"></span>${esc(s.name)}</div>` +
        `<div class="t-sub">${esc(conNames[s.con] || s.con || "—")} · mag <b>${s.mag}</b> · <b>${esc(fmtDist(s))}</b>${sp ? ` · ${esc(sp[0])}` : ""}</div>` +
        `<div class="t-hint">Click to ask Gemma ✦</div>`;
      tooltip._for = s;
      tooltip.hidden = false;
    }
    const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
    let x = mx + 18, y = my + 16;
    if (x + tw > W - 8) x = mx - tw - 18;
    if (y + th > H - 8) y = my - th - 16;
    tooltip.style.left = x + "px"; tooltip.style.top = y + "px";
  }

  function setHovered(s) {
    if (s === hovered) return;
    hovered = s; hoverSince = performance.now();
  }

  // ---------- Interaction ----------
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    stopFly();
    drag = { x: e.clientX, y: e.clientY, moved: 0, rot: rotate.slice(), panY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
      if (drag.moved > 3) {
        if (!drag.active) { drag.active = true; interacting++; }
        canvas.classList.add("dragging");
        if (isPano()) { // Hammer: ~scale px per radian at center; horizontal = galactic longitude, vertical = pan
          const k = 1 / (viewScale() * zoom) / DEG;
          rotate = [wrap180(drag.rot[0] + dx * k), 0, 0];
          panY = drag.panY + dy; clampPan();
        } else {
          const k = 2 / (baseScale * zoom) / DEG; // stereographic: ~0.5*scale px per radian at center
          rotate = [drag.rot[0] - dx * k, Math.max(-90, Math.min(90, drag.rot[1] - dy * k)), 0];
        }
        setHovered(null); showTooltip(null); invalidate();
        return;
      }
    }
    const s = pick(e.clientX, e.clientY);
    setHovered(s);
    canvas.classList.toggle("over-star", !!s);
    showTooltip(s, e.clientX, e.clientY);
  });
  canvas.addEventListener("pointerup", (e) => {
    const wasClick = drag && drag.moved <= 3;
    if (drag && drag.active) { interacting--; invalidate(); }
    drag = null; canvas.classList.remove("dragging");
    if (wasClick) {
      const s = pick(e.clientX, e.clientY);
      if (s && window.StarQuest && StarQuest.onStarClick(s)) return;
      if (s) { if (tour.active) tour.pause(true); selectStar(s); }
    }
  });
  canvas.addEventListener("pointerleave", () => { setHovered(null); showTooltip(null); });

  // smooth wheel zoom toward a target value
  let zoomTarget = 1, zoomAnim = null;
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    stopFly();
    zoomTarget = Math.max(isPano() ? 0.9 : 0.55, Math.min(16, (zoomAnim ? zoomTarget : zoom) * Math.exp(-e.deltaY * 0.0016)));
    if (!zoomAnim) {
      interacting++;
      zoomAnim = d3.timer(() => {
        const z0 = zoom; zoom += (zoomTarget - zoom) * 0.22;
        if (isPano()) { panY *= zoom / z0; clampPan(); }
        invalidate();
        if (Math.abs(zoomTarget - zoom) < 0.002 * zoom) { zoom = zoomTarget; zoomAnim.stop(); zoomAnim = null; interacting--; invalidate(); }
      });
    }
  }, { passive: false });
  window.addEventListener("resize", resize);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("tips").hidden) dismissIntro();
      else if (!$("quest-picker").hidden) $("quest-picker").hidden = true;
      else if (tour.active) tour.stop(); else closePanel();
    }
  });

  // great-circle fly-to with eased zoom dip
  let flyTimer = null, flyResolve = null;
  function stopFly() {
    if (flyTimer) { flyTimer.stop(); flyTimer = null; interacting--; invalidate(); if (flyResolve) flyResolve(false); flyResolve = null; }
  }
  function flyTo(s, ms = 1600, targetZoom) {
    stopFly();
    if (isPano()) return flyToPano(s, ms, targetZoom);
    const c0 = center(), c1 = [s.ra, s.dec];
    const interp = d3.geoInterpolate(c0, c1), dist = d3.geoDistance(c0, c1) / DEG;
    const z0 = zoom, z1 = targetZoom || Math.max(zoom, 1.6);
    const dur = Math.max(500, Math.min(ms, 500 + dist * 18));
    const ease = d3.easeCubicInOut;
    interacting++;
    return new Promise((resolve) => {
      flyResolve = resolve;
      flyTimer = d3.timer((t) => {
        const k = Math.min(1, t / dur), e = ease(k);
        const p = interp(e);
        const dip = Math.min(1, dist / 80) * Math.sin(Math.PI * e) * 0.38;
        rotate = [-p[0], -p[1], 0];
        zoom = (z0 + (z1 - z0) * e) * (1 - dip);
        invalidate();
        if (k >= 1) { flyTimer.stop(); flyTimer = null; interacting--; flyResolve = null; zoomTarget = zoom; invalidate(); resolve(true); }
      });
    });
  }

  function flyToPano(s, ms, targetZoom) {
    // pano: ease galactic longitude (shortest way round), zoom and vertical pan
    const [l, b] = s._g;
    const r0 = rotate[0], dl = wrap180(-l - r0), z0 = zoom, z1 = targetZoom || Math.max(zoom, 1.8), p0 = panY;
    const yUp = SQRT2 * Math.sin(b * DEG) / Math.sqrt(1 + Math.cos(b * DEG));
    const dur = Math.max(500, Math.min(ms, 500 + Math.abs(dl) * 9));
    const ease = d3.easeCubicInOut;
    interacting++;
    return new Promise((resolve) => {
      flyResolve = resolve;
      flyTimer = d3.timer((t) => {
        const k = Math.min(1, t / dur), e = ease(k);
        const dip = Math.min(1, Math.abs(dl) / 120) * Math.sin(Math.PI * e) * 0.3;
        rotate = [wrap180(r0 + dl * e), 0, 0];
        zoom = (z0 + (z1 - z0) * e) * (1 - dip);
        const pT = yUp * viewScale() * zoom;
        panY = p0 + (pT - p0) * e; clampPan();
        invalidate();
        if (k >= 1) { flyTimer.stop(); flyTimer = null; interacting--; flyResolve = null; zoomTarget = zoom; invalidate(); resolve(true); }
      });
    });
  }

  function setView(v, remember = true) {
    if (v !== "pano" && v !== "dome") v = "dome";
    if (v !== view) {
      stopFly();
      viewState[view] = { rotate: rotate.slice(), zoom, panY };
      view = v;
      const st = viewState[v] || { rotate: rotate.slice(), zoom: 1, panY: 0 };
      rotate = st.rotate.slice(); zoom = zoomTarget = st.zoom; panY = st.panY;
      buildProjections();
      if (screen) screen.fill(NaN);
      setHovered(null); showTooltip(null); invalidate();
    }
    document.body.classList.toggle("view-pano", v === "pano");
    document.querySelectorAll("#view-toggle button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
    if (remember) { try { localStorage.setItem("starmap.view", v); } catch (_) {} }
  }
  document.querySelectorAll("#view-toggle button").forEach((b) => b.addEventListener("click", () => {
    setView(b.dataset.view);
    toast(b.dataset.view === "pano" ? "Panorama: the whole sky in galactic coordinates (Milky Way across the middle)" : "Dome: the sky as seen from Earth", "info", 2600);
  }));

  // ---------- Panel ----------
  let reqToken = 0;
  function selectStar(s) {
    selected = s; selectSince = performance.now(); invalidate();
    if (s.kind) fillPlanetPanel(s); else {
    const sp = s.spect ? SPECT_DESC[s.spect.trim()[0]] : null;
    const lc = lumClass(s.spect);
    $("panel-kicker").textContent = [sp ? sp[0] : null, lc].filter(Boolean).join(" ") || "Star";
    $("panel-title").textContent = s.name;
    $("panel-sub").textContent = [conNames[s.con] ? `in ${conNames[s.con]}` : s.con, s.hip ? `HIP ${s.hip}` : null, `HYG #${s.id}`].filter(Boolean).join(" · ");
    const col = s._col;
    $("panel-orb").style.background = `radial-gradient(circle at 38% 35%, #fff 0%, ${rgb(col)} 32%, ${rgb(col, 0.25)} 68%, transparent 72%)`;
    $("panel-orb").style.boxShadow = `0 0 28px ${rgb(col, 0.55)}`;
    const fact = (k, v, sub, cls = "") => `<div class="fact ${cls}"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
    $("facts").innerHTML =
      fact("Magnitude", s.mag, s.mag < 1 ? "very bright" : s.mag < 3 ? "bright" : s.mag < 5 ? "visible" : "faint") +
      fact("Distance", esc(fmtDist(s)), s.dist_ly ? `${(s.dist_ly / 3.2616).toFixed(1)} pc` : "") +
      fact("Spectral", esc(s.spect || "—"), sp ? esc(sp[1]) : "") +
      `<div class="fact wide"><div class="k">Position</div><div class="v">${fmtRA(s.ra)} &nbsp; ${fmtDec(s.dec)}</div></div>` +
      `<div class="fact wide"><div class="k">Color B−V</div><div class="v"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:${s._color};box-shadow:0 0 8px ${s._color}"></span>${s.ci ?? "—"}</div></div>`;
    }
    chat.innerHTML = "";
    panel.classList.add("open"); panel.setAttribute("aria-hidden", "false");
    updateOffsetTarget();
    // if the star would end up behind the panel, glide it into view
    requestAnimationFrame(() => {
      const p = starScreenPos(s);
      if (!p || p[0] > W - panel.offsetWidth - 60 - (offsetTarget - offsetX) || p[0] < 40 || p[1] < 80 || p[1] > H - 60) flyTo(s, 1200);
    });
    ask(null);
  }
  function fillPlanetPanel(s) {
    $("panel-kicker").textContent = "Solar System · " + s.type;
    $("panel-title").textContent = s.name;
    $("panel-sub").textContent = [s.con ? `now in front of ${conNames[s.con] || s.con}` : null, "position computed for today"].filter(Boolean).join(" · ");
    const col = s._col;
    $("panel-orb").style.background = `radial-gradient(circle at 38% 35%, #fff 0%, ${rgb(col)} 32%, ${rgb(col, 0.25)} 68%, transparent 72%)`;
    $("panel-orb").style.boxShadow = `0 0 28px ${rgb(col, 0.55)}`;
    const fact = (k, v, sub, cls = "") => `<div class="fact ${cls}"><div class="k">${k}</div><div class="v">${v}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
    const lm = s.dist_au * 8.317;
    $("facts").innerHTML =
      fact("Type", s.kind === "sun" ? "Star (G2V)" : esc(s.type.replace(/ \(.*\)/, "")), s.kind === "sun" ? "our very own star" : s.kind === "moon" ? "Earth's moon" : "planet") +
      fact("From Earth", esc(fmtAU(s.dist_au)), lm < 1 ? `light: ${(lm * 60).toFixed(1)} s` : `light: ${lm < 90 ? lm.toFixed(1) + " min" : (lm / 60).toFixed(1) + " h"}`) +
      (s.kind === "sun" ? fact("Size", "109× Earth", "about 1.39 million km wide")
        : fact("From Sun", esc(fmtAU(s.sun_au)), `${(s.sun_au * 149.6).toFixed(0)} million km`)) +
      `<div class="fact wide"><div class="k">Position today</div><div class="v">${fmtRA(s.ra)} &nbsp; ${fmtDec(s.dec)}</div></div>` +
      `<div class="fact wide"><div class="k">Note</div><div class="v" style="font-size:12px;font-weight:500">1 AU = Earth–Sun distance (about 150 million km)</div></div>`;
  }
  function closePanel() {
    panel.classList.remove("open"); panel.setAttribute("aria-hidden", "true");
    selected = null; reqToken++; updateOffsetTarget(); invalidate();
  }
  $("panel-close").addEventListener("click", closePanel);

  function thinkingHTML(label) {
    return `<div class="thinking"><div class="thinking-head"><span class="orbit"><i></i><i></i></span>${esc(label)}</div>` +
      `<div class="skel" style="width:92%"></div><div class="skel" style="width:78%"></div><div class="skel" style="width:85%"></div><div class="skel" style="width:52%"></div></div>`;
  }

  async function ask(question) {
    if (!selected) return;
    const token = ++reqToken, star = selected;
    if (question) chat.insertAdjacentHTML("beforeend", `<div class="msg q">${esc(question)}</div>`);
    const box = document.createElement("div");
    box.className = "msg md loading";
    box.innerHTML = thinkingHTML(question ? "Gemma is thinking…" : `Gemma is reading the catalog entry for ${star.name}…`);
    chat.appendChild(box); chat.scrollTop = chat.scrollHeight;
    setAskBusy(true);
    try {
      const res = await StarAPI.explain(starPayload(star), question || undefined, kidMode ? { audience: "kids" } : {});
      if (token !== reqToken) return;
      box.classList.remove("loading");
      box.innerHTML = (res.mock ? `<span class="mock-tag">demo text · backend offline</span>` : "") + renderMarkdown(res.text || "_(No text returned.)_");
    } catch (err) {
      if (token !== reqToken) return;
      box.className = "msg err";
      box.innerHTML = `<div>Couldn't get an explanation: ${esc(err.message || err)}</div><button class="retry">Try again</button>`;
      box.querySelector(".retry").addEventListener("click", () => { box.remove(); if (question) { const qs = chat.querySelectorAll(".msg.q"); qs[qs.length - 1]?.remove(); } ask(question); });
    } finally {
      if (token === reqToken) setAskBusy(false);
      chat.scrollTop = chat.scrollHeight;
    }
  }
  function setAskBusy(b) { askInput.disabled = b; askForm.querySelector("button").disabled = b; if (!b && !tour.active) askInput.focus({ preventScroll: true }); }
  askForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = askInput.value.trim(); if (!q) return;
    askInput.value = ""; ask(q);
  });

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(msg, kind = "error", ms = 5000) {
    const t = $("toast");
    t.className = kind === "info" ? "info" : ""; t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
  }

  // ---------- Tour ----------
  const tour = {
    active: false, picks: [], idx: 0, timer: null, paused: false, startedAt: 0, barAnim: null,
    async start() {
      const btn = $("tour-btn"), label = btn.querySelector(".tour-label");
      btn.disabled = true; label.textContent = "Gemma is planning…";
      const candidates = stars.filter((s) => s.proper && !s.kind).slice(0, 40).map(starPayload);
      let res;
      try {
        res = await StarAPI.tour(candidates);
      } catch (err) {
        toast(`Gemma couldn't plan a tour (${err.message || err}). Showing a demo tour instead.`);
        res = StarAPI.mockTour(candidates);
      }
      try {
        const byId = new Map(stars.map((s) => [String(s.id), s]));
        const byName = new Map(stars.filter((s) => s.proper).map((s) => [s.proper.toLowerCase(), s]));
        let picks = (res && res.picks || []).map((p) => {
          const s = byId.get(String(p.id)) || (p.name && byName.get(String(p.name).toLowerCase()));
          return s ? { star: s, blurb: p.blurb || "" } : null;
        }).filter(Boolean);
        if (!picks.length) {
          toast("Gemma's tour came back empty. Showing a demo tour instead.");
          picks = StarAPI.mockTour(candidates).picks.map((p) => ({ star: byId.get(String(p.id)), blurb: p.blurb }));
        }
        this.picks = picks;
        this.active = true; this.paused = false; this.idx = 0;
        $("tour-card").hidden = false; $("tour-pause").textContent = "❚❚";
        closePanel();
        this.go(0);
      } finally {
        btn.disabled = false; label.textContent = "Gemma Tour";
      }
    },
    async go(i) {
      clearTimeout(this.timer);
      this.idx = (i + this.picks.length) % this.picks.length;
      const { star, blurb } = this.picks[this.idx];
      tourStar = star; selectSince = performance.now(); invalidate();
      $("tour-step").textContent = `Stop ${this.idx + 1} of ${this.picks.length}`;
      $("tour-name").textContent = star.name;
      $("tour-blurb").innerHTML = renderMarkdown(blurb);
      $("tour-bar").style.transition = "none"; $("tour-bar").style.width = "0%";
      const arrived = await flyTo(star, 2200, 2.2);
      if (arrived && this.active && !this.paused && tourStar === star) this.schedule();
    },
    schedule() {
      clearTimeout(this.timer);
      const bar = $("tour-bar");
      bar.style.transition = "none"; bar.style.width = "0%";
      void bar.offsetWidth;
      bar.style.transition = `width ${TOUR_DWELL_MS}ms linear`; bar.style.width = "100%";
      this.timer = setTimeout(() => {
        if (this.idx + 1 >= this.picks.length) this.stop(); else this.go(this.idx + 1);
      }, TOUR_DWELL_MS);
    },
    pause(force) {
      if (!this.active) return;
      this.paused = force === true ? true : !this.paused;
      $("tour-pause").textContent = this.paused ? "▶" : "❚❚";
      const bar = $("tour-bar");
      if (this.paused) { clearTimeout(this.timer); const w = getComputedStyle(bar).width; bar.style.transition = "none"; bar.style.width = w; }
      else this.schedule();
    },
    stop() {
      clearTimeout(this.timer); this.active = false; tourStar = null;
      $("tour-card").hidden = true; invalidate();
    },
  };
  $("tour-btn").addEventListener("click", () => tour.start());
  $("tour-next").addEventListener("click", () => tour.go(tour.idx + 1));
  $("tour-prev").addEventListener("click", () => tour.go(tour.idx - 1));
  $("tour-pause").addEventListener("click", () => tour.pause());
  $("tour-stop").addEventListener("click", () => tour.stop());
  $("tour-name").addEventListener("click", () => { if (tourStar) { tour.pause(true); selectStar(tourStar); } });

  // ---------- Toggles & search ----------
  ["lines", "mw", "labels", "planets"].forEach((k) => $("toggle-" + k).addEventListener("change", (e) => { show[k] = e.target.checked; invalidate(); }));
  const search = $("search");
  function doSearch() {
    let q = search.value.trim().toLowerCase(); if (!q) return;
    q = q.replace(/^find (the )?/, "");
    const s = planets.find((x) => x.name.toLowerCase() === q) || stars.find((x) => x.name.toLowerCase() === q || (x.proper && x.proper.toLowerCase() === q))
      || stars.find((x) => x.name.toLowerCase().startsWith(q))
      || stars.find((x) => x.name.toLowerCase().includes(q) || (x.hip && `hip ${x.hip}` === q));
    if (!s) { toast(`No star matching “${search.value.trim()}”`, "info", 2500); return; }
    search.blur();
    if (tour.active) tour.pause(true);
    flyTo(s, 1600).then(() => selectStar(s));
  }
  search.addEventListener("change", doSearch);
  search.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

  function updateBanner() {
    if (StarAPI.state.mock) {
      banner.hidden = false;
      banner.textContent = `Demo mode · placeholder text (backend not connected: ${StarAPI.state.reason})`;
    }
  }
  StarAPI.onModeChange(updateBanner);

  // ---------- Kid mode ----------
  const kidsToggle = $("toggle-kids");
  kidsToggle.checked = kidMode;
  kidsToggle.addEventListener("change", (e) => {
    kidMode = e.target.checked;
    try { localStorage.setItem("starmap.kids", kidMode ? "1" : "0"); } catch (_) {}
    toast(kidMode ? "Kid mode on: Gemma will use simple, fun words" : "Kid mode off: Gemma will use grown-up astronomy words", "info", 2600);
  });

  // ---------- Onboarding tips (small dismissible card on the map) ----------
  function dismissIntro() {
    const t = $("tips"); if (t.hidden) return;
    t.classList.add("out"); setTimeout(() => { t.hidden = true; t.classList.remove("out"); }, 300);
    try { localStorage.setItem("starmap.tipsSeen", "1"); } catch (_) {}
  }
  function maybeShowTips() {
    let seen = false; try { seen = localStorage.getItem("starmap.tipsSeen") === "1"; } catch (_) {}
    const p = params.get("intro");
    $("tips").hidden = p === "1" ? false : (p === "0" || params.has("star") || seen);
  }
  $("tips-close").addEventListener("click", dismissIntro);
  $("tips-sun").addEventListener("click", () => {
    dismissIntro();
    const sun = stars.find((x) => x.kind === "sun"); if (sun) flyTo(sun, 1600, Math.max(zoom, 1.8)).then(() => selectStar(sun));
  });
  function flyToRegion(ra, dec, z) {
    const t = { ra, dec, _g: eqToGal(ra, dec) };
    return flyTo(t, 1800, z || (isPano() ? 2.6 : 2.0));
  }

  // ---------- Boot ----------
  async function boot() {
    maybeShowTips();
    resize();
    noisePattern = mctx.createPattern(makeNoise(256), "repeat");
    const [s, m, l, cn] = await Promise.all([
      d3.json("data/stars.json"),
      d3.json("data/mw.simplified.json").catch(() => d3.json("data/mw.json")).catch(() => null),
      d3.json("data/constellations.lines.json").catch(() => null),
      d3.json("data/constellation_names.json").catch(() => ({})),
    ]);
    stars = s; mw = m; lines = l; conNames = cn || {};
    // Our Sun, in its real position today, drawn and labeled exactly like a normal bright star
    let sunStar = null;
    try {
      const dp = params.get("date"), when = dp ? new Date(dp) : new Date();
      const sun = window.Planets ? Planets.compute(isNaN(when) ? new Date() : when).find((p) => p.kind === "sun") : null;
      if (sun) {
        sunStar = { id: "sun", name: "Sun", proper: "Sun", kind: "sun", type: sun.type, ra: sun.ra, dec: sun.dec,
          mag: 0.3, appmag: sun.mag, ci: 0.65, spect: "G2V", dist_au: sun.dist_au, sun_au: 0 };
        let bd = 1e9; for (const st of stars) { if (st.mag > 4.6 || !st.con) continue; const d = d3.geoDistance([sun.ra, sun.dec], [st.ra, st.dec]); if (d < bd) { bd = d; sunStar.con = st.con; } }
        stars.push(sunStar);
      }
    } catch (e) { console.warn("Sun position unavailable", e); }
    if (lines) lines.features.forEach((f) => linesByCon.set(f.id, f));
    if (mw) mwG = geoToGal(mw);
    if (lines) { linesG = geoToGal(lines); linesG.features.forEach((f) => linesByConG.set(f.id, f)); }
    stars.forEach((st, i) => {
      st._g = eqToGal(st.ra, st.dec);
      st._i = i; st._col = bvToRgbArr(st.ci); st._color = rgb(st._col);
      const cd = Math.cos(st.dec * DEG);
      st._x = cd * Math.cos(st.ra * DEG); st._y = cd * Math.sin(st.ra * DEG); st._z = Math.sin(st.dec * DEG);
      if (st.mag < BRIGHT_MAG) {
        const q = bvToRgbArr(st.ci == null ? null : Math.round(st.ci * 10) / 10);
        st._sprite = glowSprite(q);
        st._tf = 1.3 + Math.random() * 2.2; st._tp = Math.random() * Math.PI * 2;
        bright.push(st);
      }
    });
    screen = new Float32Array(stars.length * 2).fill(NaN);
    let v0 = params.get("view");
    if (v0 !== "pano" && v0 !== "dome") { try { v0 = localStorage.getItem("starmap.view"); } catch (_) {} }
    setView(v0 === "pano" ? "pano" : "dome", false);
    planets = []; // no separate Solar System markers: the Sun is part of `stars` (planets.js Moon/planet code is unused)
    const eclPts = d3.range(0, 361, 2).map((lon) => Planets.eclipticToEq(lon, 0));
    ecl = { type: "FeatureCollection", features: [{ type: "Feature", geometry: { type: "LineString", coordinates: eclPts } }] };
    eclG = geoToGal(ecl);
    $("star-names").innerHTML = `<option value="Sun" label="Find the Sun (Solar System)">` +
      stars.filter((x) => x.proper && !x.kind).map((x) => `<option value="${esc(x.proper)}">`).join("");
    updateBanner();
    invalidate();
    requestAnimationFrame(loop);
    window.__starmap = {
      ready: true, count: stars.length, stars, planets, get sun() { return stars.find((x) => x.kind === "sun") || null; }, selectStar, flyTo, flyToRegion, tour, dismissIntro, toast, closePanel, setQuestOutline,
      get questOutline() { return questOutline; },
      starByName: (n) => stars.find((x) => x.proper === n) || stars.find((x) => x.name === n),
      screenPos: (st) => starScreenPos(st),
      setQuestHint(st) { questHint = st || null; invalidate(); },
      setQuestFound(st) { questFound = st || null; if (st) selectSince = performance.now(); invalidate(); },
      get kidMode() { return kidMode; },
      get W() { return W; }, get H() { return H; },
      project: (st) => projection(coord(st)), setView,
      get view() { return view; },
      get rotate() { return rotate; }, get zoom() { return zoom; },
      timeBaseFast() { interacting++; const t0 = performance.now(); renderBase(); bctx.getImageData(0, 0, 1, 1); const d = performance.now() - t0; interacting--; return d; },
      timeBase() { const t0 = performance.now(); renderBase(); bctx.getImageData(0, 0, 1, 1); return performance.now() - t0; },
      timeOverlay() { const t0 = performance.now(); drawOverlay(performance.now()); return performance.now() - t0; },
    };
    document.dispatchEvent(new Event("starmap:ready"));
    // deep link from the Star Lookup page: index.html?star=<HYG id or name>
    const sp = params.get("star");
    if (sp) {
      const target = planets.find((x) => x.id === sp || x.name.toLowerCase() === sp.toLowerCase()) || stars.find((x) => String(x.id) === sp) || stars.find((x) => x.hip && String(x.hip) === sp) ||
        stars.find((x) => (x.proper || "").toLowerCase() === sp.toLowerCase());
      if (target) { flyTo(target, 1400, Math.max(zoom, 2.2)).then(() => selectStar(target)); }
      else toast(`Couldn't find star "${sp}" on the map`, "warn", 3500);
    }
  }
  boot().catch((err) => {
    console.error(err);
    document.body.insertAdjacentHTML("beforeend", `<div class="msg err" style="position:fixed;top:80px;left:20px;z-index:20">Failed to load star data: ${esc(err.message || err)}</div>`);
  });
})();
