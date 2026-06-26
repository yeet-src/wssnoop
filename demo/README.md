# wssnoop demo

A deliberate **test target** for `wssnoop`: it generates realistic encrypted
WebSocket traffic from inside the Lima VM out to live exchange / prediction-
market APIs, so the kernel-side snoop hooking OpenSSL `SSL_read`/`SSL_write`
uprobes has something genuine to capture.

## Run it (headless — the primary demo)

```sh
./demo/run.sh attach     # start the traffic AND launch wssnoop attached to it
./demo/run.sh start      # just the traffic; prints the wssnoop attach command
./demo/run.sh docker     # run the workers in a container; shows the ⬢ nesting tier
./demo/run.sh stop       # stop the workers (and the demo container)
./demo/run.sh            # (or `help`) usage
```

Run inside the yeet VM. `run.sh` starts **three worker processes**
(`order-router`, `md-gateway`, `risk-engine` — `demo/worker.mjs`), each holding
several live `wss://` connections (Coinbase + Kraken + Polymarket) and
continuously churning subscriptions and pinging — so wssnoop has rich
multi-process, multi-connection, bidirectional traffic immediately, no browser.
Connections recycle on a timer so a mid-stream attach still catches fresh
handshakes; `--attach` starts the workers first (short connect delay) so wssnoop
captures every handshake cleanly.

## Run it (browser — alternative)

```sh
./demo/run-browser.sh      # then open http://localhost:8080
```

`run-browser.sh` ensures the VM is up, installs Node + deps, starts `server.js`
(one Polymarket connection driven by a browser UI bound to `0.0.0.0:8080`), and
forwards that port to the host over an `ssh -L` tunnel. Toggling a market in the
UI sends subscribe/unsubscribe frames on the outbound `wss://` link — the
active-subscription signal the snoop detects.

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
