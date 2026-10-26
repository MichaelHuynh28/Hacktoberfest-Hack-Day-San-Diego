// Star Scout backend: serves ../public and proxies star questions to Gemma 4 via the Gemini API.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const PORT = Number(process.env.PORT) || 3000;
const MODEL = process.env.GEMMA_MODEL || "gemma-4-26b-a4b-it";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));

// ---------- helpers ----------
const cache = new Map();
const CACHE_MAX = 500;
function cacheGet(k) { return cache.get(k); }
function cacheSet(k, v) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(k, v);
}

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function requireKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !key.trim()) {
    throw new HttpError(503, "missing_api_key",
      "GEMINI_API_KEY is not set. Get a key at https://aistudio.google.com/apikey, put it in .env, and restart the server.");
  }
  return key.trim();
}

// Gemma on the Gemini API may not support system instructions, so everything goes in the user turn.
async function callGemma(prompt, { json = false, temperature = 0.6 } = {}) {
  const key = requireKey();
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS) || 8192 },
  };
  let res;
  try {
    res = await fetch(`${API_BASE}/${encodeURIComponent(MODEL)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180000),
    });
  } catch (e) {
    throw new HttpError(502, "upstream_unreachable", `Could not reach the Gemini API: ${e.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `Gemini API returned HTTP ${res.status}`;
    throw new HttpError(res.status === 429 ? 429 : 502, "upstream_error", msg);
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  // Skip any "thought" parts if the model returns reasoning separately.
  const text = parts.filter(p => !p.thought).map(p => p.text || "").join("").trim();
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || "empty response";
    throw new HttpError(502, "empty_response", `Gemma returned no text (${reason}).`);
  }
  return text;
}

const STAR_FIELDS = ["id", "name", "ra", "dec", "mag", "dist_ly", "spect", "con", "con_name", "ci", "absmag", "lum", "proper", "bf", "hip", "hd"];
function cleanStar(s) {
  if (!s || typeof s !== "object") return null;
  const out = {};
  for (const f of STAR_FIELDS) {
    const v = s[f];
    if (v !== undefined && v !== null && v !== "") out[f] = typeof v === "string" ? v.slice(0, 80) : v;
  }
  return out.id !== undefined || out.name ? out : null;
}

function describeFacts(star) {
  const lines = [];
  const add = (label, v, unit = "") => { if (v !== undefined) lines.push(`- ${label}: ${v}${unit}`); };
  add("Catalog id", star.id);
  add("Name", star.name || star.proper);
  add("Bayer/Flamsteed", star.bf);
  add("Hipparcos #", star.hip);
  if (typeof star.ra === "number") {
    // stars.json stores RA in degrees (0-360); also accept hours (0-24) heuristically.
    const hrs = star.ra > 24 ? star.ra / 15 : star.ra;
    add("Right ascension", `${hrs.toFixed(2)}h (${(hrs * 15).toFixed(2)}°)`);
  } else add("Right ascension", star.ra);
  add("Declination", star.dec, "°");
  add("Apparent magnitude", star.mag);
  add("Absolute magnitude", star.absmag);
  add("Distance", star.dist_ly, " light-years");
  add("Spectral type", star.spect);
  add("Constellation (IAU abbrev.)", star.con);
  add("Constellation name", star.con_name);
  add("B-V color index", star.ci);
  add("Luminosity (Sun = 1)", star.lum);
  return lines.join("\n");
}

// Sun's absolute magnitude ~4.83; derive luminosity hint if we can.
function derivedHints(star) {
  const hints = [];
  let absmag = typeof star.absmag === "number" ? star.absmag : undefined;
  if (absmag === undefined && typeof star.mag === "number" && typeof star.dist_ly === "number" && star.dist_ly > 0) {
    const pc = star.dist_ly / 3.26156;
    absmag = star.mag - 5 * (Math.log10(pc) - 1);
  }
  if (absmag !== undefined && Number.isFinite(absmag) && star.lum === undefined) {
    const lum = Math.pow(10, (4.83 - absmag) / 2.5);
    hints.push(`- Derived visual luminosity ≈ ${lum < 10 ? lum.toFixed(2) : Math.round(lum)} × Sun (from magnitude and distance; ignores extinction)`);
  }
  return hints.join("\n");
}

// Gemma sometimes wraps JSON in fences or adds prose; extract the first JSON value robustly.
function parseJsonLoose(text) {
  let t = text.replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(t); } catch {}
  for (const [open, close] of [["{", "}"], ["[", "]"]]) {
    const a = t.indexOf(open), b = t.lastIndexOf(close);
    if (a !== -1 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  }
  return null;
}

// ---------- routes ----------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, model: MODEL, hasKey: Boolean(process.env.GEMINI_API_KEY?.trim()) });
});

app.post("/api/explain", async (req, res, next) => {
  try {
    const star = cleanStar(req.body?.star);
    if (!star) throw new HttpError(400, "bad_request", "Body must include a star object with at least an id or name.");
    const question = typeof req.body?.question === "string" ? req.body.question.trim().slice(0, 500) : "";
    const kids = req.body?.audience === "kids";
    const key = `explain:${MODEL}:${kids ? "kids" : "default"}:${star.id ?? star.name}:${question.toLowerCase()}`;
    const hit = cacheGet(key);
    if (hit) return res.json({ text: hit, cached: true, model: MODEL });
    requireKey();

    const facts = describeFacts(star);
    const hints = derivedHints(star);
    const task = question
      ? `A curious user clicked this star on an interactive Milky Way map and asks: "${question}"
Answer that question about this specific star in 1-3 short paragraphs of Markdown.`
      : `A curious user clicked this star on an interactive Milky Way map. Write a short, friendly explainer in Markdown (about 120-180 words) with:
1. A bold one-line headline naming the star.
2. What kind of star it is (interpret the spectral type and color index in plain language, e.g. color and temperature class).
3. How far away it is, and what that means (e.g. when the light we see left it).
4. How bright it is compared with the Sun, if the data allows.
5. Where it is in the sky (constellation, and roughly which season/hemisphere it is best seen from, based on RA/Dec).
6. One fun fact, clearly well-known; skip it rather than guess.`;

    const kidTask = question
      ? `A kid (age 8-12) clicked this star on an interactive star map and asks: "${question}"
Answer for ages 8-12 in Markdown: short, simple sentences, 3-5 short bullet points or one short paragraph. Use a fun everyday comparison if it helps. Explain any science word you use.`
      : `A kid (age 8-12) clicked this star on an interactive star map. Explain it for ages 8-12 in Markdown (about 80-120 words):
- Start with a bold, exciting one-line headline naming the star.
- Then 3-5 short bullet points in short, simple sentences: what color it is and what kind of star that means, how far away it is (light-years explained simply, e.g. its light left the star N years ago), how bright or big it is compared with our Sun if the data allows, and which constellation to find it in.
- Use fun comparisons kids understand (e.g. "if the Sun were a basketball...", "a car driving nonstop would take...") but only when the numbers come from the catalog data or simple well-known facts.
- End with one line starting with "**Wow fact:**" that is well-known and true; if you are not sure of one, make the wow fact about its distance or brightness from the catalog numbers instead.
- No scary or confusing jargon.`;

    let prompt = `You are ${kids ? "a fun, friendly astronomy guide for kids" : "an astronomy guide for a public star map"}. Be accurate, warm, and concise.

Catalog data for the star (from the HYG star database):
${facts}
${hints ? "\nComputed from the catalog:\n" + hints : ""}

${kids ? kidTask : task}

Rules:
- Ground every number in the catalog data above. Do not invent precise figures (mass, radius, age, temperature in K, planets) that are not given; you may give rough, clearly-hedged ranges typical for the spectral type.
- If the star has no common name, refer to it by its catalog designation, and don't pretend to know a backstory.
- If you are unsure about something, say so briefly.
- Output only the Markdown answer, no preamble.`;

    // Solar System objects (Sun, Moon, planets) shown on the map: describe them as such, not as catalog stars.
    const raw = req.body?.star || {};
    const kind = ["planet", "sun", "moon"].includes(raw.kind) ? raw.kind : null;
    if (kind) {
      const num = (v, d = 3) => (typeof v === "number" && isFinite(v) ? +v.toFixed(d) : undefined);
      const ss = [
        `- Name: ${star.name || star.proper}`,
        `- Kind: ${kind === "sun" ? "the Sun (our star)" : kind === "moon" ? "the Moon (Earth's natural satellite)" : "planet of our Solar System"}`,
        typeof raw.type === "string" ? `- Type: ${raw.type.slice(0, 60)}` : null,
        num(raw.dist_au) !== undefined ? `- Distance from Earth right now: ${num(raw.dist_au, kind === "moon" ? 5 : 3)} AU (1 AU = about 150 million km)` : null,
        num(raw.sun_au) !== undefined && kind !== "sun" ? `- Distance from the Sun right now: ${num(raw.sun_au)} AU` : null,
        star.con_name || star.con ? `- Currently appears in front of the constellation: ${star.con_name || star.con}` : null,
        star.ra !== undefined ? `- Approximate sky position today: RA ${star.ra}°, Dec ${star.dec}°` : null,
      ].filter(Boolean).join("\n");
      const ssTask = kids
        ? `A kid (age 8-12) clicked ${star.name} on an interactive star map${question ? ` and asks: "${question}". Answer in 3-5 short, simple bullet points.` : `. Explain it for ages 8-12 in Markdown (about 80-120 words): a bold, exciting one-line headline, then 3-5 short bullet points in simple sentences (what it is, how far it is from Earth right now using the numbers above, explained with a fun comparison, what it is like there), and end with one line starting with "**Wow fact:**" that is well-known and true.`}`
        : `A curious user clicked ${star.name} on an interactive star map${question ? ` and asks: "${question}". Answer in 1-3 short paragraphs of Markdown.` : `. Write a short, friendly explainer in Markdown (about 120-180 words): a bold one-line headline, what kind of Solar System object it is, how far away it is right now (use the numbers above, e.g. how long its light or sunlight reflected from it takes to reach us), why it wanders against the background stars along the ecliptic, and one well-known fun fact.`}`;
      prompt = `You are ${kids ? "a fun, friendly astronomy guide for kids" : "an astronomy guide for a public star map"}. Be accurate, warm, and concise.

This is a Solar System object, not a distant star. Data computed by the map for today:
${ss}

${ssTask}

Rules:
- Describe it as a member of our Solar System (Sun, Moon or planet), not as a star from a star catalog.
- Use only the distances given above for "right now" numbers; other well-known facts (size, moons, rings, day length) are fine if you are sure of them.
- ${kind === "sun" ? "Remind readers never to look directly at the Sun." : "If you are unsure about something, say so briefly."}
- Output only the Markdown answer, no preamble.`;
    }

    const text = await callGemma(prompt, { temperature: 0.5 });
    cacheSet(key, text);
    res.json({ text, cached: false, model: MODEL });
  } catch (e) { next(e); }
});

app.post("/api/tour", async (req, res, next) => {
  try {
    const raw = Array.isArray(req.body?.stars) ? req.body.stars : null;
    if (!raw || raw.length === 0) throw new HttpError(400, "bad_request", "Body must include a non-empty stars array.");
    const stars = raw.map(cleanStar).filter(Boolean).slice(0, 150);
    if (stars.length === 0) throw new HttpError(400, "bad_request", "No valid stars in the list.");
    const ids = new Set(stars.map(s => String(s.id)));
    const kids = req.body?.audience === "kids";
    const key = `tour:${MODEL}:${kids ? "kids" : "default"}:${[...ids].sort().join(",")}`;
    const hit = cacheGet(key);
    if (hit) return res.json({ picks: hit, cached: true, model: MODEL });
    requireKey();

    const compact = stars.map(s => ({ id: s.id, name: s.name || s.proper, mag: s.mag, dist_ly: s.dist_ly, spect: s.spect, con: s.con, ci: s.ci }));
    const n = Math.min(5, stars.length);
    const prompt = `You are an astronomy guide creating a short guided tour of a star map.
From the star list below (JSON, from the HYG database), pick the ${n} most interesting stars for a general audience (variety of colors/types, famous names, very near or very far, very bright). For each, write a 1-2 sentence blurb grounded only in the given data plus well-known facts; do not invent precise numbers.${kids ? `
The audience is kids aged 8-12: write each blurb in short, simple, exciting sentences, with a fun comparison where it fits (still using only the given numbers), and no jargon.` : ""}

Return ONLY valid JSON, no code fences, in exactly this shape:
{"picks":[{"id":<id from the list>,"blurb":"..."}]}

Stars:
${JSON.stringify(compact)}`;

    const text = await callGemma(prompt, { json: true, temperature: 0.7 });
    const parsed = parseJsonLoose(text);
    let picks = Array.isArray(parsed) ? parsed : parsed?.picks;
    picks = (Array.isArray(picks) ? picks : [])
      .filter(p => p && ids.has(String(p.id)))
      .map(p => ({ id: stars.find(s => String(s.id) === String(p.id)).id, blurb: String(p.blurb || "").trim() }))
      .filter((p, i, arr) => arr.findIndex(q => String(q.id) === String(p.id)) === i)
      .slice(0, n);

    // Fallback: if parsing failed, choose the brightest stars with a plain blurb.
    let fallback = false;
    if (picks.length === 0) {
      fallback = true;
      picks = [...stars]
        .sort((a, b) => (a.mag ?? 99) - (b.mag ?? 99))
        .slice(0, n)
        .map(s => ({
          id: s.id,
          blurb: `${s.name || s.proper || "Star " + s.id}${s.con ? " in " + s.con : ""}` +
            `${s.mag !== undefined ? `, magnitude ${s.mag}` : ""}${s.dist_ly !== undefined ? `, about ${Math.round(s.dist_ly)} light-years away` : ""}.`,
        }));
    } else {
      cacheSet(key, picks);
    }
    res.json({ picks, cached: false, fallback, model: MODEL });
  } catch (e) { next(e); }
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Unknown API route.", code: "not_found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") err = new HttpError(400, "bad_json", "Request body is not valid JSON.");
  const status = err.status || 500;
  if (status >= 500 && !(err instanceof HttpError)) console.error(err);
  res.status(status).json({ error: err.message || "Internal error", code: err.code || "server_error" });
});

app.listen(PORT, () => {
  console.log(`Star Scout running at http://localhost:${PORT}  (model: ${MODEL}${process.env.GEMINI_API_KEY ? "" : ", NO API KEY SET"})`);
});
