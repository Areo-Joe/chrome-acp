use clap::Parser;

use axum::{Router, routing::get};

/// Simple program to greet a person
#[derive(Parser, Debug)]
#[command(version)]
struct Args {
    #[arg(long, default_value_t = 9315)]
    port: usize,

    #[arg(last = true)]
    agent: Vec<String>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let args = Args::parse();

    let app = Router::new().route("/", get(|| async { "Hello, World!" }));

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", args.port))
        .await
        .unwrap();

    tracing::info!("Listening at 0.0.0.0:{}!", args.port);

    axum::serve(listener, app).await.unwrap();
}
