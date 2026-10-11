// Pilgrim Agency site for Railway: static files + Meta Conversions API endpoints.
// ENV: META_PIXEL_ID, META_CAPI_TOKEN, [META_TEST_EVENT_CODE], BOT_USERNAME, WEBHOOK_SECRET,
//      [REDIS_URL], [LEAD_VALUE], [CURRENCY], [BOT_ACTION_SOURCE], [META_API_VERSION]
import http from "node:http";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { sendEvent, capiConfigured, norm } from "./capi.js";
import { store } from "./store.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".ico": "image/x-icon", ".webp": "image/webp" };
const hidden = new Set(["server.js", "capi.js", "store.js", "package.json", "package-lock.json", "TRACKING.md", "README.md"]);

const PIXEL_ID = process.env.META_PIXEL_ID || "";
const BOT = process.env.BOT_USERNAME || "YOUR_BOT";
const SECRET = process.env.WEBHOOK_SECRET || "";
const CURRENCY = process.env.CURRENCY || "UAH";
const LEAD_VALUE = Number(process.env.LEAD_VALUE || 0);
const BOT_SOURCE = process.env.BOT_ACTION_SOURCE || "website"; // website keeps bot events usable for website-optimized campaigns

// ---------- helpers ----------
const DAY = 86400;
const parseCookies = (h = "") => Object.fromEntries(h.split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
const clientIp = (req) => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim().replace(/^::ffff:/, "");
const newId = (n = 12) => crypto.randomBytes(n).toString("base64url");
const validSid = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{8,48}$/.test(s);
const digits = (p) => norm.ph(p || "");
const json = (res, code, obj, headers = {}) => res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }).end(JSON.stringify(obj));

async function readBody(req) {
  let size = 0; const chunks = [];
  for await (const ch of req) { size += ch.length; if (size > 100_000) throw new Error("too large"); chunks.push(ch); }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); }
}

// First-party cookies set by the server live much longer in Safari/ITP than JS cookies.
function cookieHeaders(req, ids) {
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
  const c = (n, v, days) => `${n}=${encodeURIComponent(v)}; Path=/; Max-Age=${days * DAY}; SameSite=Lax${secure}`;
  const out = [];
  if (ids.vid) out.push(c("_vid", ids.vid, 400));
  if (ids.fbp) out.push(c("_fbp", ids.fbp, 90));
  if (ids.fbc) out.push(c("_fbc", ids.fbc, 90));
  return out.length ? { "Set-Cookie": out } : {};
}

// Everything we can learn about the visitor from the request + what the browser sent.
function visitor(req, b) {
  const ck = parseCookies(req.headers.cookie);
  const fbclid = b.fbclid || null;
  const fbc = ck._fbc || b.fbc || (fbclid ? `fb.1.${Date.now()}.${fbclid}` : null);
  const fbp = ck._fbp || b.fbp || `fb.1.${Date.now()}.${Math.floor(Math.random() * 1e10)}`;
  const vid = ck._vid || b.vid || crypto.randomUUID();
  return {
    ip: clientIp(req),
    ua: req.headers["user-agent"] || b.ua,
    fbc, fbp, vid,
    // geo from a CDN header when the site sits behind Cloudflare
    country: req.headers["cf-ipcountry"] && req.headers["cf-ipcountry"] !== "XX" ? req.headers["cf-ipcountry"] : b.country,
    city: req.headers["cf-ipcity"] || b.city,
    lang: req.headers["accept-language"]?.split(",")[0],
  };
}

// Device / page context from the browser → flat custom properties (no PII)
function devProps(d = {}) {
  const pick = { dev_model: d.model, dev_platform: d.platform, dev_os_version: d.platformVersion, dev_mobile: d.mobile,
    dev_browser: d.browser, dev_screen: d.screen, dev_viewport: d.viewport, dev_dpr: d.dpr, dev_lang: d.lang,
    dev_tz: d.tz, dev_net: d.net, dev_mem: d.mem, dev_cpu: d.cpu, dev_touch: d.touch };
  return Object.fromEntries(Object.entries(pick).filter(([, v]) => v != null && v !== ""));
}

const userFromSession = (s = {}, extra = {}) => ({
  ip: s.ip, ua: s.ua, fbc: s.fbc, fbp: s.fbp, country: extra.country || s.country, city: extra.city || s.city,
  email: [extra.email, s.email].filter(Boolean),
  phone: [extra.phone, s.phone].filter(Boolean),
  firstName: extra.firstName || s.firstName,
  lastName: extra.lastName || s.lastName,
  externalId: [s.vid, (extra.tg_id || s.tg_id) && `tg_${extra.tg_id || s.tg_id}`].filter(Boolean),
});
const sessionProps = (s = {}) => ({ ...(s.utm || {}), ...devProps(s.dev), btn: s.btn, referrer: s.referrer, landing: s.path });

// Find the visitor's session by any identifier the bot / payment provider knows
async function findSession(b) {
  let sid = validSid(b.sid) ? b.sid : null;
  if (!sid && b.tg_id) sid = (await store.get(`tg:${b.tg_id}`))?.sid;
  if (!sid && b.phone) sid = (await store.get(`ph:${digits(b.phone)}`))?.sid;
  if (!sid && b.email) sid = (await store.get(`em:${String(b.email).trim().toLowerCase()}`))?.sid;
  return { sid, s: (sid && (await store.get(`s:${sid}`))) || {} };
}
async function remember(sid, data) {
  if (!sid) return {};
  const s = await store.patch(`s:${sid}`, data);
  if (data.tg_id) await store.set(`tg:${data.tg_id}`, { sid });
  if (data.phone) await store.set(`ph:${digits(data.phone)}`, { sid });
  if (data.email) await store.set(`em:${String(data.email).trim().toLowerCase()}`, { sid });
  return s;
}
const nameParts = (b) => {
  const full = String(b.name || "").trim().split(/\s+/);
  return { firstName: b.first_name || b.firstName || full[0] || undefined, lastName: b.last_name || b.lastName || (full.length > 1 ? full.slice(1).join(" ") : undefined) };
};
const authed = (req, url) => !SECRET || req.headers["x-secret"] === SECRET || url.searchParams.get("secret") === SECRET;

// ---------- API routes ----------
const routes = {
  // Any browser event (PageView, ViewContent, ...) mirrored from the pixel with the same eventID
  "POST /capi/event": async (req, b) => {
    const v = visitor(req, b);
    const { value, currency, content_name, content_ids, content_type, content_category, ...rest } = b.custom_data || {};
    const r = await sendEvent({ name: b.event, eventId: b.eventId, url: b.url,
      u: { ...v, externalId: v.vid },
      c: { value, currency, contentName: content_name, contentIds: content_ids, contentType: content_type, contentCategory: content_category,
           custom: { ...(b.utm || {}), ...devProps(b.dev), referrer: b.referrer, ...rest } } });
    return [200, { ok: r.ok }, cookieHeaders(req, v)];
  },

  // Click on a Telegram button: save everything under sid, send Contact
  "POST /f1/click": async (req, b) => {
    const v = visitor(req, b);
    const sid = validSid(b.sid) ? b.sid : newId();
    await remember(sid, { ...v, url: b.url, path: b.path, referrer: b.referrer, utm: b.utm || {}, dev: b.dev || {}, btn: b.btn || null, created: Date.now() });
    const r = await sendEvent({ name: "Contact", eventId: b.eventId || `contact_${sid}`, url: b.url,
      u: { ...v, externalId: v.vid },
      c: { contentName: "hvco_market_2026", custom: { ...(b.utm || {}), ...devProps(b.dev), btn: b.btn, referrer: b.referrer, step: "to_bot" } } });
    return [200, { ok: r.ok, sid, link: `https://t.me/${BOT}?start=${sid}` }, cookieHeaders(req, v)];
  },

  // SendPulse after /start: { sid, tg_id, username?, first_name?, last_name?, language_code? }
  "POST /f1/bot-start": async (req, b) => {
    const { sid, s } = await findSession(b);
    const np = nameParts(b);
    const merged = await remember(sid, { tg_id: b.tg_id, tg_username: b.username, ...np, tg_lang: b.language_code });
    const r = await sendEvent({ name: "CompleteRegistration", eventId: `reg_${sid || b.tg_id}`, url: s.url, actionSource: s.ua ? BOT_SOURCE : undefined,
      u: userFromSession(merged.vid ? merged : s, { ...np, tg_id: b.tg_id }),
      c: { contentName: "telegram_bot", status: sid ? "matched" : "no_session", custom: { ...sessionProps(s), tg_lang: b.language_code, step: "bot_start" } } });
    return [200, { ok: r.ok, matched: !!sid }];
  },

  // Optional: watched / opened the video in the bot
  "POST /f1/video": async (req, b) => {
    const { sid, s } = await findSession(b);
    const r = await sendEvent({ name: "ViewContent", eventId: `video_${sid || b.tg_id}`, url: s.url, actionSource: s.ua ? BOT_SOURCE : undefined,
      u: userFromSession(s, { tg_id: b.tg_id }),
      c: { contentName: b.video || "hvco_video", contentType: "product", contentIds: ["hvco_video"], custom: { ...sessionProps(s), step: "video" } } });
    return [200, { ok: r.ok, matched: !!sid }];
  },

  // Lead in the bot: { tg_id|sid, phone?, email?, name?, lead_type: form|dm, value?, currency? }
  "POST /f1/lead": async (req, b) => {
    const { sid, s } = await findSession(b);
    const np = nameParts(b);
    const merged = await remember(sid, { phone: b.phone, email: b.email, ...np, tg_id: b.tg_id });
    const type = b.lead_type || "form";
    const r = await sendEvent({ name: "Lead", eventId: `lead_${type}_${sid || b.tg_id || digits(b.phone)}`, url: s.url, actionSource: s.ua ? BOT_SOURCE : undefined,
      u: userFromSession(merged.vid ? merged : s, { phone: b.phone, email: b.email, ...np, tg_id: b.tg_id }),
      c: { value: b.value ?? LEAD_VALUE, currency: b.currency || CURRENCY, contentName: b.product || "platform_exit_30d", contentCategory: "lead",
           custom: { ...sessionProps(s), lead_type: type, step: "lead" } } });
    return [200, { ok: r.ok, matched: !!sid }];
  },

  // Payment link sent: { tg_id|sid|phone|email, orderId, value, currency?, product?, productId? }
  "POST /f1/checkout": async (req, b) => {
    const { sid, s } = await findSession(b);
    const np = nameParts(b);
    const r = await sendEvent({ name: "InitiateCheckout", eventId: `ic_${b.orderId || sid || b.tg_id}`, url: s.url, actionSource: s.ua ? BOT_SOURCE : undefined,
      u: userFromSession(s, { phone: b.phone, email: b.email, ...np, tg_id: b.tg_id }),
      c: { value: b.value, currency: b.currency || CURRENCY, contentName: b.product, contentType: "product", numItems: 1,
           contentIds: [String(b.productId || b.product || "offer")],
           contents: [{ id: b.productId || b.product || "offer", quantity: 1, item_price: b.value, title: b.product }],
           custom: { ...sessionProps(s), step: "checkout" } } });
    return [200, { ok: r.ok, matched: !!sid }];
  },

  // Sale (payment webhook / CRM / SendPulse): { orderId, value, currency?, phone?, email?, name?, tg_id?|sid?, product?, productId? }
  "POST /f1/purchase": async (req, b) => {
    if (!b.orderId || b.value == null) return [400, { error: "orderId and value are required" }];
    const { sid, s } = await findSession(b);
    const np = nameParts(b);
    const merged = await remember(sid, { phone: b.phone, email: b.email, ...np, tg_id: b.tg_id });
    const r = await sendEvent({ name: "Purchase", eventId: `purchase_${b.orderId}`, url: s.url, time: b.event_time,
      actionSource: s.ua ? BOT_SOURCE : undefined,
      u: userFromSession(merged.vid ? merged : s, { phone: b.phone, email: b.email, ...np, tg_id: b.tg_id, city: b.city, country: b.country }),
      c: { value: b.value, currency: b.currency || CURRENCY, orderId: b.orderId, contentName: b.product || "platform_exit_30d",
           contentType: "product", numItems: 1, contentIds: [String(b.productId || b.product || "platform_exit_30d")],
           contents: [{ id: b.productId || b.product || "platform_exit_30d", quantity: 1, item_price: b.value, title: b.product }],
           predictedLtv: b.ltv, custom: { ...sessionProps(s), payment: b.payment_method, step: "purchase" } } });
    return [200, { ok: r.ok, matched: !!sid }];
  },
};
const protectedRoutes = new Set(["POST /f1/bot-start", "POST /f1/video", "POST /f1/lead", "POST /f1/checkout", "POST /f1/purchase"]);

// Browser tracking script with config injected from env
let trackTpl = null;
async function serveTrack(res) {
  trackTpl ??= await readFile(join(root, "assets", "track.src.js"), "utf8");
  const js = trackTpl.replace("__PIXEL_ID__", PIXEL_ID).replace("__BOT__", BOT);
  res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" }).end(js);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  const key = `${req.method} ${url.pathname}`;
  try {
    if (routes[key]) {
      if (protectedRoutes.has(key) && !authed(req, url)) return json(res, 401, { error: "bad secret" });
      const body = await readBody(req);
      const [code, obj, headers] = await routes[key](req, body);
      return json(res, code, obj, headers);
    }
    if (key === "GET /health") return json(res, 200, { ok: true, ...capiConfigured(), bot: BOT, redis: !!process.env.REDIS_URL });
    if (key === "GET /track.js") return serveTrack(res);
  } catch (e) {
    console.error("[api]", key, e.message);
    return json(res, 500, { error: "server error" });
  }

  // ---------- static ----------
  let path = decodeURIComponent(url.pathname);
  // "/listv1" -> "/listv1/" keeping ?utm_...&fbclid=... so ad tracking survives the redirect
  if (!path.endsWith("/") && !extname(path)) {
    res.writeHead(301, { Location: url.pathname + "/" + url.search }).end();
    return;
  }
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(path).replace(/^([/\\])+/, "");
  if (file.includes("..") || file.startsWith(".") || hidden.has(file) || file.startsWith("node_modules") || file.endsWith(".src.js")) { res.writeHead(404).end("Not found"); return; }
  try {
    const body = await readFile(join(root, file));
    res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}).listen(process.env.PORT || 8080, "0.0.0.0");
