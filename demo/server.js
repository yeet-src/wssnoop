// wssnoop demo server.
//
// Why this exists: it is a deliberate test target for an eBPF SSL_read/SSL_write
// uprobe snoop. Node statically links OpenSSL, so the outbound wss:// connection
// to Polymarket below is exactly the encrypted traffic the snoop wants to capture.
// The browser <-> server hop is a plain local WS and is not the interesting one.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { WebSocket, WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const HOST = "0.0.0.0";
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "public");

const GAMMA_MARKETS = "https://gamma-api.polymarket.com/markets";
const POLY_WS = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

// Second public wss:// source — Coinbase Exchange ticker feed. No auth, no
// REST priming; toggling a product sends subscribe/unsubscribe frames on the
// link, so the snoop sees a second independent TLS WebSocket on the same pid.
// (Binance is geo-blocked — HTTP 451 — from many hosts; Coinbase is not.)
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";
const COINBASE_PRODUCTS = ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "LTC-USD"];

// --- Polymarket market catalog (REST) ---------------------------------------

// Fetch a handful of active, order-book-enabled markets so the UI has real
// token IDs to subscribe to the moment it loads.
async function fetchMarkets(limit = 12) {
  const url =
    `${GAMMA_MARKETS}?closed=false&active=true&enableOrderBook=true` +
    `&order=volumeNum&ascending=false&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma markets ${res.status}`);
  const raw = await res.json();

  return raw
    .map((m) => {
      const tokenIds = safeParse(m.clobTokenIds);
      const outcomes = safeParse(m.outcomes);
      if (!Array.isArray(tokenIds) || tokenIds.length === 0) return null;
      return {
        conditionId: m.conditionId,
        question: m.question,
        tokens: tokenIds.map((id, i) => ({
          tokenId: id,
          outcome: (outcomes && outcomes[i]) || `Outcome ${i}`,
        })),
      };
    })
    .filter(Boolean);
}

const safeParse = (s) => {
  try {
    return typeof s === "string" ? JSON.parse(s) : s;
  } catch {
    return null;
  }
};

// --- Outbound Polymarket WebSocket (the snoop target) -----------------------
//
// One upstream connection. The active subscription set is the union of token
// IDs the browser has asked for. User toggles in the UI mutate this set and
// emit subscribe/unsubscribe frames on the wss:// link, which is precisely the
// "which subscriptions are active" signal the snoop wants to observe.

class PolyFeed {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.assets = new Set();
    this.ws = null;
    this.ping = null;
    this.connect();
  }

  connect() {
    const ws = new WebSocket(POLY_WS);
    this.ws = ws;

    ws.on("open", () => {
      console.log(`[poly] open ${POLY_WS}`);
      // Re-establish the full subscription set on (re)connect.
      if (this.assets.size) this.send(this.subscribeMsg([...this.assets]));
      this.ping = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10_000);
    });

    ws.on("message", (data) => {
      const text = data.toString();
      if (text === "PONG") return;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      // The market channel batches events into an array.
      const events = Array.isArray(parsed) ? parsed : [parsed];
      for (const e of events) this.onMessage(e);
    });

    ws.on("close", () => {
      console.log("[poly] close; reconnecting in 2s");
      clearInterval(this.ping);
      setTimeout(() => this.connect(), 2000);
    });

    ws.on("error", (err) => console.error("[poly] error", err.message));
  }

  subscribeMsg(ids) {
    return { assets_ids: ids, type: "market", custom_feature_enabled: true };
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  subscribe(ids) {
    const fresh = ids.filter((id) => !this.assets.has(id));
    fresh.forEach((id) => this.assets.add(id));
    if (!fresh.length) return;
    console.log(`[poly] subscribe ${fresh.length} -> ${this.assets.size} active`);
    // First subscription uses the typed init frame; later ones use operation.
    if (this.assets.size === fresh.length) this.send(this.subscribeMsg(fresh));
    else
      this.send({
        assets_ids: fresh,
        operation: "subscribe",
        custom_feature_enabled: true,
      });
  }

  unsubscribe(ids) {
    const drop = ids.filter((id) => this.assets.has(id));
    drop.forEach((id) => this.assets.delete(id));
    if (!drop.length) return;
    console.log(`[poly] unsubscribe ${drop.length} -> ${this.assets.size} active`);
    this.send({ assets_ids: drop, operation: "unsubscribe" });
  }
}

// --- Outbound Coinbase WebSocket (second snoop target) ----------------------
//
// Same toggle-driven model as PolyFeed, different protocol: Coinbase takes
// {type:"subscribe"|"unsubscribe", product_ids:[...], channels:["ticker"]} and
// pushes {type:"ticker", product_id, price, ...} frames back.

class CoinbaseFeed {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.products = new Set(); // e.g. "BTC-USD"
    this.ws = null;
    this.connect();
  }

  connect() {
    const ws = new WebSocket(COINBASE_WS);
    this.ws = ws;

    ws.on("open", () => {
      console.log(`[coinbase] open ${COINBASE_WS}`);
      if (this.products.size) this.frame("subscribe", [...this.products]);
    });

    ws.on("message", (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (parsed?.type === "ticker") this.onMessage(parsed);
    });

    ws.on("close", () => {
      console.log("[coinbase] close; reconnecting in 2s");
      setTimeout(() => this.connect(), 2000);
    });

    ws.on("error", (err) => console.error("[coinbase] error", err.message));
  }

  frame(type, ids) {
    if (this.ws?.readyState === WebSocket.OPEN)
      this.ws.send(JSON.stringify({ type, product_ids: ids, channels: ["ticker"] }));
  }

  subscribe(products) {
    const fresh = products.filter((p) => !this.products.has(p));
    fresh.forEach((p) => this.products.add(p));
    if (!fresh.length) return;
    console.log(`[coinbase] subscribe ${fresh.length} -> ${this.products.size} active`);
    this.frame("subscribe", fresh);
  }

  unsubscribe(products) {
    const drop = products.filter((p) => this.products.has(p));
    drop.forEach((p) => this.products.delete(p));
    if (!drop.length) return;
    console.log(`[coinbase] unsubscribe ${drop.length} -> ${this.products.size} active`);
    this.frame("unsubscribe", drop);
  }
}

// --- Local server: static UI + browser bridge -------------------------------

const markets = await fetchMarkets().catch((e) => {
  console.error("[gamma] failed to fetch markets:", e.message);
  return [];
});
console.log(`[gamma] loaded ${markets.length} active markets`);

const clients = new Set();

const broadcast = (msg) => {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
};

const feed = new PolyFeed((event) => broadcast({ kind: "poly", event }));
const coinbase = new CoinbaseFeed((event) => broadcast({ kind: "coinbase", event }));

const sources = { poly: feed, coinbase };

const httpServer = createServer(async (req, res) => {
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const body = await readFile(join(PUBLIC, path));
    const type = path.endsWith(".html") ? "text/html" : "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const wss = new WebSocketServer({ server: httpServer, path: "/stream" });

wss.on("connection", (client) => {
  clients.add(client);
  // Seed the browser with the catalog and which assets are already live.
  client.send(
    JSON.stringify({
      kind: "init",
      markets,
      active: [...feed.assets],
      coinbaseProducts: COINBASE_PRODUCTS,
      coinbaseActive: [...coinbase.products],
    })
  );

  client.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const target = sources[msg.source] || feed;
    if (msg.action === "subscribe") target.subscribe(msg.assetIds || []);
    else if (msg.action === "unsubscribe") target.unsubscribe(msg.assetIds || []);
  });

  client.on("close", () => clients.delete(client));
});

httpServer.listen(PORT, HOST, () =>
  console.log(`[http] listening on http://${HOST}:${PORT}  (open http://localhost:${PORT})`)
);
