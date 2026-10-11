// Meta Conversions API — direct Graph API calls, no SDK.
// Sends every parameter Meta accepts for website events; hashes PII exactly as Meta requires.
import crypto from "node:crypto";

const PIXEL_ID = process.env.META_PIXEL_ID;
const TOKEN = process.env.META_CAPI_TOKEN;
const TEST_CODE = process.env.META_TEST_EVENT_CODE || null; // remove after testing
const API_VERSION = process.env.META_API_VERSION || "v23.0";
const GRAPH = process.env.META_GRAPH_BASE || "https://graph.facebook.com";

const sha = (v) => crypto.createHash("sha256").update(v, "utf8").digest("hex");
const isHashed = (v) => /^[a-f0-9]{64}$/.test(v);
const hash = (v) => (v == null || v === "" ? undefined : isHashed(String(v)) ? String(v) : sha(String(v)));
const arr = (v) => [].concat(v ?? []).filter((x) => x != null && x !== "");
const uniq = (a) => [...new Set(a)];

// ---- Normalization (Meta "Customer information parameters") ----
export const norm = {
  em: (v) => String(v).trim().toLowerCase(),
  // digits only, with country code. "0671234567" (UA local) -> "380671234567"
  ph: (v) => {
    let d = String(v).replace(/\D/g, "").replace(/^00/, "");
    if (/^0\d{9}$/.test(d)) d = "38" + d;
    return d;
  },
  name: (v) => String(v).trim().toLowerCase().replace(/[\s.,'"`’-]+/g, ""),
  ct: (v) => String(v).trim().toLowerCase().replace(/[^\p{L}]/gu, ""),
  st: (v) => String(v).trim().toLowerCase().replace(/[^\p{L}]/gu, ""),
  zp: (v) => String(v).trim().toLowerCase().replace(/\s|-/g, ""),
  country: (v) => String(v).trim().toLowerCase().slice(0, 2),
  ge: (v) => { const g = String(v).trim().toLowerCase()[0]; return g === "m" || g === "f" ? g : undefined; },
  db: (v) => String(v).replace(/\D/g, "").slice(0, 8), // YYYYMMDD
};

// u: { email, phone, firstName, lastName, gender, dob, city, state, zip, country, externalId,
//      ip, ua, fbc, fbp, leadId, subscriptionId, fbLoginId }
export function buildUserData(u = {}) {
  const ud = {};
  const put = (k, values) => { const a = uniq(arr(values)); if (a.length) ud[k] = a; };
  put("em", arr(u.email).map(norm.em).map(hash));
  put("ph", arr(u.phone).map(norm.ph).filter((p) => p.length >= 9).map(hash));
  put("fn", arr(u.firstName).map(norm.name).map(hash));
  put("ln", arr(u.lastName).map(norm.name).map(hash));
  put("ge", arr(u.gender).map(norm.ge).filter(Boolean).map(hash));
  put("db", arr(u.dob).map(norm.db).filter((d) => d.length === 8).map(hash));
  put("ct", arr(u.city).map(norm.ct).map(hash));
  put("st", arr(u.state).map(norm.st).map(hash));
  put("zp", arr(u.zip).map(norm.zp).map(hash));
  put("country", arr(u.country).map(norm.country).map(hash));
  put("external_id", arr(u.externalId).map((x) => hash(String(x).trim())));
  // NOT hashed:
  if (u.ip) ud.client_ip_address = u.ip;
  if (u.ua) ud.client_user_agent = u.ua;
  if (u.fbc) ud.fbc = u.fbc;
  if (u.fbp) ud.fbp = u.fbp;
  if (u.leadId) ud.lead_id = String(u.leadId);
  if (u.subscriptionId) ud.subscription_id = String(u.subscriptionId);
  if (u.fbLoginId) ud.fb_login_id = String(u.fbLoginId);
  for (const k of Object.keys(ud)) if (Array.isArray(ud[k])) ud[k] = ud[k].filter(Boolean);
  return ud;
}

// c: { value, currency, contents:[{id,quantity,item_price,title}], contentIds, contentType, contentName,
//      contentCategory, numItems, orderId, status, predictedLtv, search, custom:{flat key/values} }
export function buildCustomData(c) {
  if (!c) return undefined;
  const cd = {};
  if (c.value != null && c.value !== "") cd.value = Number(c.value);
  if (c.currency) cd.currency = String(c.currency).toUpperCase();
  if (c.contents?.length) cd.contents = c.contents.map((x) => ({
    id: String(x.id), quantity: Number(x.quantity || 1),
    ...(x.item_price != null ? { item_price: Number(x.item_price) } : {}),
    ...(x.title ? { title: String(x.title) } : {}),
  }));
  if (c.contentIds?.length) cd.content_ids = c.contentIds.map(String);
  if (c.contentType) cd.content_type = c.contentType;
  if (c.contentName) cd.content_name = c.contentName;
  if (c.contentCategory) cd.content_category = c.contentCategory;
  if (c.numItems != null) cd.num_items = Number(c.numItems);
  if (c.orderId) cd.order_id = String(c.orderId);
  if (c.status) cd.status = c.status;
  if (c.predictedLtv != null) cd.predicted_ltv = Number(c.predictedLtv);
  if (c.search) cd.search_string = c.search;
  // Custom properties: flat keys on custom_data (usable in custom conversions / breakdowns)
  for (const [k, v] of Object.entries(c.custom || {})) {
    if (v == null || v === "" || k in cd) continue;
    cd[k] = typeof v === "object" ? JSON.stringify(v) : v;
  }
  return Object.keys(cd).length ? cd : undefined;
}

export function buildEvent({ name, eventId, url, actionSource, u = {}, c = null, time }) {
  const user_data = buildUserData(u);
  // website events need a browser user agent; without one (e.g. payment webhook for an unknown visitor) use system_generated
  const source = actionSource || (user_data.client_user_agent ? "website" : "system_generated");
  const ev = {
    event_name: name,
    event_time: Number(time) || Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: source,
    user_data,
  };
  if (url) ev.event_source_url = url;
  const cd = buildCustomData(c);
  if (cd) ev.custom_data = cd;
  return ev;
}

export async function sendEvent(opts) {
  const ev = buildEvent(opts);
  if (!PIXEL_ID || !TOKEN) {
    console.warn("[CAPI skipped: META_PIXEL_ID / META_CAPI_TOKEN not set]", ev.event_name, ev.event_id);
    return { ok: false, skipped: true, event: ev };
  }
  const body = { data: [ev], ...(TEST_CODE ? { test_event_code: TEST_CODE } : {}) };
  const endpoint = `${GRAPH}/${API_VERSION}/${PIXEL_ID}/events?access_token=${encodeURIComponent(TOKEN)}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        console.log("[CAPI ok]", ev.event_name, ev.event_id, "received:", j.events_received, "fields:", Object.keys(ev.user_data).join(","));
        return { ok: true, events_received: j.events_received, fbtrace_id: j.fbtrace_id };
      }
      console.error("[CAPI err]", ev.event_name, ev.event_id, r.status, JSON.stringify(j));
      if (r.status < 500) return { ok: false, error: j };
    } catch (e) {
      console.error("[CAPI net err]", ev.event_name, ev.event_id, e.message);
    }
  }
  return { ok: false };
}

export const capiConfigured = () => ({ pixel: !!PIXEL_ID, token: !!TOKEN, test: !!TEST_CODE, apiVersion: API_VERSION });
