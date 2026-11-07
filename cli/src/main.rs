mod acp;

use axum::{Router, routing::any};
use clap::{ArgAction, Parser};
use rand::distr::{Alphanumeric, SampleString};
use std::sync::Arc;

#[derive(Parser, Debug)]
#[command(version)]
struct Args {
    #[arg(long, default_value_t = 9315)]
    port: u16,

    #[arg(long, default_value_t = true, action = ArgAction::Set)]
    auth: bool,

    #[arg(last = true, required = true)]
    agent: Vec<String>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    let token = if args.auth {
        let secret = Alphanumeric.sample_string(&mut rand::rng(), 32);
        tracing::info!("Auth token: {}", secret);
        Some(secret)
    } else {
        None
    };

    let state = Arc::new(acp::AppState {
        agent: args.agent,
        token,
    });

    let app = Router::new()
        .route("/acp", any(acp::ws_handler))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", args.port))
        .await
        .unwrap();

    tracing::info!("Listening at 0.0.0.0:{}!", args.port);

    axum::serve(listener, app).await.unwrap();
}
