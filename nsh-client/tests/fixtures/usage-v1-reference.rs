// Run with the pinned Cargo dependencies documented in initialize-v1-reference.rs.
use agent_client_protocol_schema::v1 as acp;
use serde_json::json;
use std::io::{self, BufRead};
fn humanize_token_count(count: u64) -> String {
    match count {
        0..=999 => count.to_string(),
        1000..=9999 => {
            let thousands = count / 1000;
            let hundreds = (count % 1000 + 50) / 100;
            if hundreds == 0 {
                format!("{}k", thousands)
            } else if hundreds == 10 {
                format!("{}k", thousands + 1)
            } else {
                format!("{}.{}k", thousands, hundreds)
            }
        }
        10_000..=999_999 => format!("{}k", (count + 500) / 1000),
        1_000_000..=9_999_999 => {
            let millions = count / 1_000_000;
            let hundred_thousands = (count % 1_000_000 + 50_000) / 100_000;
            if hundred_thousands == 0 {
                format!("{}M", millions)
            } else if hundred_thousands == 10 {
                format!("{}M", millions + 1)
            } else {
                format!("{}.{}M", millions, hundred_thousands)
            }
        }
        10_000_000.. => format!("{}M", (count + 500_000) / 1_000_000),
    }
}


fn main() {
 for line in io::stdin().lock().lines() {
  match serde_json::from_str::<acp::UsageUpdate>(&line.unwrap()) {
   Ok(value) => {
    let ratio = if value.size > 0 {value.used as f32 / value.size as f32} else {0.0};
    let cost = value.cost.as_ref().map(|cost| {
     let precision = if cost.amount > 0.0 && cost.amount < 0.01 {4} else {2};
     format!("{:.prec$} {}", cost.amount, cost.currency, prec = precision)
    });
    let display = json!({"ratio":ratio as f64,"progress":ratio.clamp(0.0,1.0) as f64,"warning":ratio >= 0.85,
      "percentage":format!("{}%",(ratio*100.0).round() as u32),"used":humanize_token_count(value.used),
      "size":humanize_token_count(value.size),"cost":cost});
    println!("{}",json!({"ok":value,"presentation":display}));
   },
   Err(error) => println!("{}",json!({"error":error.to_string()})),
  }
 }
}
