// Rust reference for session-state-v1.json. Use the same temporary Cargo project
// and pinned dependencies as initialize-v1-reference.rs. Input is one JSON
// object per line with operation and input fields; output is normalized v1 data.
use agent_client_protocol_schema::v1 as acp;
use serde_json::{Value, json};
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let payload = input["input"].clone();
        let result = match input["operation"].as_str().unwrap() {
            "session/new" => serde_json::from_value::<acp::NewSessionResponse>(payload)
                .map(|v| serde_json::to_value(v).unwrap()),
            "session/load" => serde_json::from_value::<acp::LoadSessionResponse>(payload)
                .map(|v| serde_json::to_value(v).unwrap()),
            "session/resume" => serde_json::from_value::<acp::ResumeSessionResponse>(payload)
                .map(|v| serde_json::to_value(v).unwrap()),
            "session/set_config_option" => {
                serde_json::from_value::<acp::SetSessionConfigOptionResponse>(payload)
                    .map(|v| serde_json::to_value(v).unwrap())
            }
            _ => unreachable!(),
        };
        match result {
            Ok(v) => println!("{}", json!({"ok":v})),
            Err(e) => println!("{}", json!({"error":e.to_string()})),
        }
    }
}
