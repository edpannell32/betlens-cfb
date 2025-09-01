// POST /api/bet-analysis  (CFB: license-gated + FPI/odds best-effort, never hard-crash)
// Auth: Authorization: Bearer <Gumroad license key>

// -------- Config --------
const THE_ODDS_HOST = "https://api.the-odds-api.com/v4";
const BOOKS = new Set(["draftkings", "fanduel", "betmgm"]);
const CACHE_TTL = Number(process.env.GUMROAD_VERIFY_CACHE_SECS || 600);
const CFB_HFA = Number(process.env.CFB_HFA || 1.7);

// -------- Tiny in-memory cache for license --------
const _cache = new Map();
const getCache = (k) => {
  const v = _cache.get(k);
  if (!v) return null;
  if (Date.now() - v.t > CACHE_TTL * 1000) { _cache.delete(k); return null; }
  return v.data;
};
const setCache = (k, data) => _cache.set(k, { t: Date.now(), data });

// -------- Helpers --------
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
  let j;
  try { j = await r.json(); } catch { return { ok:false, reason:"gumroad_json_error" }; }
  if (!j?.success) return { ok: false, reason: "invalid" };

  const p = j.purchase || {};
  const inactive = Boolean(
    p.refunded || p.chargebacked || p.disputed ||
    p.subscription_ended_at || p.subscription_cancelled_at || p.subscription_failed_at
  );
  return { ok: !inactive, reason: inactive ? "inactive" : null, data: j };
}

async function fetchFPI(team, year) {
  if (!process.env.CFBD_API_KEY) return { fpi: null, note: "Missing CFBD_API_KEY" };
  const url = `https://api.collegefootballdata.com/ratings/fpi?year=${year}&team=${encodeURIComponent(team)}`;
  try {
    const r = await fetch(url, { headers: { accept: "application/json", Authorization: `Bearer ${process.env.CFBD_API_KEY}` } });
    if (!r.ok) return { fpi: null, note: `CFBD ${r.status}` };
    const arr = await r.json();
    const rec = Array.isArray(arr) && arr.length ? arr[0] : null;
    return { fpi: rec?.fpi ?? null, note: rec ? null : "FPI not found" };
  } catch (e) {
    return { fpi: null, note: "CFBD fetch failed" };
  }
}

async function fetchOddsCFB(away, home) {
  if (!process.env.ODDS_API_KEY) return { eventTitle: null, bookLine: null, bookmakerLines: [], note: "Missing ODDS_API_KEY" };
  const url = `${THE_ODDS_HOST}/sports/americanfootball_ncaaf/odds?regions=us&markets=spreads&oddsFormat=american&apiKey=${encodeURIComponent(process.env.ODDS_API_KEY)}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return { eventTitle: null, bookLine: null, bookmakerLines: [], note: `Odds ${r.status}` };
    const data = await r.json();
    const A = norm(away), H = norm(home);
    const ev = data.find(ev => norm(ev.away_team) === A && norm(ev.home_team) === H)
            || data.find(ev => norm(ev.away_team).includes(A) && norm(ev.home_team).includes(H));
    if (!ev) return { eventTitle: null, bookLine: null, bookmakerLines: [], note: "Event not found" };

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

    return { eventTitle: `${ev.away_team} @ ${ev.home_team}`, bookLine: mid, bookmakerLines, note: null };
  } catch (e) {
    return { eventTitle: null, bookLine: null, bookmakerLines: [], note: "Odds fetch failed" };
  }
}

// -------- Handler --------
export default async function handler(req, res) {
  // CORS for bookmarklet
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    // Paywall
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

    // Inputs
    const { away = "", home = "", neutral = false, year } = req.body || {};
    if (!away || !home) return res.status(400).json({ error: "Provide 'away' and 'home' team names." });
    const season = Number.isInteger(year) ? year : new Date().getFullYear();

    // Ratings: FPI for both teams
    const [awayF, homeF] = await Promise.all([fetchFPI(away, season), fetchFPI(home, season)]);

    // Odds (best effort)
    const odds = await fetchOddsCFB(away, home);

    // Build response even if things are missing
    const hfa = neutral ? 0 : CFB_HFA;
    let spread = null, fav = null, favAbs = null, pickLine = null, analysis = "Set ANTHROPIC_API_KEY and Claude later.";
    if (typeof awayF.fpi === "number" && typeof homeF.fpi === "number") {
      spread = Number((homeF.fpi - awayF.fpi + hfa).toFixed(1));
      fav = spread > 0 ? home : (spread < 0 ? away : "Pick'em");
      favAbs = Math.abs(spread).toFixed(1);
      const sign = spread > 0 ? "-" : spread < 0 ? "+" : "";
      pickLine = fav === "Pick'em" ? "PK" : `${fav} ${sign}${favAbs}`;
    }

    const notes = [
      awayF.note ? `awayFPI:${awayF.note}` : null,
      homeF.note ? `homeFPI:${homeF.note}` : null,
      odds.note ? `odds:${odds.note}` : null
    ].filter(Boolean);

    return res.status(200).json({
      ok: true,
      league: "CFB",
      eventTitle: odds.eventTitle || `${away} @ ${home}`,
      away, home, neutral, year: season,
      hfa,
      prUsed: { away: awayF.fpi ?? null, home: homeF.fpi ?? null },
      spread, fav, favAbs, pickLine,
      bookLine: odds.bookLine ?? null,
      bookmakerLines: odds.bookmakerLines,
      notes: notes.length ? notes : undefined,
      analysis
    });
  } catch (e) {
    // Final safety net: never throw a platform error
    return res.status(200).json({ ok: false, error: e?.message || "Unexpected error (caught)" });
  }
}


