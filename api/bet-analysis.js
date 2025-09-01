// POST /api/bet-analysis  (CFB heartbeat)
// Auth: Authorization: Bearer <Gumroad license key>

const CACHE_TTL = Number(process.env.GUMROAD_VERIFY_CACHE_SECS || 600);
const _cache = new Map(); // in-memory cache (resets on cold start)

function getCache(k){
  const v = _cache.get(k);
  if(!v) return null;
  if(Date.now() - v.t > CACHE_TTL*1000){ _cache.delete(k); return null; }
  return v.data;
}
function setCache(k,data){ _cache.set(k,{ t: Date.now(), data }); }

async function verifyGumroad({ productId, licenseKey, increment=true }){
  const body = new URLSearchParams();
  body.append("product_id", productId);
  body.append("license_key", licenseKey);
  if(increment === false) body.append("increment_uses_count", "false");

  const r = await fetch("https://api.gumroad.com/v2/licenses/verify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if(r.status === 404) return { ok:false, reason:"not_found" };
  const j = await r.json();
  if(!j?.success) return { ok:false, reason:"invalid" };

  const p = j.purchase || {};
  const inactive = Boolean(
    p.refunded || p.chargebacked || p.disputed ||
    p.subscription_ended_at || p.subscription_cancelled_at || p.subscription_failed_at
  );
  return { ok: !inactive, reason: inactive ? "inactive" : null, data: j };
}

export default async function handler(req, res){
  // CORS for bookmarklet running on any site
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if(req.method === "OPTIONS") return res.status(200).end();
  if(req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try{
    const licenseKey = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if(!licenseKey) return res.status(401).json({ error: "Unauthorized" });

    const productId = process.env.GUMROAD_PRODUCT_ID_CFB;
    if(!productId) return res.status(500).json({ error: "Missing GUMROAD_PRODUCT_ID_CFB" });

    const cacheKey = `${productId}:${licenseKey}`;
    let verified = getCache(cacheKey);

    if(!verified){
      const vr = await verifyGumroad({ productId, licenseKey, increment: true }); // increments Gumroad "uses" counter
      if(!vr.ok) return res.status(401).json({ error: `Unauthorized (${vr.reason})` });
      verified = { email: vr.data?.purchase?.email, uses: vr.data?.uses };
      setCache(cacheKey, verified);
    }

    // ✅ Heartbeat success — paywalled endpoint is up
    return res.status(200).json({
      ok: true,
      league: "CFB",
      license_email: verified.email || null,
      uses: verified.uses ?? null,
      message: "License verified. CFB endpoint ready."
    });
  } catch(e){
    return res.status(500).json({ error: e?.message || "Unexpected error" });
  }
}
