/* Approximate geocentric positions of the Sun, Moon and planets (client-side).
 * Planets: JPL "Approximate Positions of the Planets" Keplerian elements (Standish, valid 1800-2050),
 * accuracy ~ a few arcminutes to ~1 degree -- plenty for a star map.
 * Moon: simple low-precision series (~1 deg).
 * Returns RA/Dec in degrees (J2000-ish, equatorial), distance from Earth and from the Sun in AU.
 */
(function () {
  "use strict";
  const D = Math.PI / 180;
  // a [AU], e, I, L, long.peri, long.node  (each: [value, rate per Julian century])
  const EL = {
    Mercury: [[0.38709927, 0.00000037], [0.20563593, 0.00001906], [7.00497902, -0.00594749], [252.25032350, 149472.67411175], [77.45779628, 0.16047689], [48.33076593, -0.12534081]],
    Venus: [[0.72333566, 0.00000390], [0.00677672, -0.00004107], [3.39467605, -0.00078890], [181.97909950, 58517.81538729], [131.60246718, 0.00268329], [76.67984255, -0.27769418]],
    Earth: [[1.00000261, 0.00000562], [0.01671123, -0.00004392], [-0.00001531, -0.01294668], [100.46457166, 35999.37244981], [102.93768193, 0.32327364], [0, 0]],
    Mars: [[1.52371034, 0.00001847], [0.09339410, 0.00007882], [1.84969142, -0.00813131], [-4.55343205, 19140.30268499], [-23.94362959, 0.44441088], [49.55953891, -0.29257343]],
    Jupiter: [[5.20288700, -0.00011607], [0.04838624, -0.00013253], [1.30439695, -0.00183714], [34.39644051, 3034.74612775], [14.72847983, 0.21252668], [100.47390909, 0.20469106]],
    Saturn: [[9.53667594, -0.00125060], [0.05386179, -0.00050991], [2.48599187, 0.00193609], [49.95424423, 1222.49362201], [92.59887831, -0.41897216], [113.66242448, -0.28867794]],
    Uranus: [[19.18916464, -0.00196176], [0.04725744, -0.00004397], [0.77263783, -0.00242939], [313.23810451, 428.48202785], [170.95427630, 0.40805281], [74.01692503, 0.04240589]],
    Neptune: [[30.06992276, 0.00026291], [0.00859048, 0.00005105], [1.77004347, 0.00035372], [-55.12002969, 218.45945325], [44.96476227, -0.32241464], [131.78422574, -0.00508664]],
  };
  const OBL = 23.43928 * D;
  const INFO = {
    Sun: { kind: "sun", type: "Star (our Sun)", col: [255, 214, 110], r: 9, mag: -26.7, blurb: "Our star. Never look at it directly!" },
    Moon: { kind: "moon", type: "Moon (Earth's satellite)", col: [225, 228, 240], r: 7.5, mag: -10 },
    Mercury: { kind: "planet", type: "Rocky planet", col: [190, 180, 170], r: 4.2, mag: 0 },
    Venus: { kind: "planet", type: "Rocky planet", col: [255, 236, 180], r: 5.6, mag: -4.2 },
    Mars: { kind: "planet", type: "Rocky planet", col: [255, 120, 80], r: 5, mag: 0.5 },
    Jupiter: { kind: "planet", type: "Gas giant", col: [235, 200, 160], r: 6.6, mag: -2.4 },
    Saturn: { kind: "planet", type: "Gas giant (with rings)", col: [240, 220, 160], r: 6, mag: 0.6, ring: true },
    Uranus: { kind: "planet", type: "Ice giant", col: [150, 230, 235], r: 4.8, mag: 5.7 },
    Neptune: { kind: "planet", type: "Ice giant", col: [110, 150, 255], r: 4.8, mag: 7.8 },
  };

  function helio(name, T) {
    const e0 = EL[name].map(([v, r]) => v + r * T);
    const [a, e, I, L, wbar, node] = e0;
    const w = wbar - node;
    let M = ((L - wbar) % 360 + 540) % 360 - 180;
    const Mr = M * D;
    let E = Mr + e * Math.sin(Mr);
    for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - Mr) / (1 - e * Math.cos(E));
    const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
    const cw = Math.cos(w * D), sw = Math.sin(w * D), cO = Math.cos(node * D), sO = Math.sin(node * D), cI = Math.cos(I * D), sI = Math.sin(I * D);
    return [
      (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp,
      (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp,
      (sw * sI) * xp + (cw * sI) * yp,
    ];
  }
  function eclToEq(x, y, z) {
    const ye = y * Math.cos(OBL) - z * Math.sin(OBL), ze = y * Math.sin(OBL) + z * Math.cos(OBL);
    const r = Math.hypot(x, ye, ze);
    return { ra: ((Math.atan2(ye, x) / D) + 360) % 360, dec: Math.asin(ze / r) / D, r };
  }
  function eclipticToEq(lonDeg, latDeg) {
    const l = lonDeg * D, b = latDeg * D;
    const p = eclToEq(Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b));
    return [p.ra, p.dec];
  }

  function compute(date = new Date()) {
    const jd = date.getTime() / 86400000 + 2440587.5, d = jd - 2451545.0, T = d / 36525;
    const earth = helio("Earth", T), out = [];
    // Sun
    const sun = eclToEq(-earth[0], -earth[1], -earth[2]);
    out.push(mk("Sun", sun, sun.r, 0));
    // Moon (low precision)
    const Lm = 218.316 + 13.176396 * d, Mm = 134.963 + 13.064993 * d, F = 93.272 + 13.229350 * d;
    const lon = Lm + 6.289 * Math.sin(Mm * D), lat = 5.128 * Math.sin(F * D), km = 385001 - 20905 * Math.cos(Mm * D);
    const [mra, mdec] = eclipticToEq(lon, lat);
    out.push(mk("Moon", { ra: mra, dec: mdec }, km / 149597870.7, sun.r));
    for (const n of ["Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune"]) {
      const h = helio(n, T), g = [h[0] - earth[0], h[1] - earth[1], h[2] - earth[2]];
      const p = eclToEq(g[0], g[1], g[2]);
      out.push(mk(n, p, p.r, Math.hypot(h[0], h[1], h[2])));
    }
    return out;
  }
  function mk(name, p, distAu, sunAu) {
    const I = INFO[name];
    return { id: I.kind === "planet" ? "planet-" + name.toLowerCase() : I.kind, name, proper: name, kind: I.kind, type: I.type,
      ra: p.ra, dec: p.dec, dist_au: +distAu.toFixed(distAu < 0.01 ? 5 : 3), sun_au: +sunAu.toFixed(3), mag: I.mag,
      _col: I.col, _color: `rgb(${I.col.join(",")})`, _r: I.r, _ring: !!I.ring };
  }
  window.Planets = { compute, eclipticToEq };
})();
