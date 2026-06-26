// wssnoop demo worker — a headless stand-in for one of Kairos's order/market
// nodes. It opens several outbound wss:// connections (so one process shows
// MULTIPLE connections in wssnoop) and continuously churns subscriptions, so
// there's live egress AND ingress without anyone touching a browser.
//
//   node worker.mjs --role order-router --feeds coinbase,kraken,poly
//
// `process.title` is set from --role so each worker shows a distinct identity
// in wssnoop (node otherwise reports comm "MainThread" for all of them).
//
// Feeds are all public, no-auth exchange/prediction-market sockets. Each is a
// small adapter: how to connect, what to send to (un)subscribe, and the set of
// instruments to rotate through. The churn loop periodically subscribes and
// unsubscribes a random instrument on each feed — that's the "which
// subscriptions are active" egress signal the prospect cares about.

import { WebSocket } from "ws";

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

const ROLE = arg("role", "ws-worker");
const FEEDS = arg("feeds", "coinbase,kraken,poly").split(",").map((s) => s.trim()).filter(Boolean);
process.title = ROLE;

const log = (...a) => console.log(`[${ROLE}]`, ...a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// --- feed adapters ----------------------------------------------------------

const coinbase = {
  name: "coinbase",
  url: "wss://ws-feed.exchange.coinbase.com",
  instruments: ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "LTC-USD", "ADA-USD", "AVAX-USD"],
  sub: (ids) => JSON.stringify({ type: "subscribe", product_ids: ids, channels: ["ticker"] }),
  unsub: (ids) => JSON.stringify({ type: "unsubscribe", product_ids: ids, channels: ["ticker"] }),
};

const kraken = {
  name: "kraken",
  url: "wss://ws.kraken.com",
  instruments: ["XBT/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD", "DOT/USD"],
  sub: (ids) => JSON.stringify({ event: "subscribe", pair: ids, subscription: { name: "ticker" } }),
  unsub: (ids) => JSON.stringify({ event: "unsubscribe", pair: ids, subscription: { name: "ticker" } }),
};

// Polymarket needs real token ids from the Gamma REST catalog; fetched once at
// startup. Best-effort — if the fetch fails the feed simply carries no
// instruments and the others still drive traffic.
const polymarket = {
  name: "poly",
  url: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  instruments: [],
  sub: (ids) => JSON.stringify({ assets_ids: ids, type: "market" }),
  unsub: (ids) => JSON.stringify({ assets_ids: ids, type: "market", operation: "unsubscribe" }),
  async prime() {
    const url =
      "https://gamma-api.polymarket.com/markets?closed=false&active=true" +
      "&enableOrderBook=true&order=volumeNum&ascending=false&limit=20";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`gamma ${res.status}`);
    const raw = await res.json();
    for (const m of raw) {
      let ids;
      try {
        ids = typeof m.clobTokenIds === "string" ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
      } catch {
        ids = null;
      }
      if (Array.isArray(ids)) this.instruments.push(...ids);
    }
    this.instruments = this.instruments.slice(0, 24);
  },
};

const ADAPTERS = { coinbase, kraken, poly: polymarket };

// --- one live feed connection ----------------------------------------------

class Feed {
  constructor(adapter) {
    this.a = adapter;
    this.active = new Set(); // instruments currently subscribed
    this.ws = null;
    this.connect();
  }

  connect() {
    const ws = new WebSocket(this.a.url);
    this.ws = ws;
    ws.on("open", () => {
      log(`open ${this.a.name}`);
      this.active.clear();
      // Seed with a couple of subscriptions so there's immediate traffic.
      const seed = this.a.instruments.slice(0, 2);
      seed.forEach((i) => this.active.add(i));
      if (seed.length) this.send(this.a.sub(seed));
      // Recycle the connection on a jittered timer: a graceful close emits a
      // CLOSE frame (status signal) and the reconnect a fresh handshake, so
      // wssnoop sees role/dest even when attached mid-stream, and the
      // connection lifecycle (open → closing → closed → reopen) is on display.
      clearTimeout(this.recycle);
      this.recycle = setTimeout(() => this.ws?.close(1000, "recycle"), 60000 + Math.random() * 60000);
    });
    ws.on("message", () => {}); // received frames are what wssnoop observes
    ws.on("close", () => {
      this.ws = null;
      clearTimeout(this.recycle);
      setTimeout(() => this.connect(), 2000);
    });
    ws.on("error", (e) => log(`${this.a.name} error`, e.message));
  }

  send(s) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(s);
  }

  // Toggle one random instrument: subscribe if idle, unsubscribe if active.
  // This is the continuous egress / "active subscription set changes" signal.
  churn() {
    const pool = this.a.instruments;
    if (!pool.length || this.ws?.readyState !== WebSocket.OPEN) return;
    const inst = pick(pool);
    if (this.active.has(inst)) {
      this.active.delete(inst);
      this.send(this.a.unsub([inst]));
    } else {
      this.active.add(inst);
      this.send(this.a.sub([inst]));
    }
  }

  ping() {
    // A WS-level ping (control frame) — egress, exercises PING/PONG RTT.
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
  }
}

// --- main -------------------------------------------------------------------

const feeds = [];
for (const name of FEEDS) {
  const a = ADAPTERS[name];
  if (!a) {
    log(`unknown feed ${name}`);
    continue;
  }
  if (a.prime) await a.prime().catch((e) => log(`${name} prime failed:`, e.message));
  feeds.push(new Feed(a));
}

if (!feeds.length) {
  log("no feeds; exiting");
  process.exit(1);
}

// Churn subscriptions and ping on independent timers, so egress is continuous.
setInterval(() => feeds.forEach((f) => f.churn()), 3000);
setInterval(() => feeds.forEach((f) => f.ping()), 10000);

log(`up — ${feeds.length} feed(s): ${FEEDS.join(", ")}`);
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
