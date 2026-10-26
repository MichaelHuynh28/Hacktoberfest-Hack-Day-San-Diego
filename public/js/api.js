// Backend calls with a built-in mock so the UI works standalone.
// Mock is used when ?mock=1 is in the URL, or automatically when the
// backend is unreachable (network error, or 404/405/501 from a static server).
(function () {
  const params = new URLSearchParams(location.search);
  const FORCE_MOCK = params.get("mock") === "1";
  const API_BASE = (params.get("api") || "").replace(/\/$/, ""); // e.g. ?api=http://localhost:8000

  const listeners = [];
  const state = { mock: FORCE_MOCK, reason: FORCE_MOCK ? "?mock=1" : null };
  function setMock(reason) {
    if (state.mock) return;
    state.mock = true; state.reason = reason;
    listeners.forEach((fn) => fn(state));
  }

  class BackendUnavailable extends Error {}

  async function post(path, body) {
    let res;
    try {
      res = await fetch(API_BASE + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new BackendUnavailable("network error: " + e.message);
    }
    if ([404, 405, 501].includes(res.status)) throw new BackendUnavailable("HTTP " + res.status);
    let data = null;
    try { data = await res.json(); } catch (_) { /* non-JSON */ }
    if (!res.ok) {
      const msg = (data && (data.error || data.detail || data.message)) || res.statusText || "request failed";
      throw new Error(`Server error (${res.status}): ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
    }
    if (!data) throw new Error("Server returned an invalid (non-JSON) response.");
    return data;
  }

  function fmtDist(s) { return s.dist_ly ? `${s.dist_ly.toLocaleString()} light-years` : "an unknown distance"; }

  function mockExplain(star, question) {
    if (star.kind && !question) {
      return { text: `## ${star.name}: part of our Solar System\n\n**${star.name}** is a ${String(star.type || star.kind).toLowerCase()}. Right now it is about **${star.dist_au} AU** from Earth` +
        `${star.kind !== "sun" ? ` and ${star.sun_au} AU from the Sun` : ""}, in front of ${star.con_name || "the background stars"}.\n\nStart the backend to get a real explanation from Gemma 4.`, mock: true };
    }
    if (question) {
      return { text: `You asked: **${question}**\n\nWhen the Gemma 4 backend is running, it will answer using the catalog facts for **${star.name}** (spectral type ${star.spect || "unknown"}, ${fmtDist(star)}).`, mock: true };
    }
    return {
      text: `## ${star.name} at a glance\n\n` +
        `**${star.name}** sits in ${star.con_name || star.con || "the sky"} and shines at apparent magnitude **${star.mag}**, ` +
        `about ${fmtDist(star)} from Earth.\n\n` +
        `- Spectral type: \`${star.spect || "?"}\`\n- Color index (B−V): ${star.ci ?? "?"}\n\n` +
        `Start the backend (and remove \`?mock=1\` if set) to get a real explanation from Gemma 4.`,
      mock: true,
    };
  }

  function mockTour(stars) {
    const picks = stars.slice(0, 5).map((s) => ({
      id: s.id,
      blurb: `**${s.name}** — magnitude ${s.mag}, ${fmtDist(s)}. Gemma will write a real story here once the backend is up.`,
    }));
    return { picks, mock: true };
  }

  async function withMock(path, body, mockFn) {
    if (state.mock) return mockFn();
    try {
      return await post(path, body);
    } catch (e) {
      if (e instanceof BackendUnavailable) { setMock(e.message); return mockFn(); }
      throw e;
    }
  }

  window.StarAPI = {
    state,
    onModeChange: (fn) => listeners.push(fn),
    explain(star, question, opts = {}) {
      const body = question ? { star, question } : { star };
      if (opts.audience) body.audience = opts.audience; // e.g. "kids" for kid-friendly language
      return withMock("/api/explain", body, () => mockExplain(star, question));
    },
    mockTour,
    tour(stars) {
      return withMock("/api/tour", { stars }, () => mockTour(stars));
    },
  };
})();
