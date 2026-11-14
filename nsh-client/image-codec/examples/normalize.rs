//! Produces recorded image codec results for the integration-test fixtures.
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let result = serde_json::from_str(&line.unwrap())
            .map_err(|e| e.to_string())
            .and_then(|value| nsh_client_image_codec::normalize(&value));
        println!(
            "{}",
            match result {
                Ok(image) => serde_json::json!({"image":image}),
                Err(error) => serde_json::json!({"error":error}),
            }
        );
    }
}
