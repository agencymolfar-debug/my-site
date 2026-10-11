// Session store for the landing → Telegram bot → lead → purchase funnel.
// Uses Redis when REDIS_URL is set (Railway: Add → Redis); falls back to memory (lost on restart — testing only).
const TTL = 90 * 24 * 3600; // 90 days, same as the _fbc click window

let redis = null;
if (process.env.REDIS_URL) {
  const { createClient } = await import("redis");
  redis = createClient({ url: process.env.REDIS_URL });
  redis.on("error", (e) => console.error("[redis]", e.message));
  await redis.connect();
  console.log("[store] redis connected");
} else {
  console.warn("[store] REDIS_URL not set — using in-memory store (data lost on restart)");
}

const mem = new Map();

export const store = {
  async get(key) {
    if (!key) return null;
    if (redis) { const v = await redis.get(key); return v ? JSON.parse(v) : null; }
    return mem.get(key) || null;
  },
  async set(key, value) {
    if (!key) return;
    if (redis) await redis.set(key, JSON.stringify(value), { EX: TTL });
    else mem.set(key, value);
  },
  async patch(key, value) {
    const cur = (await this.get(key)) || {};
    const next = { ...cur };
    for (const [k, v] of Object.entries(value)) if (v != null && v !== "") next[k] = v; // never wipe known data
    await this.set(key, next);
    return next;
  },
};
