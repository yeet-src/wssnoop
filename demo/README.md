# wssnoop demo

A deliberate **test target** for an eBPF-based WebSocket-monitoring tool
(`wssnoop`). Its only job: generate realistic encrypted WebSocket traffic from
inside a Lima VM out to the live Polymarket API, so a kernel-side snoop hooking
OpenSSL `SSL_read`/`SSL_write` uprobes has something genuine to capture.

## Run it

```sh
make demo
```

Then open **http://localhost:8080** in your Mac browser.

`make demo` is the whole thing: it ensures the `yeet.*` Lima VM is up, installs
Node (via nvm, one-time) and npm deps inside the VM, starts the Node server in
the VM bound to `0.0.0.0:8080`, and forwards that port to the macOS host over an
`ssh -L` tunnel. The command stays in the foreground streaming server logs;
Ctrl-C stops the server and the tunnel.

## Architecture

```
 Mac browser ──local ws──► Node server (in Lima VM) ──wss:// (TLS)──► Polymarket
 http://localhost:8080      server.js + public/index.html             CLOB market channel
        ▲                                                                     ▲
        └────────────── ssh -L 8080 tunnel ──────────────┘      THE SNOOP TARGET (encrypted egress)
```

The Node process holds **one** outbound `wss://` connection to the Polymarket
CLOB market channel. The browser connects back to the server over a plain local
WebSocket (`/stream`). Toggling a market in the UI sends a subscribe/unsubscribe
frame on the outbound `wss://` link — so the set of active subscriptions, the
thing the snoop wants to detect, changes in response to user interaction. The
VM→Polymarket TLS WebSocket is the only interesting hop for snooping; Node
statically links OpenSSL, so it exercises exactly the `SSL_read`/`SSL_write`
path the uprobes hook.

## Polymarket endpoints / message formats

- **Active markets (REST)** — `https://gamma-api.polymarket.com/markets`
  with `?closed=false&active=true&enableOrderBook=true&order=volumeNum&ascending=false&limit=12`.
  Each market exposes `clobTokenIds` (a JSON-string array of token IDs) and
  `outcomes` (e.g. `["Yes","No"]`). These token IDs are what the WS subscribes to.

- **Market data (WebSocket)** — `wss://ws-subscriptions-clob.polymarket.com/ws/market`.
  - Initial subscribe (sent on open):
    `{ "assets_ids": ["<tokenId>", …], "type": "market", "custom_feature_enabled": true }`
  - Dynamic add: `{ "assets_ids": ["<tokenId>"], "operation": "subscribe", "custom_feature_enabled": true }`
  - Dynamic drop: `{ "assets_ids": ["<tokenId>"], "operation": "unsubscribe" }`
  - Keepalive: send the literal string `PING` every 10s; server replies `PONG`.
  - Inbound events arrive batched in an array; each has an `event_type` of
    `book` (full order-book snapshot with `bids`/`asks`/`asset_id`),
    `price_change` (a `price_changes[]` array, each with `asset_id`/`price`/`side`/`size`),
    `last_trade_price`, `tick_size_change`, plus `best_bid_ask`/`new_market`/
    `market_resolved` when custom features are enabled.

Verified against Polymarket's docs (`docs.polymarket.com/developers/CLOB/websocket`)
and the official `Polymarket/agent-skills` repo, and confirmed live by connecting
from inside the VM and inspecting real event field names.

## Notes

- Targets the Lima VM per the yeet project's `CLAUDE.md`. The host home is
  mounted into the VM at the same path, so the VM runs this source directly.
- Node is installed in the VM with nvm on first run; the resulting binary still
  statically links OpenSSL.
