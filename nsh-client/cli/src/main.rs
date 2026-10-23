mod dev;
mod process;
mod server;
mod toolchain;

use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(about = "Manage the repository's NSH toolchain and custom development hosts")]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Download and verify the pinned NSH distribution, or reuse its cache.
    Setup,
    /// Build and run the custom macOS host with TSX hot updates.
    Macos,
    /// Build, install and run the custom Android host with TSX hot updates.
    Android { device: Option<String> },
}

fn main() -> Result<()> {
    let args = Args::parse();
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    ctrlc::set_handler(move || flag.store(true, Ordering::Relaxed))?;
    let root = std::env::current_dir()?;
    let sdk = toolchain::prepare(&root, &cancelled)?;
    match args.command {
        Command::Setup => Ok(()),
        Command::Macos => dev::macos(&root, &sdk, cancelled),
        Command::Android { device } => dev::android(&root, &sdk, device, cancelled),
    }
}
