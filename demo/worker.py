#!/usr/bin/env python3
# wssnoop demo worker — the Python counterpart to worker.mjs, so the demo has a
# SECOND runtime for discovery to distinguish. node bakes OpenSSL into its
# executable (static — the tap probes the exe); Python's `ssl` loads libssl
# dynamically, so this process is the *dynamic-SSL* case the binary discovery
# has to handle (probe the mapped libssl, not the interpreter).
#
#   python3 worker.py --role risk-engine --feeds coinbase,kraken
#
# Deliberately stdlib-only (no `websockets`/`pip` in the VM): a hand-rolled
# RFC-6455 client over ssl.socket. It opens one outbound wss:// per feed and
# churns subscriptions, same shape as worker.mjs, so it shows several live
# connections with continuous egress + ingress.

import argparse
import base64
import ctypes
import ctypes.util
import json
import os
import random
import select
import socket
import ssl
import struct
import sys
import threading
import time

# --- feed adapters (mirror worker.mjs: url + how to (un)subscribe) ----------
FEEDS = {
    "coinbase": {
        "url": "wss://ws-feed.exchange.coinbase.com",
        "instruments": ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "LTC-USD", "ADA-USD", "AVAX-USD"],
        "sub": lambda ids: json.dumps({"type": "subscribe", "product_ids": ids, "channels": ["ticker"]}),
        "unsub": lambda ids: json.dumps({"type": "unsubscribe", "product_ids": ids, "channels": ["ticker"]}),
    },
    "kraken": {
        "url": "wss://ws.kraken.com",
        "instruments": ["XBT/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD", "DOT/USD"],
        "sub": lambda ids: json.dumps({"event": "subscribe", "pair": ids, "subscription": {"name": "ticker"}}),
        "unsub": lambda ids: json.dumps({"event": "unsubscribe", "pair": ids, "subscription": {"name": "ticker"}}),
    },
}


def set_comm(name):
    """Rename the process (comm) to the role, matching worker.mjs's
    process.title — so run.sh's comm-based worker identification, `status`, and
    `stop` treat node and python workers identically. Best-effort via prctl."""
    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)
        libc.prctl(15, ctypes.c_char_p(name.encode()[:15]), 0, 0, 0)  # PR_SET_NAME
    except Exception:
        pass


def parse_wss(url):
    assert url.startswith("wss://"), url
    host, _, path = url[6:].partition("/")
    host, _, port = host.partition(":")
    return host, int(port or 443), "/" + path


class WSConn:
    """A minimal RFC-6455 client over one TLS socket: connect + HTTP upgrade,
    masked text sends, frame reads (payload discarded — the tap reads the wire),
    graceful close."""

    def __init__(self, url):
        self.host, self.port, self.path = parse_wss(url)
        self.sock = None

    def connect(self):
        raw = socket.create_connection((self.host, self.port), timeout=10)
        ctx = ssl.create_default_context()
        self.sock = ctx.wrap_socket(raw, server_hostname=self.host)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise IOError("closed during handshake")
            buf += chunk
        if b" 101 " not in buf.split(b"\r\n", 1)[0]:
            raise IOError("upgrade rejected: " + buf.split(b"\r\n", 1)[0].decode("latin1"))

    def _send(self, opcode, payload=b""):
        n = len(payload)
        hdr = bytearray([0x80 | opcode])
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += struct.pack("!H", n)
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack("!Q", n)
        mask = os.urandom(4)
        hdr += mask
        self.sock.sendall(bytes(hdr) + bytes(b ^ mask[i & 3] for i, b in enumerate(payload)))

    def send_text(self, s):
        self._send(0x1, s.encode())

    def _recvn(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise IOError("closed")
            buf += chunk
        return buf

    def recv_frame(self):
        """Read and discard one frame. Blocking — call only when readable."""
        b0, b1 = self._recvn(2)
        ln = b1 & 0x7f
        if ln == 126:
            ln = struct.unpack("!H", self._recvn(2))[0]
        elif ln == 127:
            ln = struct.unpack("!Q", self._recvn(8))[0]
        if b1 & 0x80:  # server frames are unmasked, but be safe
            self._recvn(4)
        if ln:
            self._recvn(ln)
        return b0 & 0x0f

    def readable(self, timeout):
        # ssl may hold decrypted bytes past the raw fd; check both.
        if self.sock.pending():
            return True
        return bool(select.select([self.sock], [], [], timeout)[0])

    def close(self):
        try:
            self._send(0x8)  # CLOSE
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


def run_feed(role, adapter, recycle_ms, stop):
    """One feed's lifecycle loop: connect, seed subscriptions, churn on a timer,
    recycle on a jittered deadline, reconnect after a drop."""
    name = adapter["url"]
    pool = adapter["instruments"]
    while not stop.is_set():
        conn = WSConn(adapter["url"])
        active = set()
        try:
            conn.connect()
            print(f"[{role}] open {name}", flush=True)
            seed = pool[:2]
            active.update(seed)
            conn.send_text(adapter["sub"](seed))
            deadline = time.time() + (recycle_ms / 1000) * (1 + random.random()) if recycle_ms else None
            next_churn = time.time() + 3
            while not stop.is_set():
                now = time.time()
                if deadline and now >= deadline:
                    conn.close()
                    break
                if now >= next_churn:
                    next_churn = now + 3
                    inst = random.choice(pool)
                    if inst in active:
                        active.discard(inst)
                        conn.send_text(adapter["unsub"]([inst]))
                    else:
                        active.add(inst)
                        conn.send_text(adapter["sub"]([inst]))
                if conn.readable(1.0):
                    conn.recv_frame()
        except Exception as e:  # noqa: BLE001 — a demo worker just retries
            print(f"[{role}] {name} error: {e}", flush=True)
            conn.close()
        if not stop.is_set():
            time.sleep(2)  # reconnect backoff


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--role", default="ws-worker")
    ap.add_argument("--feeds", default="coinbase,kraken")
    ap.add_argument("--delay", type=int, default=0)  # ms before dialing out
    ap.add_argument("--recycle", type=int, default=60000)  # 0 = never
    args, _ = ap.parse_known_args()

    set_comm(args.role)
    if args.delay:
        print(f"[{args.role}] waiting {args.delay}ms before connecting…", flush=True)
        time.sleep(args.delay / 1000)

    feeds = [FEEDS[f.strip()] for f in args.feeds.split(",") if f.strip() in FEEDS]
    if not feeds:
        print(f"[{args.role}] no known feeds; exiting", flush=True)
        sys.exit(1)

    stop = threading.Event()
    threads = [threading.Thread(target=run_feed, args=(args.role, a, args.recycle, stop), daemon=True) for a in feeds]
    for t in threads:
        t.start()
    print(f"[{args.role}] up — {len(feeds)} feed(s): {args.feeds}", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        stop.set()


if __name__ == "__main__":
    main()
