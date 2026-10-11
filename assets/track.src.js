// Pilgrim tracking: Meta Pixel + Conversions API mirror (same eventID → deduplicated).
// Served as /track.js by server.js with PIXEL_ID and BOT injected from env.
(function () {
  var PIXEL_ID = "__PIXEL_ID__";
  var BOT = "__BOT__";
  var FLOW = "__FLOW__"; // SendPulse flow id launched by the button (empty = plain t.me deep link)

  // ---- Meta Pixel base code ----
  !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments) };
    if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = "2.0"; n.queue = []; t = b.createElement(e); t.async = !0;
    t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s) }(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");

  function cookie(n) { var m = document.cookie.match("(^|;)\\s*" + n + "=([^;]*)"); return m ? decodeURIComponent(m[2]) : null; }
  function setCookie(n, v, days) { document.cookie = n + "=" + encodeURIComponent(v) + ";path=/;max-age=" + days * 86400 + ";SameSite=Lax" + (location.protocol === "https:" ? ";Secure" : ""); }
  function uid() { return crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2); }
  function sid() { var a = new Uint8Array(12); crypto.getRandomValues(a); return btoa(String.fromCharCode.apply(null, a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
  var qs = new URLSearchParams(location.search);

  // ---- First-party IDs ----
  var vid = cookie("_vid") || uid(); setCookie("_vid", vid, 400);
  if (qs.get("fbclid")) { var cur = cookie("_fbc"); if (!cur || cur.split(".").pop() !== qs.get("fbclid")) setCookie("_fbc", "fb.1." + Date.now() + "." + qs.get("fbclid"), 90); }
  if (!cookie("_fbp")) setCookie("_fbp", "fb.1." + Date.now() + "." + Math.floor(Math.random() * 1e10), 90);

  // ---- UTM / ad IDs (first touch kept, new click overwrites) ----
  var utmKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "campaign_id", "adset", "adset_id", "ad_id", "placement", "site_source"];
  var utm = {}; try { utm = JSON.parse(localStorage.getItem("_utm") || "{}"); } catch (e) {}
  var fresh = {}; utmKeys.forEach(function (k) { if (qs.get(k)) fresh[k] = qs.get(k); });
  if (Object.keys(fresh).length) utm = fresh;
  try { localStorage.setItem("_utm", JSON.stringify(utm)); } catch (e) {}

  // ---- Device context (no PII) ----
  var nav = navigator, uad = nav.userAgentData;
  var dev = {
    platform: uad ? uad.platform : nav.platform,
    mobile: uad ? uad.mobile : /Mobi|Android|iPhone/i.test(nav.userAgent),
    screen: screen.width + "x" + screen.height,
    viewport: innerWidth + "x" + innerHeight,
    dpr: window.devicePixelRatio || 1,
    lang: nav.language,
    tz: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone,
    net: nav.connection ? nav.connection.effectiveType : undefined,
    mem: nav.deviceMemory, cpu: nav.hardwareConcurrency,
    touch: nav.maxTouchPoints > 0
  };
  var devReady = (uad && uad.getHighEntropyValues
    ? uad.getHighEntropyValues(["model", "platformVersion", "fullVersionList"]).then(function (h) {
        dev.model = h.model || undefined; dev.platformVersion = h.platformVersion;
        var b = (h.fullVersionList || []).filter(function (x) { return !/Not.?A.?Brand|Chromium/i.test(x.brand); })[0];
        if (b) dev.browser = b.brand + " " + b.version;
      }).catch(function () {})
    : Promise.resolve());
  var devTimeout = new Promise(function (r) { setTimeout(r, 400); });
  var ready = Promise.race([devReady, devTimeout]);

  function ctx() {
    return { vid: vid, fbp: cookie("_fbp"), fbc: cookie("_fbc"), fbclid: qs.get("fbclid"), url: location.href, path: location.pathname,
      referrer: document.referrer || undefined, utm: utm, dev: dev };
  }
  function post(path, body) {
    var data = JSON.stringify(body);
    if (navigator.sendBeacon && navigator.sendBeacon(path, new Blob([data], { type: "text/plain" }))) return;
    fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: data, keepalive: true, credentials: "same-origin" });
  }

  // Pixel + CAPI with one eventID
  function track(event, customData) {
    var eventId = event + "_" + uid();
    if (window.fbq && PIXEL_ID) fbq("track", event, customData || {}, { eventID: eventId });
    ready.then(function () { post("/capi/event", Object.assign(ctx(), { event: event, eventId: eventId, custom_data: customData || null })); });
    return eventId;
  }

  if (PIXEL_ID) fbq("init", PIXEL_ID, { external_id: vid });
  track("PageView");

  // ---- Telegram buttons: deep link with sid, Contact event ----
  function wireButtons() {
    document.querySelectorAll("[data-tg-button]").forEach(function (a) {
      a.href = "https://t.me/" + BOT; // fallback if JS below fails
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var s = sid(), btn = a.getAttribute("data-btn") || "button";
        var eventId = "Contact_" + uid();
        var cd = { content_name: "hvco_market_2026", btn: btn };
        if (window.fbq && PIXEL_ID) fbq("track", "Contact", cd, { eventID: eventId });
        post("/f1/click", Object.assign(ctx(), { sid: s, eventId: eventId, btn: btn }));
        // SendPulse link: starts the welcome flow and saves sid (+ source) into the contact's variables
        var link = FLOW
          ? "https://tg.pulse.is/" + BOT + "?start=" + FLOW + "&sid=" + s + "&btn=" + encodeURIComponent(btn) +
            (utm.utm_campaign ? "&utm_campaign=" + encodeURIComponent(utm.utm_campaign) : "") +
            (utm.utm_medium ? "&utm_medium=" + encodeURIComponent(utm.utm_medium) : "")
          : "https://t.me/" + BOT + "?start=" + s;
        setTimeout(function () { location.href = link; }, 150);
      });
    });
  }

  // ---- ViewContent once, when the visitor edits the calculator ----
  function wireCalculator() {
    var sent = false;
    document.querySelectorAll(".calc-input").forEach(function (i) {
      i.addEventListener("change", function () {
        if (sent) return; sent = true;
        var v = function (id) { var el = document.getElementById(id); return el ? el.value : undefined; };
        track("ViewContent", { content_name: "commission_calculator", content_type: "product", content_ids: ["calculator"],
          calc_sessions: v("c-sessions"), calc_price: v("c-price"), calc_fee: v("c-fee") });
      });
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { wireButtons(); wireCalculator(); });
  else { wireButtons(); wireCalculator(); }

  window.PilgrimTrack = { track: track, ctx: ctx };
})();
