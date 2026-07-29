// Prints the four signature headers for a fixed request, so the JS verifier can check them.
// Proves Rust and lib/identity.mjs agree on the SIGNATURE, not merely the canonical string.
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let ident = args.get(1).cloned().unwrap_or_else(|| "sasha@mac".into());
    let body = args.get(2).cloned();
    match desktop_lib::identity::sign(&ident, "POST", "/send?x=1", body.as_deref()) {
        Ok(h) => println!("{}", serde_json::to_string(&h).unwrap()),
        Err(e) => { eprintln!("ERR {e}"); std::process::exit(1); }
    }
}
