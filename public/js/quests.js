/* Star Quests: kid-friendly treasure hunts defined in data/quests.json.
 * Each step flies the map near (not onto) the target; the kid clicks the star.
 * Correct -> confetti + fun fact (offline) + optional "Ask Gemma more".
 * Wrong -> gentle hint; after 2 misses a pulsing hint ring appears.
 * Finishing a quest awards a badge (localStorage "starmap.badges") and draws a temporary
 * glowing outline of the quest's constellation (or its stars joined in order).
 * Badge pictures come from the Wikipedia REST summary API (thumbnail, CORS-enabled, no key),
 * cached in localStorage "starmap.badgeImg"; fallback is a styled circle with initials.
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const card = $("quest-card"), picker = $("quest-picker"), shelf = $("badge-shelf");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const DIFF = { Easy: 1, Medium: 2, Hard: 3 };
  const pips = (d) => `<span class="q-pips" aria-label="${esc(d)}">${[1, 2, 3].map((i) => `<i class="${i <= (DIFF[d] || 1) ? "on" : ""}"></i>`).join("")}</span>`;

  // ---------- badge images (Wikipedia) ----------
  let imgCache = {};
  try { imgCache = JSON.parse(localStorage.getItem("starmap.badgeImg") || "{}"); } catch (_) {}
  const pending = {};
  function initials(q) { return q.title.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w) && !/^(the|of|vs|our|find|meet)$/i.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || q.title[0]; }
  function hue(q) { let h = 0; for (const c of q.id) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
  function badgeImg(q, size, locked) {
    const url = imgCache[q.imageQuery];
    const style = `width:${size}px;height:${size}px;--h:${hue(q)}`;
    const ini = `<span class="bi-ini" style="font-size:${Math.round(size * 0.38)}px">${esc(initials(q))}</span>`;
    return `<span class="bimg ${locked ? "locked" : ""}" data-q="${esc(q.id)}" style="${style}">${ini}${url ? `<img src="${esc(url)}" alt="${esc(q.badge.name)} badge" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</span>`;
  }
  function loadImage(q) {
    const t = q.imageQuery; if (!t || imgCache[t] || pending[t]) return pending[t];
    pending[t] = fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(t.replace(/ /g, "_")))
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const u = d && d.thumbnail && d.thumbnail.source;
        if (!u) return;
        imgCache[t] = u;
        try { localStorage.setItem("starmap.badgeImg", JSON.stringify(imgCache)); } catch (_) {}
        document.querySelectorAll(`.bimg[data-q="${q.id}"]`).forEach((el) => {
          if (!el.querySelector("img")) el.insertAdjacentHTML("beforeend", `<img src="${esc(u)}" alt="${esc(q.badge.name)} badge" referrerpolicy="no-referrer" onerror="this.remove()">`);
        });
      })
      .catch(() => {}); // offline: initials fallback stays
    return pending[t];
  }
  let quests = [], Q = null, idx = 0, misses = 0, hintsShown = 0, state = "idle", target = null;
  const SM = () => window.__starmap;

  // ---------- badges ----------
  function badges() { try { return JSON.parse(localStorage.getItem("starmap.badges") || "[]"); } catch (_) { return []; } }
  function award(id) {
    const b = badges(); if (!b.includes(id)) b.push(id);
    try { localStorage.setItem("starmap.badges", JSON.stringify(b)); } catch (_) {}
    renderBadges();
  }
  function renderBadges() {
    const got = badges(), list = quests.filter((q) => got.includes(q.id));
    shelf.hidden = !list.length;
    shelf.innerHTML = `<span class="bs-title">My Badges</span>` + list.map((q) => `<span class="bs-badge" title="${esc(q.badge.name)} (${esc(q.title)})">${badgeImg(q, 26)}</span>`).join("");
    $("qp-badges").innerHTML = quests.map((q) => {
      const has = got.includes(q.id);
      return `<div class="qb ${has ? "has" : ""}" title="${esc(has ? q.badge.name : "Locked: finish " + q.title)}">${badgeImg(q, 28, !has)}<span class="qb-name">${esc(q.badge.name)}${has ? "" : " (locked)"}</span></div>`;
    }).join("");
  }
  shelf.addEventListener("click", openPicker);

  // ---------- picker ----------
  function openPicker() {
    const got = badges();
    $("qp-list").innerHTML = quests.map((q) => `
      <button class="qp-item ${got.includes(q.id) ? "done" : ""}" data-id="${esc(q.id)}">
        ${badgeImg(q, 58, false)}
        <span class="qp-body"><span class="qp-title">${esc(q.title)}</span>
          <span class="qp-meta"><span class="qp-diff">${pips(q.difficulty)} ${esc(q.difficulty)}</span> · ${q.steps.length} stars</span>
          <span class="qp-badge">${got.includes(q.id) ? "Badge earned:" : "Win the"} <b>${esc(q.badge.name)}</b>${got.includes(q.id) ? "" : " badge"}</span></span>
      </button>`).join("");
    renderBadges();
    picker.hidden = false;
    quests.forEach(loadImage);
  }
  $("qp-list").addEventListener("click", (e) => {
    const b = e.target.closest(".qp-item"); if (!b) return;
    picker.hidden = true; start(b.dataset.id);
  });
  $("qp-close").addEventListener("click", () => { picker.hidden = true; });
  picker.addEventListener("click", (e) => { if (e.target === picker) picker.hidden = true; });
  $("quest-btn").addEventListener("click", () => { if (SM()) SM().dismissIntro(); openPicker(); });
  $("tour-btn").addEventListener("click", () => { if (Q) quit(); });

  // ---------- quest flow ----------
  function start(id) {
    const q = quests.find((x) => x.id === id); if (!q || !SM()) return;
    const sm = SM();
    if (sm.tour.active) sm.tour.stop();
    sm.closePanel(); sm.setQuestOutline(null);
    Q = q; idx = 0; render("intro"); loadImage(q);
  }
  function quit() {
    Q = null; state = "idle"; target = null; card.hidden = true;
    const sm = SM(); if (sm) { sm.setQuestHint(null); sm.setQuestFound(null); sm.setQuestOutline(null); }
  }
  function regionFor(s) {
    // somewhere near the star, not exactly on it, so the kid has to look
    const a = Math.random() * Math.PI * 2, d = 7;
    const dec = Math.max(-85, Math.min(85, s.dec + Math.sin(a) * d));
    const ra = s.ra + (Math.cos(a) * d) / Math.max(0.2, Math.cos(s.dec * Math.PI / 180));
    return [((ra % 360) + 360) % 360, dec];
  }
  function goStep(i) {
    const sm = SM(); idx = i; misses = 0; hintsShown = 0;
    const step = Q.steps[idx];
    target = sm.starByName(step.star);
    sm.setQuestHint(null); sm.setQuestFound(null);
    if (!target) { console.warn("quest star missing", step.star); return goStep(idx + 1 < Q.steps.length ? idx + 1 : idx); }
    state = "seeking";
    const [ra, dec] = regionFor(target);
    sm.flyToRegion(ra, dec);
    render("seek");
  }
  function progress(doneSteps) {
    const n = Q.steps.length;
    return `<div class="q-progress"><div class="q-bar" style="width:${(doneSteps / n) * 100}%"></div></div>` +
      `<div class="q-dots">${Q.steps.map((_, i) => `<span class="${i < doneSteps ? "on" : i === idx && state === "seeking" ? "cur" : ""}"></span>`).join("")}</div>`;
  }
  function head(label) {
    return `<div class="q-head">${badgeImg(Q, 40, false)}<div class="q-titles"><div class="q-kicker">${esc(label)}</div><h3>${esc(Q.title)}</h3></div>` +
      `<button class="q-x" data-act="quit" title="Quit quest" aria-label="Quit quest">×</button></div>`;
  }
  function render(mode, extra) {
    card.hidden = false;
    const n = Q.steps.length, step = Q.steps[idx];
    let html = "";
    if (mode === "intro") {
      html = head(`${Q.difficulty} quest · ${n} stars`) + progress(0) +
        `<p class="q-clue">${esc(Q.intro)}</p>` +
        `<div class="q-actions"><button class="primary q-big" data-act="go">Let's go!</button></div>`;
    } else if (mode === "seek") {
      html = head(`Step ${idx + 1} of ${n}`) + progress(idx) +
        `<p class="q-clue">${esc(step.clue)}</p>` +
        (extra ? `<div class="q-feedback ${extra.kind || ""}">${extra.html}</div>` : `<div class="q-feedback">Hover over stars to see their names, then click the right one!</div>`) +
        `<div class="q-actions"><button data-act="hint">Hint</button><button data-act="skip" class="q-ghost">Skip</button></div>`;
    } else if (mode === "found") {
      const last = idx === n - 1;
      html = head(`Step ${idx + 1} of ${n}`) + progress(idx + 1) +
        `<div class="q-yay">You found <b>${esc(target.name)}</b>!</div>` +
        `<p class="q-fact"><span>Fun fact</span>${esc(step.fact)}</p>` +
        `<div class="q-actions"><button data-act="gemma">Ask Gemma more</button><button class="primary q-big" data-act="next">${last ? "Get my badge" : "Next star"}</button></div>`;
    } else if (mode === "done") {
      html = head("Quest complete!") + progress(n) +
        `<div class="q-badge-win"><div class="q-badge-big">${badgeImg(Q, 84, false)}</div><div>You earned the<br><b>${esc(Q.badge.name)}</b> badge!<div class="q-outline-note">Look: the glowing lines show <b>${esc(Q.outlineLabel || Q.title)}</b> in the sky.</div></div></div>` +
        `<div class="q-actions"><button data-act="more">Another quest</button><button class="primary q-big" data-act="quit">Back to map</button></div>`;
    }
    card.innerHTML = html;
    card.dataset.mode = mode;
  }
  card.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]"); if (!b || !Q) return;
    const act = b.dataset.act, sm = SM();
    if (act === "quit") quit();
    else if (act === "go") goStep(0);
    else if (act === "hint") giveHint();
    else if (act === "skip") { if (idx + 1 < Q.steps.length) goStep(idx + 1); else finishQuest(); }
    else if (act === "next") { if (idx + 1 < Q.steps.length) goStep(idx + 1); else finishQuest(); }
    else if (act === "gemma") sm.selectStar(target);
    else if (act === "more") { quit(); openPicker(); }
    else if (act === "map") quit();
  });
  function giveHint() {
    hintsShown++;
    const step = Q.steps[idx];
    if (hintsShown >= 2 || misses >= 2) { SM().setQuestHint(target); SM().flyTo(target, 1200); }
    render("seek", { kind: "hint", html: `${esc(step.hint)}${hintsShown >= 2 || misses >= 2 ? "<br><b>Look for the pulsing golden ring!</b>" : ""}` });
  }
  function onStarClick(s) {
    if (!Q || state !== "seeking") return false;
    const sm = SM();
    if (s === target) {
      state = "found";
      sm.setQuestHint(null); sm.setQuestFound(target);
      const p = sm.screenPos(target);
      confetti(p ? p[0] : sm.W / 2, p ? p[1] : sm.H / 2, 70);
      render("found");
      return true;
    }
    misses++;
    const nice = ["Ooh, close!", "Good try!", "Not quite!", "Almost!"][misses % 4];
    let html = `That's <b>${esc(s.name)}</b>. ${nice} ${esc(Q.steps[idx].hint)}`;
    if (misses >= 2) { sm.setQuestHint(target); html += "<br><b>Look for the pulsing golden ring!</b>"; }
    render("seek", { kind: "miss", html });
    card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
    return true;
  }
  function finishQuest() {
    award(Q.id); state = "done";
    const sm = SM(); sm.setQuestHint(null); sm.setQuestFound(null);
    // temporary constellation outline (removed when the quest card is closed)
    const qs = Q.steps.map((st) => sm.starByName(st.star)).filter(Boolean);
    sm.setQuestOutline(Q.constellation ? { con: Q.constellation, label: Q.outlineLabel } : { stars: qs, label: Q.outlineLabel || Q.title });
    // frame the outline: fly to the middle of the quest's stars
    if (qs.length) {
      const v = qs.reduce((a, st) => { const r = st.ra * Math.PI / 180, d = st.dec * Math.PI / 180; a[0] += Math.cos(d) * Math.cos(r); a[1] += Math.cos(d) * Math.sin(r); a[2] += Math.sin(d); return a; }, [0, 0, 0]);
      const ra = (Math.atan2(v[1], v[0]) * 180 / Math.PI + 360) % 360, dec = Math.asin(v[2] / Math.hypot(...v)) * 180 / Math.PI;
      const spread = Math.max(...qs.map((st) => d3.geoDistance([st.ra, st.dec], [ra, dec]))) * 180 / Math.PI;
      sm.flyToRegion(ra, dec, Q.constellation ? 1.7 : Math.max(0.9, Math.min(2, 40 / (spread + 10))));
    }
    confetti(sm.W / 2, sm.H * 0.4, 160);
    render("done");
  }

  // ---------- confetti / sparkles ----------
  const COLORS = ["#ffd66e", "#7aa2ff", "#c08bff", "#ff8ac2", "#7ef0b0", "#ffffff"];
  function confetti(x, y, n) {
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) n = Math.min(n, 12);
    const box = $("confetti");
    for (let i = 0; i < n; i++) {
      const el = document.createElement("i");
      const a = Math.random() * Math.PI * 2, v = 80 + Math.random() * 220;
      el.style.left = x + "px"; el.style.top = y + "px";
      el.style.setProperty("--dx", Math.cos(a) * v + "px");
      el.style.setProperty("--dy", Math.sin(a) * v - 60 + "px");
      el.style.setProperty("--r", (Math.random() * 720 - 360) + "deg");
      el.style.background = COLORS[i % COLORS.length];
      if (i % 5 === 0) { el.className = "spark"; el.textContent = "✦"; el.style.background = "none"; el.style.color = COLORS[i % COLORS.length]; }
      el.style.animationDelay = Math.random() * 120 + "ms";
      box.appendChild(el);
      setTimeout(() => el.remove(), 1700);
    }
  }

  window.StarQuest = { onStarClick, start, quit, openPicker, get active() { return !!Q && state === "seeking"; }, get target() { return target; }, badges };

  fetch("data/quests.json").then((r) => r.json()).then((d) => { quests = d.quests || []; renderBadges(); })
    .catch((e) => console.warn("quests unavailable", e));
})();
