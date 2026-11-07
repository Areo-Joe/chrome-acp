use clap::Parser;

/// Simple program to greet a person
#[derive(Parser, Debug)]
#[command(version)]
struct Args {
    #[arg(long, default_value_t = 9315)]
    port: usize,

    #[arg(last = true)]
    agent: Vec<String>,
}

fn main() {
    let args = Args::parse();

    println!("{:?}", args);
}
