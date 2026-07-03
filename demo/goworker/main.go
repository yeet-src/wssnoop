// wssnoop demo worker — the Go counterpart to worker.mjs / worker.py, using
// gorilla/websocket (the demo stack's Go library). Go's TLS is crypto/tls (pure
// Go, no OpenSSL), so this is the process the SSL uprobe can't see; wssnoop
// decodes it through Go-ABI uprobes on crypto/tls.(*Conn).Write/Read instead.
//
//	go-worker --role md-gateway --feeds coinbase,kraken
//
// One outbound wss:// per feed, seeded subscriptions churned on a timer — same
// shape as the other workers, so it shows several live connections with
// continuous egress + ingress.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type feed struct {
	url         string
	instruments []string
	sub         func([]string) string
	unsub       func([]string) string
}

func coinbaseMsg(kind string) func([]string) string {
	return func(ids []string) string {
		b, _ := json.Marshal(map[string]any{"type": kind, "product_ids": ids, "channels": []string{"ticker"}})
		return string(b)
	}
}
func krakenMsg(kind string) func([]string) string {
	return func(ids []string) string {
		b, _ := json.Marshal(map[string]any{"event": kind, "pair": ids, "subscription": map[string]string{"name": "ticker"}})
		return string(b)
	}
}

var feeds = map[string]feed{
	"coinbase": {
		url:         "wss://ws-feed.exchange.coinbase.com",
		instruments: []string{"BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "LTC-USD", "ADA-USD", "AVAX-USD"},
		sub:         coinbaseMsg("subscribe"), unsub: coinbaseMsg("unsubscribe"),
	},
	"kraken": {
		url:         "wss://ws.kraken.com",
		instruments: []string{"XBT/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD", "DOT/USD"},
		sub:         krakenMsg("subscribe"), unsub: krakenMsg("unsubscribe"),
	},
}

func runFeed(role string, f feed, recycle time.Duration, wg *sync.WaitGroup) {
	defer wg.Done()
	for {
		func() {
			c, _, err := websocket.DefaultDialer.Dial(f.url, nil)
			if err != nil {
				fmt.Printf("[%s] %s dial error: %v\n", role, f.url, err)
				time.Sleep(2 * time.Second)
				return
			}
			defer c.Close()
			fmt.Printf("[%s] open %s\n", role, f.url)

			active := map[string]bool{}
			seed := f.instruments[:2]
			for _, s := range seed {
				active[s] = true
			}
			_ = c.WriteMessage(websocket.TextMessage, []byte(f.sub(seed)))

			// Reader goroutine: drain frames (the tap reads the wire, not us).
			done := make(chan struct{})
			go func() {
				defer close(done)
				for {
					if _, _, err := c.ReadMessage(); err != nil {
						return
					}
				}
			}()

			churn := time.NewTicker(3 * time.Second)
			defer churn.Stop()
			var deadline <-chan time.Time
			if recycle > 0 {
				deadline = time.After(recycle + time.Duration(rand.Int63n(int64(recycle+1))))
			}
			for {
				select {
				case <-done:
					return
				case <-deadline:
					_ = c.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
					return
				case <-churn.C:
					inst := f.instruments[rand.Intn(len(f.instruments))]
					if active[inst] {
						delete(active, inst)
						_ = c.WriteMessage(websocket.TextMessage, []byte(f.unsub([]string{inst})))
					} else {
						active[inst] = true
						_ = c.WriteMessage(websocket.TextMessage, []byte(f.sub([]string{inst})))
					}
				}
			}
		}()
	}
}

func main() {
	role := flag.String("role", "go-worker", "process identity")
	feedList := flag.String("feeds", "coinbase,kraken", "comma-separated feeds")
	delay := flag.Int("delay", 0, "ms before dialing out")
	recycle := flag.Int("recycle", 0, "recycle each connection every ~ms (0 = never)")
	flag.Parse()

	// Rename the process (comm) to the role, matching the other workers so
	// run.sh's comm-based identification treats them alike. Best-effort.
	setComm(*role)

	if *delay > 0 {
		fmt.Printf("[%s] waiting %dms before connecting…\n", *role, *delay)
		time.Sleep(time.Duration(*delay) * time.Millisecond)
	}

	var wg sync.WaitGroup
	n := 0
	for _, name := range strings.Split(*feedList, ",") {
		if f, ok := feeds[strings.TrimSpace(name)]; ok {
			wg.Add(1)
			n++
			go runFeed(*role, f, time.Duration(*recycle)*time.Millisecond, &wg)
		}
	}
	if n == 0 {
		fmt.Printf("[%s] no known feeds; exiting\n", *role)
		os.Exit(1)
	}
	fmt.Printf("[%s] up — %d feed(s): %s\n", *role, n, *feedList)
	wg.Wait()
}
