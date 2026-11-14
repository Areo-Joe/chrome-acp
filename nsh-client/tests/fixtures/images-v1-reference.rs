// Zed 62682ebde9 message_editor.rs::build_chunks_from_creases.
// GPUI's crease/snapshot lookups are replaced by byte spans and resolved blocks.
// Compile with serde_json = "=1.0.151". One JSON input per line:
// {text, images:[{start,end,block}]}; output is the v1 prompt block array.
use std::io::{self, BufRead};
use serde_json::{Value, json};
fn main() {
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let text = input["text"].as_str().unwrap();
        let mut ix = text.char_indices().find(|(_, c)| !c.is_whitespace()).map_or(text.len(), |(i, _)| i);
        let mut chunks = vec![];
        for image in input["images"].as_array().unwrap() {
            let start = image["start"].as_u64().unwrap() as usize;
            let end = image["end"].as_u64().unwrap() as usize;
            if start > ix { chunks.push(json!({"type":"text", "text":&text[ix..start]})); }
            chunks.push(image["block"].clone());
            ix = end;
        }
        if ix < text.len() {
            let last_chunk = text[ix..].trim_end().to_owned();
            if !last_chunk.is_empty() { chunks.push(json!({"type":"text","text":last_chunk})); }
        }
        println!("{}", json!(chunks));
    }
}
