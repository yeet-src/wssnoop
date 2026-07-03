// wssnoop demo worker — the Rust counterpart, tokio-tungstenite over rustls (the
// demo stack's Rust path). rustls is pure Rust, statically linked, with no
// OpenSSL symbols, so this is the hardest case for the tap.
//
//   rust-worker --role rust-md --feeds coinbase,kraken
//
// One outbound wss:// per feed, seeded subscriptions churned on a timer — same
// shape as the other workers.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

fn feed_url(name: &str) -> Option<&'static str> {
    match name {
        "coinbase" => Some("wss://ws-feed.exchange.coinbase.com"),
        "kraken" => Some("wss://ws.kraken.com"),
        _ => None,
    }
}

fn sub_msg(feed: &str, subscribe: bool) -> String {
    let kind = if subscribe { "subscribe" } else { "unsubscribe" };
    match feed {
        "coinbase" => format!(
            "{{\"type\":\"{kind}\",\"product_ids\":[\"BTC-USD\",\"ETH-USD\"],\"channels\":[\"ticker\"]}}"
        ),
        _ => format!(
            "{{\"event\":\"{kind}\",\"pair\":[\"XBT/USD\"],\"subscription\":{{\"name\":\"ticker\"}}}}"
        ),
    }
}

async fn run_feed(role: String, feed: String, url: String, recycle_ms: u64) {
    loop {
        match connect_async(&url).await {
            Ok((mut ws, _)) => {
                println!("[{role}] open {url}");
                let _ = ws.send(Message::Text(sub_msg(&feed, true).into())).await;
                let mut churn = tokio::time::interval(Duration::from_secs(3));
                let deadline = if recycle_ms > 0 {
                    Some(tokio::time::Instant::now() + Duration::from_millis(recycle_ms))
                } else {
                    None
                };
                let mut on = true;
                loop {
                    tokio::select! {
                        _ = churn.tick() => {
                            on = !on;
                            let _ = ws.send(Message::Text(sub_msg(&feed, on).into())).await;
                        }
                        msg = ws.next() => {
                            match msg {
                                Some(Ok(_)) => {}            // tap reads the wire, not us
                                _ => break,                  // closed / error
                            }
                        }
                        _ = async {
                            if let Some(d) = deadline { tokio::time::sleep_until(d).await } else { std::future::pending::<()>().await }
                        } => {
                            let _ = ws.close(None).await;
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                println!("[{role}] {url} error: {e}");
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[tokio::main]
async fn main() {
    // rustls 0.23 requires a process-wide crypto provider be chosen explicitly.
    let _ = rustls::crypto::ring::default_provider().install_default();

    let args: Vec<String> = std::env::args().collect();
    let mut role = "rust-worker".to_string();
    let mut feeds = "coinbase,kraken".to_string();
    let mut recycle: u64 = 0;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--role" => { role = args[i + 1].clone(); i += 2; }
            "--feeds" => { feeds = args[i + 1].clone(); i += 2; }
            "--recycle" => { recycle = args[i + 1].parse().unwrap_or(0); i += 2; }
            _ => { i += 1; }
        }
    }

    let mut handles = vec![];
    for f in feeds.split(',') {
        if let Some(url) = feed_url(f) {
            handles.push(tokio::spawn(run_feed(role.clone(), f.to_string(), url.to_string(), recycle)));
        }
    }
    println!("[{role}] up — {} feed(s): {feeds}", handles.len());
    for h in handles {
        let _ = h.await;
    }
}
