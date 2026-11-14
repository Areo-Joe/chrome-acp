// Run with the pinned Cargo dependencies documented in initialize-v1-reference.rs.
use agent_client_protocol_schema::v1 as acp;
use serde_json::{Value, json};
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        match serde_json::from_value::<acp::ListSessionsResponse>(input) {
            Ok(value) => println!("{}", json!({"ok":value})),
            Err(error) => println!("{}", json!({"error":error.to_string()})),
        }
    }
}
