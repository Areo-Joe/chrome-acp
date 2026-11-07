mod acp;

use clap::Parser;

use axum::{Router, routing::any};

#[derive(Parser, Debug)]
#[command(version)]
struct Args {
    #[arg(long, default_value_t = 9315)]
    port: u16,

    #[arg(last = true, required = true)]
    agent: Vec<String>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    let app = Router::new()
        .route("/acp", any(acp::ws_handler))
        .with_state(args.agent);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", args.port))
        .await
        .unwrap();

    tracing::info!("Listening at 0.0.0.0:{}!", args.port);

    axum::serve(listener, app).await.unwrap();
}
