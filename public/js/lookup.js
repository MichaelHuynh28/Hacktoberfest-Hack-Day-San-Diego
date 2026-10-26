// Star Lookup page: search the HYG catalog without the map, show fact cards, ask Gemma (kid mode by default).
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const API_BASE = (params.get("api") || "").replace(/\/$/, "");
  let MOCK = params.get("mock") === "1";
  const KID_KEY = "gsm.kidMode";
  const QUICK = ["Sirius", "Betelgeuse", "Polaris", "Vega", "Rigel", "Proxima Centauri", "Rigil Kentaurus"];

  let stars = [], conNames = {}, current = null, chatToken = 0;

  // ---------- helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const md = (t) => (window.renderMarkdown ? window.renderMarkdown(t) : "<p>" + esc(t) + "</p>");
  const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });

  // B-V color index -> approximate RGB (Ballesteros temperature + blackbody-ish ramp).
  function ciColor(ci) {
    if (typeof ci !== "number" || !isFinite(ci)) return "#fff4e8";
    const bv = Math.max(-0.4, Math.min(2.0, ci));
    const stops = [[-0.4, [155, 176, 255]], [0.0, [202, 215, 255]], [0.3, [248, 247, 255]], [0.6, [255, 244, 234]],
      [0.9, [255, 226, 180]], [1.3, [255, 196, 120]], [1.7, [255, 160, 90]], [2.0, [255, 130, 70]]];
    for (let i = 0; i < stops.length - 1; i++) {
      const [a, ca] = stops[i], [b, cb] = stops[i + 1];
      if (bv <= b) { const t = (bv - a) / (b - a); return "rgb(" + ca.map((v, j) => Math.round(v + (cb[j] - v) * t)).join(",") + ")"; }
    }
    return "rgb(255,130,70)";
  }
  function colorWord(ci) {
    if (typeof ci !== "number") return "Unknown color";
    if (ci < -0.1) return "Blue"; if (ci < 0.15) return "Blue-white"; if (ci < 0.45) return "White";
    if (ci < 0.7) return "Yellow-white"; if (ci < 1.0) return "Yellow-orange"; if (ci < 1.4) return "Orange"; return "Orange-red";
  }
  function tempWord(ci) {
    if (typeof ci !== "number") return "";
    if (ci < 0.15) return "Much hotter than our Sun"; if (ci < 0.55) return "A bit hotter than our Sun";
    if (ci < 0.8) return "About as hot as our Sun"; return "Cooler than our Sun";
  }
  const TYPE = { O: "a very rare, super-hot blue star", B: "a hot blue-white star", A: "a hot white star", F: "a yellow-white star",
    G: "a yellow star like our Sun", K: "an orange star", M: "a cool red star", W: "a rare, very hot Wolf-Rayet star",
    C: "a carbon star (cool and very red)", S: "a cool, unusual giant star", D: "a white dwarf (a tiny, very dense leftover star)" };
  function spectPlain(sp) {
    if (!sp) return { v: "Unknown", s: "The catalog doesn't list a type for this star." };
    const m = String(sp).match(/^(sd|d|g|c)?([OBAFGKMWCSD])/i);
    if (!m) return { v: sp, s: "An unusual star type." };
    let base = TYPE[m[2].toUpperCase()] || "a star";
    let size = "";
    if (/Ia|Ib|(^|[^I])I(?![IV])/.test(sp) || m[1] === "c") size = "supergiant";
    else if (/III/.test(sp) || m[1] === "g") size = "giant";
    else if (/IV/.test(sp)) size = "subgiant";
    else if (/V/.test(sp) || m[1] === "d") size = "main-sequence (a regular, grown-up star like the Sun)";
    if (size === "supergiant") base = base.replace(/ star\b/, " supergiant").replace(/^a ([^ ]+)/, "a huge $1");
    else if (size === "giant") base = base.replace(/ star\b/, " giant");
    else if (size === "subgiant") base = base.replace(/ star\b/, " star getting bigger with age (subgiant)");
    else if (size) base += ", " + size;
    return { v: String(sp), s: base.charAt(0).toUpperCase() + base.slice(1) + "." };
  }
  function brightWord(mag) {
    if (typeof mag !== "number") return "";
    if (mag < 0) return "One of the very brightest stars in the whole night sky!";
    if (mag < 1.5) return "Very bright. Easy to spot, even from a city.";
    if (mag < 3) return "Easy to see on a clear night.";
    if (mag < 4.5) return "You can see it from the countryside.";
    return "Faint. You need a really dark sky (or binoculars).";
  }
  function lumVsSun(s) {
    if (typeof s.mag !== "number" || !(s.dist_ly > 0)) return null;
    const absmag = s.mag - 5 * (Math.log10(s.dist_ly / 3.26156) - 1);
    return Math.pow(10, (4.83 - absmag) / 2.5);
  }
  function lightStory(dly) {
    if (!(dly > 0)) return null;
    const now = new Date().getFullYear();
    const yrs = Math.round(dly);
    const left = now - yrs;
    let when;
    if (yrs < 1) when = "less than a year ago";
    else if (left > now - 15) when = `around ${left}, only ${yrs} year${yrs === 1 ? "" : "s"} ago!`;
    else if (left > 1900) when = `around ${left}`;
    else if (left > 1500) when = `around ${left}, hundreds of years before your grandparents were born`;
    else if (left > 0) when = `around the year ${left}, more than ${Math.floor(yrs / 100) * 100} years ago`;
    else when = `about ${fmt(yrs)} years ago, before the year 1 (around ${fmt(-left + 1)} BC)`;
    return `The starlight you see tonight left this star ${when}.`;
  }
  const hipLabel = (s) => (s.hip ? "HIP " + s.hip : "HYG " + s.id);
  const conFull = (s) => conNames[s.con] || s.con || "Unknown";

  // ---------- search ----------
  const norm = (t) => String(t).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  function search(q, limit = 8) {
    const n = norm(q);
    if (!n) return [];
    const hipQ = n.replace(/^hip\s*/, "");
    const out = [];
    for (const s of stars) {
      const nm = s._n;
      let score = -1;
      if (s.proper) {
        if (nm === n) score = 100; else if (nm.startsWith(n)) score = 80; else if (nm.includes(" " + n)) score = 60; else if (nm.includes(n)) score = 50;
      } else if (nm.startsWith(n)) score = 40; else if (nm.includes(n)) score = 30;
      if (score < 0 && s.hip && /^\d+$/.test(hipQ) && String(s.hip).startsWith(hipQ)) score = String(s.hip) === hipQ ? 90 : 20;
      if (score < 0 && s._con && s._con.startsWith(n) && n.length >= 3) score = 10;
      if (score >= 0) out.push([score - (s.mag ?? 10) * 0.5, s]);
    }
    out.sort((a, b) => b[0] - a[0]);
    return out.slice(0, limit).map((x) => x[1]);
  }

  const sugg = $("lk-sugg"), input = $("lk-input");
  let suggItems = [], active = -1;
  function renderSugg() {
    const q = input.value;
    suggItems = search(q);
    active = suggItems.length ? 0 : -1;
    if (!q.trim()) { sugg.hidden = true; return; }
    sugg.innerHTML = suggItems.length
      ? suggItems.map((s, i) => `<li role="option" data-i="${i}" aria-selected="${i === active}">
          <span class="dot" style="color:${ciColor(s.ci)};background:${ciColor(s.ci)}"></span>
          <span class="nm">${esc(s.name)}</span><span class="sub">${esc(conFull(s))}${s.proper && s.hip ? " · HIP " + s.hip : ""}</span></li>`).join("")
      : `<li class="empty">No star called “${esc(q)}”. Try Sirius, Vega, or a HIP number.</li>`;
    sugg.hidden = false;
  }
  function setActive(i) {
    active = i;
    [...sugg.querySelectorAll("li[data-i]")].forEach((li, j) => li.setAttribute("aria-selected", j === i));
  }
  input.addEventListener("input", renderSugg);
  input.addEventListener("focus", () => { if (input.value.trim()) renderSugg(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && suggItems.length) { e.preventDefault(); setActive((active + 1) % suggItems.length); }
    else if (e.key === "ArrowUp" && suggItems.length) { e.preventDefault(); setActive((active - 1 + suggItems.length) % suggItems.length); }
    else if (e.key === "Enter") { e.preventDefault(); go(); }
    else if (e.key === "Escape") sugg.hidden = true;
  });
  sugg.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]"); if (!li) return;
    e.preventDefault(); select(suggItems[+li.dataset.i]);
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".lk-search")) sugg.hidden = true; });
  $("lk-go").addEventListener("click", go);
  function go() {
    const pick = suggItems[active] || search(input.value, 1)[0];
    if (pick) select(pick); else renderSugg();
  }

  // ---------- select / render ----------
  function select(s) {
    current = s;
    sugg.hidden = true;
    input.value = s.name;
    const u = new URL(location.href); u.searchParams.set("star", s.id); history.replaceState(null, "", u);
    renderFacts(s);
    $("lk-chat").innerHTML = "";
    renderSuggestedQs(s);
    ask(null);
    if (window.innerWidth < 900) $("lk-result").scrollIntoView({ behavior: "smooth" });
  }

  function renderFacts(s) {
    $("lk-empty").hidden = true;
    $("lk-result").hidden = false;
    const col = ciColor(s.ci);
    $("lk-orb").style.background = `radial-gradient(circle at 38% 35%, #fff 0%, ${col} 35%, ${col} 55%, transparent 72%)`;
    $("lk-orb").style.boxShadow = `0 0 40px ${col}`;
    $("lk-name").textContent = s.name;
    $("lk-sub").textContent = [s.proper ? null : "Catalog star", "in " + conFull(s), hipLabel(s)].filter(Boolean).join(" · ");
    const sp = spectPlain(s.spect);
    const lum = lumVsSun(s);
    const story = lightStory(s.dist_ly);
    const facts = [
      { k: "Constellation", v: esc(conFull(s)), s: s.con ? `Short name: ${esc(s.con)}` : "" },
      { k: "Distance", v: s.dist_ly > 0 ? `${fmt(s.dist_ly, s.dist_ly < 100 ? 1 : 0)} light-years` : "Unknown",
        s: s.dist_ly > 0 ? `That's about ${fmt(s.dist_ly * 9.46, 0)} trillion km away.` : "" },
      story && { k: "Time travel ⏳", v: "", s: esc(story), wide: true },
      { k: "Brightness", v: typeof s.mag === "number" ? `Magnitude ${s.mag}` : "Unknown",
        s: esc(brightWord(s.mag)) + (lum ? ` Gives off about <b>${lum >= 10 ? fmt(lum) : lum.toFixed(lum < 0.1 ? 3 : 1)}×</b> the Sun's light.` : "") },
      { k: "Color", v: `<span class="lk-swatch" style="color:${col};background:${col}"></span>${esc(colorWord(s.ci))}`, s: esc(tempWord(s.ci)) },
      { k: "Star type", v: esc(sp.v), s: esc(sp.s), wide: true },
    ].filter(Boolean);
    $("lk-facts").innerHTML = facts.map((f) => `<div class="lk-fact${f.wide ? " wide" : ""}"><div class="k">${f.k}</div>${f.v ? `<div class="v">${f.v}</div>` : ""}${f.s ? `<div class="s">${f.s}</div>` : ""}</div>`).join("");
    $("lk-maplink").href = "index.html?star=" + encodeURIComponent(s.id);
  }

  function renderSuggestedQs(s) {
    const qs = ["How big is it compared to the Sun?", "Could it have planets?", s.ci > 1.2 ? "Why is it so red?" : s.ci < 0.1 ? "Why is it blue?" : "How old is it?", "How do I find it in the sky?"];
    $("lk-sugq").innerHTML = qs.map((q) => `<button type="button">${esc(q)}</button>`).join("");
  }
  $("lk-sugq").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) ask(b.textContent); });

  // ---------- Gemma ----------
  class Unavailable extends Error {}
  async function post(path, body) {
    let res;
    try { res = await fetch(API_BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
    catch (e) { throw new Unavailable(e.message); }
    if ([404, 405, 501].includes(res.status)) throw new Unavailable("HTTP " + res.status);
    let data = null; try { data = await res.json(); } catch (_) {}
    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || res.statusText || "request failed";
      const err = new Error(typeof msg === "string" ? msg : JSON.stringify(msg)); err.code = data && data.code; throw err;
    }
    if (!data) throw new Error("The server sent back something unexpected.");
    return data;
  }
  function mock(s, q, kids) {
    const head = `*(Practice answer. The Gemma server isn't connected.)*\n\n`;
    if (q) return head + `You asked: **${q}**\n\nWhen Gemma is connected, it will answer using the real catalog facts for **${s.name}**.`;
    return head + `**${s.name}** is ${/^[aeiou]/i.test(colorWord(s.ci)) ? "an" : "a"} ${colorWord(s.ci).toLowerCase()} star in **${conFull(s)}**.\n\n- It's about **${fmt(s.dist_ly || 0)} light-years** away.\n- Its brightness is **magnitude ${s.mag}**.\n\n` +
      (kids ? `**Wow fact:** ${lightStory(s.dist_ly) || "Stars are giant balls of glowing gas!"}` : "");
  }

  const kidBox = $("kid-mode");
  try { const v = localStorage.getItem(KID_KEY); if (v !== null) kidBox.checked = v !== "0"; } catch (_) {}
  kidBox.addEventListener("change", () => {
    try { localStorage.setItem(KID_KEY, kidBox.checked ? "1" : "0"); } catch (_) {}
    if (current) { $("lk-chat").innerHTML = ""; ask(null); }
  });

  function bubble(cls, html) {
    const d = document.createElement("div"); d.className = "msg " + cls; d.innerHTML = html;
    $("lk-chat").appendChild(d); return d;
  }
  async function ask(question) {
    if (!current) return;
    const s = current, token = ++chatToken, kids = kidBox.checked;
    if (question) bubble("q", esc(question));
    const box = bubble("a", `<div class="thinking"><div class="thinking-head"><span class="orbit"><i></i><i></i></span>Gemma is thinking${kids ? " (kid mode)" : ""}…</div>
      <div class="skel" style="width:92%"></div><div class="skel" style="width:78%"></div><div class="skel" style="width:85%"></div><div class="skel" style="width:60%"></div></div>`);
    const body = { star: { id: s.id, name: s.name, proper: s.proper, hip: s.hip, ra: s.ra, dec: s.dec, mag: s.mag, dist_ly: s.dist_ly, spect: s.spect, con: s.con, con_name: conNames[s.con], ci: s.ci } };
    if (question) body.question = question;
    if (kids) body.audience = "kids";
    let text, isMock = false;
    try {
      if (MOCK) throw new Unavailable("mock");
      text = (await post("/api/explain", body)).text;
    } catch (e) {
      if (token !== chatToken && !question) return;
      if (e instanceof Unavailable) { MOCK = true; isMock = true; text = mock(s, question, kids); }
      else {
        const hint = e.code === "missing_api_key" ? "Gemma isn't set up yet: the server needs a GEMINI_API_KEY." : esc(e.message);
        box.className = "msg err";
        box.innerHTML = `😕 Oops! Gemma couldn't answer right now.<div style="opacity:.8;margin-top:4px;font-size:12px">${hint}</div><button class="retry" type="button">Try again</button>`;
        box.querySelector(".retry").onclick = () => { box.remove(); if (question) $("lk-chat").lastElementChild?.remove(); ask(question); };
        return;
      }
    }
    if (token !== chatToken && !question) return;
    box.innerHTML = (isMock ? '<span class="mock-tag">Practice mode</span>' : "") + `<div class="md">${md(text)}</div>`;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  $("lk-ask").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("lk-q").value.trim(); if (!q || !current) return;
    $("lk-q").value = ""; ask(q);
  });

  // ---------- boot ----------
  Promise.all([
    fetch("data/stars.json").then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); }),
    fetch("data/constellation_names.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ]).then(([data, names]) => {
    conNames = names || {};
    stars = data.filter((s) => s && s.name).map((s) => Object.assign(s, { _n: norm(s.name), _con: norm(conNames[s.con] || "") }));
    const byName = new Map(stars.map((s) => [s.name, s]));
    const chips = QUICK.map((n) => byName.get(n)).filter(Boolean).slice(0, 6);
    $("lk-chips").innerHTML = chips.map((s) => `<button type="button" data-id="${s.id}"><i style="color:${ciColor(s.ci)};background:${ciColor(s.ci)}"></i>${esc(s.name === "Rigil Kentaurus" ? "Alpha Centauri" : s.name)}</button>`).join("");
    $("lk-chips").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) select(stars.find((s) => String(s.id) === b.dataset.id)); });
    $("lk-empty").innerHTML = `<span class="big">🌟</span>Pick a star above, or search ${fmt(stars.length)} real stars by name.`;
    const want = params.get("star") || params.get("q");
    if (want) { const s = stars.find((x) => String(x.id) === want) || search(want, 1)[0]; if (s) select(s); }
  }).catch((e) => {
    $("lk-empty").innerHTML = `<span class="big">😕</span>Couldn't load the star catalog (${esc(e.message)}). <button type="button" onclick="location.reload()">Reload</button>`;
  });
})();
