#!/usr/bin/env python3
# wssnoop demo — a PLAINTEXT ws:// workload (no TLS), for verifying the
# socket-layer tap. This is the shape an ECS task sees when an ALB terminates
# TLS at the edge and forwards plain ws:// over HTTP/1.1 to the container: the
# process never calls SSL_read/SSL_write, so only the tcp_sendmsg/recvmsg
# capture path can see it — regardless of language.
#
#   python3 ws_plain.py            # server + client on 127.0.0.1:8770, JSON echo
#
# Stdlib-only, hand-rolled RFC-6455 (same framing as worker.py) but over a bare
# TCP socket. One process, two threads (a server and a client talking to it), so
# the loopback traffic goes through the kernel TCP stack and both role
# inferences (the client sent the GET upgrade, the server received it) show up.

import base64
import ctypes
import ctypes.util
import hashlib
import json
import os
import socket
import struct
import threading
import time

HOST, PORT = "127.0.0.1", 8770
GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"  # RFC-6455 handshake magic


def set_comm(name):
    try:
        libc = ctypes.CDLL(ctypes.util.find_library("c") or "libc.so.6", use_errno=True)
        libc.prctl(15, ctypes.c_char_p(name.encode()[:15]), 0, 0, 0)  # PR_SET_NAME
    except Exception:
        pass


def frame(opcode, payload=b"", mask=False):
    n = len(payload)
    hdr = bytearray([0x80 | opcode])
    m = 0x80 if mask else 0
    if n < 126:
        hdr.append(m | n)
    elif n < 65536:
        hdr.append(m | 126)
        hdr += struct.pack("!H", n)
    else:
        hdr.append(m | 127)
        hdr += struct.pack("!Q", n)
    if mask:
        k = os.urandom(4)
        hdr += k
        return bytes(hdr) + bytes(b ^ k[i & 3] for i, b in enumerate(payload))
    return bytes(hdr) + payload


def recvn(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise IOError("closed")
        buf += chunk
    return buf


def recv_frame(sock):
    b0, b1 = recvn(sock, 2)
    ln = b1 & 0x7F
    if ln == 126:
        ln = struct.unpack("!H", recvn(sock, 2))[0]
    elif ln == 127:
        ln = struct.unpack("!Q", recvn(sock, 8))[0]
    key = recvn(sock, 4) if b1 & 0x80 else None
    data = recvn(sock, ln) if ln else b""
    if key:
        data = bytes(b ^ key[i & 3] for i, b in enumerate(data))
    return b0 & 0x0F, data


def read_headers(sock):
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise IOError("closed during handshake")
        buf += chunk
    lines = buf.split(b"\r\n")
    headers = {}
    for line in lines[1:]:
        if b":" in line:
            k, _, v = line.partition(b":")
            headers[k.strip().lower().decode()] = v.strip().decode()
    return lines[0].decode(), headers


def serve(stop):
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((HOST, PORT))
    srv.listen(8)
    srv.settimeout(1.0)
    while not stop.is_set():
        try:
            conn, _ = srv.accept()
        except socket.timeout:
            continue
        threading.Thread(target=serve_conn, args=(conn, stop), daemon=True).start()
    srv.close()


def serve_conn(conn, stop):
    try:
        _, headers = read_headers(conn)
        accept = base64.b64encode(hashlib.sha1((headers.get("sec-websocket-key", "") + GUID).encode()).digest()).decode()
        conn.sendall(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            ).encode()
        )
        while not stop.is_set():
            opcode, data = recv_frame(conn)
            if opcode == 0x8:  # CLOSE
                break
            conn.sendall(frame(0x1, data))  # echo as unmasked text
    except Exception:
        pass
    finally:
        conn.close()


def client(stop):
    while not stop.is_set():
        try:
            sock = socket.create_connection((HOST, PORT), timeout=5)
            key = base64.b64encode(os.urandom(16)).decode()
            sock.sendall(
                (
                    f"GET /feed HTTP/1.1\r\nHost: {HOST}:{PORT}\r\n"
                    "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                    f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
                ).encode()
            )
            read_headers(sock)
            seq = 0
            while not stop.is_set():
                seq += 1
                sock.sendall(frame(0x1, json.dumps({"seq": seq, "px": round(20000 + seq % 500, 2), "sym": "BTC-USD"}).encode(), mask=True))
                recv_frame(sock)  # read the echo
                time.sleep(0.25)
        except Exception:
            time.sleep(1)


def main():
    set_comm("ws-plain")
    stop = threading.Event()
    threading.Thread(target=serve, args=(stop,), daemon=True).start()
    time.sleep(0.3)
    threading.Thread(target=client, args=(stop,), daemon=True).start()
    print(f"ws-plain up — plaintext ws://{HOST}:{PORT}/feed, JSON echo every 250ms", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        stop.set()


if __name__ == "__main__":
    main()
