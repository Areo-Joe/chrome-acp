// Reference decoder used to produce initialize-v1.json.
// Compile in a temporary Cargo project with:
//   agent-client-protocol-schema = { version = "=1.15.1", default-features = false, features = ["unstable"] }
//   serde_json = "=1.0.151"
//   serde_with = "=3.22.0"
//   serde = "=1.0.229"
// Feed one fixture input per line; each output is the normalized schema value
// or a decoding error. The normal Node test suite uses the recorded JSON only.
use std::io::{self, BufRead};

fn main() {
    for line in io::stdin().lock().lines() {
        let result = serde_json::from_str::<agent_client_protocol_schema::v1::InitializeResponse>(
            &line.unwrap(),
        );
        match result {
            Ok(value) => println!("{}", serde_json::json!({ "ok": value })),
            Err(error) => println!("{}", serde_json::json!({ "error": error.to_string() })),
        }
    }
}
