// POST /api/bet-analysis  (CFB version: FPI for ratings + Odds + model + optional Claude)
// Auth: Authorization: Bearer <Gumroad license key>

import Anthropic from "@anthropic-ai/sdk";

// ---------- Config ----------
const THE_ODDS_HOST = "https://api.the-odds-api.com/v4";
const BOOKS = new Set(["draftkings", "fanduel", "betmgm"]);
const CACHE_TTL = Number(process.env.GUMROAD_VERIFY_CACHE_SECS || 600);
const CFB_HFA = Number(process.env.CFB_HFA || 1.7);

// ---------- Simple in-memory cache for license ----------
const _cache = new Map(); // resets on cold start
const getCache = (k) => {
  const v = _cache.get(k);
  if (!v) return null;
  if (Date.now() - v.t > CACHE_TTL * 1000) { _cache.delete(k); return null; }
  return v.data;
};
const setCache = (k, data) => _cache.set(k, { t: Date.now(), data });

// ---------- Helpers ----------
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();

async function verifyGumroad({ productId, licenseKey, increment = true }) {
  const body = new URLSearchParams();
  body.append("product_id", productId);
  body.append("license_key", licenseKey);
  if (increment === false) body.append("increment_uses_count", "false");

  const r = await fetch("https://api.gumroad.com/v2/licenses/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  if (r.status === 404) return { ok: false, reason: "not_found" };
  const j = await r.json();
  if (!j?.success) return { ok: false, reason: "invalid" };

  const p = j.purchase || {};
  const inactive = Boolean(
    p.refunded || p.chargebacked || p.disputed ||
    p.subscription_ended_at || p.subscription_cancelled_at || p.subscription_failed_at
  );
  return { ok: !inactive, reason: inactive ? "inactive" : null, data: j };
}

async function fetchOddsCFB(away, home) {
  const url = `${THE_ODDS_HOST}/sports/americanfootball_ncaaf/odds?regions=us&markets=spreads&oddsFormat=american&apiKey=${encodeURIComponent(process.env.ODDS_API_KEY)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Odds API error ${r.status}`);
  const data = await r.json();

  const A = norm(away), H = norm(home);
  const ev = data.find(ev => norm(ev.away_team) === A && norm(ev.home_team) === H)
          || data.find(ev => norm(ev.away_team).includes(A) && norm(ev.home_team).includes(H));
  if (!ev) return { eventTitle: null, bookLine: null, bookmakerLines: [] };

  const bookmakerLines = [];
  for (const bm of ev.bookmakers || []) {
    if (!BOOKS.has(bm.key)) continue;
    const spreads = (bm.markets || []).find(m => m.key === "spreads");
    if (!spreads) continue;
    const homeOutcome = (spreads.outcomes || []).find(o => norm(o.name) === norm(ev.home_team));
    if (!homeOutcome || typeof homeOutcome.point !== "number") continue;
    bookmakerLines.push({ book: bm.key, homeLine: homeOutcome.point, last_update: bm.last_update });
  }
  bookmakerLines.sort((a,b)=>a.homeLine-b.homeLine);
  const mid = bookmakerLines.length ? bookmakerLines[Math.floor(bookmakerLines.length/2)].homeLine : null;

  return { eventTitle: `${ev.away_team} @ ${ev.home_team}`, bookLine: mid, bookmakerLines };
}

async function fetchFPI(team, year) {
  const url = `https://api.collegefootballdata.com/ratings/fpi?year=${year}&team=${encodeURIComponent(team)}`;
  const r = await fetch(url, { headers: { accept: "application/json", Authorization: `Bearer ${process.env.CFBD_API_KEY}` } });
  if (!r.ok) return null;
  const arr = await r.json();
  return Array.isArray(arr) && arr.length ? arr[0] : null; // { team, fpi, ... }
}

// ---------- Handler ----------
export default async function handler(req, res) {
  // CORS for bookmarklet
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // --- Paywall (Gumroad CFB) ---
    const licenseKey = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!licenseKey) return res.status(401).json({ error: "Unauthorized" });

    const productId = process.env.GUMROAD_PRODUCT_ID_CFB;
    if (!productId) return res.status(500).json({ error: "Missing GUMROAD_PRODUCT_ID_CFB" });

    const cacheKey = `${productId}:${licenseKey}`;
    let verified = getCache(cacheKey);
    if (!verified) {
      const vr = await verifyGumroad({ productId, licenseKey, increment: true });
      if (!vr.ok) return res.status(401).json({ error: `Unauthorized (${vr.reason})` });
      verified = { email: vr.data?.purchase?.email, uses: vr.data?.uses };
      setCache(cacheKey, verified);
    }

    // --- Inputs ---
    const { away = "", home = "", neutral = false, year } = req.body || {};
    if (!away || !home) {
      return res.status(400).json({ error: "Provide 'away' and 'home' team names." });
    }
    const season = Number.isInteger(year) ? year : new Date().getFullYear();

    // --- Ratings: FPI for both teams (primary power rating) ---
    const awayFpi = await fetchFPI(away, season);
    const homeFpi = await fetchFPI(home, season);

    if (!awayFpi?.fpi || !homeFpi?.fpi) {
      return res.status(200).json({
        ok: true,
        league: "CFB",
        away, home, neutral, year: season,
        hfa: neutral ? 0 : CFB_HFA,
        note: "FPI not found for one or both teams. Try using disambiguated names like 'Miami (FL)'.",
        prUsed: { away: awayFpi?.fpi ?? null, home: homeFpi?.fpi ?? null },
        bookLine: null, bookmakerLines: [],
        analysis: "Missing FPI prevents model pick."
      });
    }

    // --- Odds (TheOddsAPI: DK/FD/MGM consensus) ---
    const { eventTitle, bookLine, bookmakerLines } = await fetchOddsCFB(away, home);

    // --- Model spread (home perspective) ---
    const hfa = neutral ? 0 : CFB_HFA;
    const spread = Number((homeFpi.fpi - awayFpi.fpi + hfa).toFixed(1));
    const fav = spread > 0 ? home : (spread < 0 ? away : "Pick'em");
    const favAbs = Math.abs(spread).toFixed(1);
    const sign = spread > 0 ? "-" : spread < 0 ? "+" : "";
    const pickLine = fav === "Pick'em" ? "PK" : `${fav} ${sign}${favAbs}`;

    const bookCompare = (typeof bookLine === "number")
      ? `Consensus home line (DK/FD/MGM): ${bookLine > 0 ? `+${bookLine}` : bookLine}. Model edge = ${(spread - bookLine).toFixed(1)}.`
      : "No consensus line available for this match right now.";

    // --- Optional: Claude analysis ---
    let analysis = "Set ANTHROPIC_API_KEY to enable AI analysis.";
    if (process.env.ANTHROPIC_API_KEY) {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const system = "You are a sharp betting analyst. ≤150 words. Use the model spread and compare to the market. Mention key numbers (3,7,10,14) if relevant. End with a clear pick.";
      const user = `League: CFB
Year: ${season}
Away: ${away}
Home: ${home}
Neutral site: ${neutral ? "Yes" : "No"}
HFA used: ${hfa}
Ratings source: ESPN FPI (via CollegeFootballData)
FPI used: ${away}=${awayFpi.fpi}, ${home}=${homeFpi.fpi}
Model spread (Home - Away + HFA): ${spread} (${pickLine})
${bookCompare}
Books: DraftKings, FanDuel, BetMGM.
Finish with: Play: ${pickLine} (model).`;

      const msg = await anthropic.messages.create({
        model: "claude-3-7-sonnet-20250219",
        max_tokens: 400,
        system,
        messages: [{ role: "user", content: user }]
      });
      analysis = (Array.isArray(msg?.content) && msg.content[0]?.text) || "No analysis generated.";
    }

    return res.status(200).json({
      ok: true,
      league: "CFB",
      eventTitle: eventTitle || `${away} @ ${home}`,
      away, home, neutral, year: season,
      hfa,
      prUsed: { away: awayFpi.fpi, home: homeFpi.fpi },
      spread, fav, favAbs,
      bookLine: bookLine ?? null,
      bookmakerLines,
      analysis
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unexpected error" });
  }
}

