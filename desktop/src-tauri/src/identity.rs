// trantor desktop request signing, in Rust so the private key never reaches the webview. MUST
// produce byte-identical signatures to lib/identity.mjs (canonical string: docs/CONTRACT-desktop.md);
// any divergence is a generic 401. Existing keys are read only; a fresh local owner gets a key file.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use ed25519_dalek::{Signer, SigningKey};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};

pub const SCHEME: &str = "trantor-v1";

#[derive(Deserialize)]
struct KeyFile { pubkey: String, #[serde(default)] privkey: String }

fn bus_dir() -> PathBuf {
    std::env::var("AGENT_BUS_DIR").map(PathBuf::from).unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_default();
        PathBuf::from(home).join(".agent-bus")
    })
}

fn owner_candidates(dir: &Path, explicit: Option<String>) -> Vec<String> {
    let configured = explicit.filter(|name| !name.is_empty()).or_else(|| {
        let raw = fs::read_to_string(dir.join("config.json")).ok()?;
        let config: serde_json::Value = serde_json::from_str(&raw).ok()?;
        config.get("ownerIdentity")?.as_str().filter(|name| !name.is_empty()).map(str::to_owned)
    });
    if let Some(name) = configured { return vec![name]; }
    let mut names = Vec::new();
    if let Ok(files) = fs::read_dir(dir.join("keys")) {
        for file in files.flatten() {
            if file.path().extension().and_then(|s| s.to_str()) != Some("json") { continue; }
            let Ok(raw) = fs::read_to_string(file.path()) else { continue };
            let Ok(record) = serde_json::from_str::<serde_json::Value>(&raw) else { continue };
            if record.get("kind").and_then(|v| v.as_str()) == Some("human") {
                if let Some(name) = record.get("name").and_then(|v| v.as_str()) { names.push(name.to_string()); }
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

fn configured_owner_candidates() -> Vec<String> {
    let explicit = std::env::var("TRANTOR_IDENTITY").ok().filter(|s| !s.is_empty())
        .or_else(|| std::env::var("RELAY_OWNER_IDENTITY").ok());
    owner_candidates(&bus_dir(), explicit)
}

static OWNERS: std::sync::Mutex<Option<HashMap<String, String>>> = std::sync::Mutex::new(None);

pub fn owner_name() -> String {
    let base = hub_for_project("").trim_end_matches('/').to_string();
    if let Some(name) = crate::lock_or_recover(&OWNERS).as_ref().and_then(|m| m.get(&base)) {
        return name.clone();
    }
    configured_owner_candidates().into_iter().next().unwrap_or_else(|| "human".into())
}

fn create_local_owner(dir: &Path) -> Result<String, String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let name = "human";
    let keys = dir.join("keys");
    fs::create_dir_all(&keys).map_err(|e| format!("Could not create identity directory: {e}"))?;
    let path = keys.join(format!("{name}.json"));
    if path.exists() { return Ok(name.into()); }
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let key = SigningKey::from_bytes(&bytes);
    let record = serde_json::json!({ "name": name, "kind": "human", "privkey": hex(&bytes),
        "pubkey": hex(&key.verifying_key().to_bytes()), "createdAt": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() });
    let mut nonce = [0u8; 16];
    rand::rng().fill_bytes(&mut nonce);
    let tmp = keys.join(format!(".owner-{}.tmp", hex(&nonce)));
    let result = (|| {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&tmp)?;
        file.write_all(record.to_string().as_bytes())?;
        match fs::hard_link(&tmp, &path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(e) => Err(e),
        }
    })();
    let _ = fs::remove_file(tmp);
    result.map_err(|e: std::io::Error| format!("Could not save the local owner identity: {e}"))?;
    Ok(name.into())
}

pub async fn resolve_owner(base: &str) -> Result<String, String> {
    let base = base.trim_end_matches('/');
    if let Some(name) = crate::lock_or_recover(&OWNERS).as_ref().and_then(|m| m.get(base)).cloned() {
        return Ok(name);
    }
    let mut names = configured_owner_candidates();
    if names.is_empty() && crate::hub::loopback_hub(base) { names.push(create_local_owner(&bus_dir())?); }
    let mut unavailable = None;
    for name in names {
        if let Err(error) = load_key(&name) {
            unavailable = Some(error);
            continue;
        }
        let mut response = request(&name, base, "GET", "/keys/usage", None).await?;
        let unknown = serde_json::from_str::<serde_json::Value>(&response.1).ok()
            .is_some_and(|v| v.get("error").and_then(|e| e.as_str()) == Some("unknown identity"));
        if response.0 == 401 && unknown && crate::hub::loopback_hub(base) {
            let body = serde_json::json!({ "name": name, "kind": "human" }).to_string();
            let enrolled = request(&name, base, "POST", "/enroll", Some(body)).await?;
            if !(200..300).contains(&enrolled.0) {
                return Err("The local hub refused owner enrollment. Ask its owner for an invite or configure the existing owner identity.".into());
            }
            response = request(&name, base, "GET", "/keys/usage", None).await?;
        }
        if (200..300).contains(&response.0) {
            crate::lock_or_recover(&OWNERS).get_or_insert_with(HashMap::new).insert(base.into(), name.clone());
            return Ok(name);
        }
    }
    Err(unavailable.unwrap_or_else(|| format!("No local owner identity is authorized on {base}. Enroll this Mac with an owner invite, or select its existing owner key with TRANTOR_IDENTITY.")))
}

#[cfg(test)]
mod owner_tests {
    use super::*;

    #[test]
    fn fresh_home_creates_a_reusable_private_owner_key() {
        let dir = std::env::temp_dir().join(format!("trantor-owner-fresh-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        assert!(owner_candidates(&dir, None).is_empty());
        let name = create_local_owner(&dir).unwrap();
        let path = dir.join("keys/human.json");
        let raw = fs::read_to_string(&path).unwrap();
        resolve_key(&name, Some(&raw), |_| panic!("fresh owner must not need Keychain")).unwrap();
        assert_eq!(owner_candidates(&dir, None), vec![name.clone()]);
        assert_eq!(create_local_owner(&dir).unwrap(), name);
        assert_eq!(fs::read_to_string(path).unwrap(), raw);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn respects_explicit_configured_and_existing_operator_identities() {
        let dir = std::env::temp_dir().join(format!("trantor-owner-existing-{}", std::process::id()));
        fs::create_dir_all(dir.join("keys")).unwrap();
        fs::write(dir.join("keys/sasha_mac.json"), r#"{"name":"sasha@mac","kind":"human","pubkey":"stub"}"#).unwrap();
        fs::write(dir.join("keys/seat.json"), r#"{"name":"seat","kind":"agent"}"#).unwrap();
        assert_eq!(owner_candidates(&dir, None), vec!["sasha@mac"]);
        fs::write(dir.join("config.json"), r#"{"ownerIdentity":"julian@mac"}"#).unwrap();
        assert_eq!(owner_candidates(&dir, None), vec!["julian@mac"]);
        assert_eq!(owner_candidates(&dir, Some("override".into())), vec!["override"]);
        fs::remove_dir_all(dir).unwrap();
    }
}

/// Mirrors safe() in lib/identity.mjs: collapse dot-runs FIRST (so no `..` can survive even in
/// principle), then reduce to the safe charset. Relying on separator-stripping alone would put
/// traversal one regex edit away.
fn safe_name(name: &str) -> String {
    let mut s = String::with_capacity(name.len());
    let mut dots = 0usize;
    for c in name.chars() {
        if c == '.' { dots += 1; continue; }
        if dots > 0 { s.push(if dots >= 2 { '_' } else { '.' }); dots = 0; }
        s.push(if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' });
    }
    if dots > 0 { s.push(if dots >= 2 { '_' } else { '.' }); }
    s
}

fn key_pair(raw: &str) -> Result<(SigningKey, String), String> {
    let record: KeyFile = serde_json::from_str(raw).map_err(|_| "Invalid identity key record")?;
    let bytes = hex_to_32(&record.privkey).ok_or("Identity private key is unavailable")?;
    let key = SigningKey::from_bytes(&bytes);
    if hex(&key.verifying_key().to_bytes()) != record.pubkey.to_lowercase() {
        return Err("Identity public and private keys do not match".into());
    }
    Ok((key, record.pubkey))
}

fn resolve_key(
    name: &str,
    file: Option<&str>,
    read_keychain: impl FnOnce(&str) -> Result<Option<String>, String>,
) -> Result<(SigningKey, String), String> {
    if let Some(raw) = file {
        let record: KeyFile = serde_json::from_str(raw).map_err(|_| "Invalid identity key file")?;
        // A freshly rotated file wins over an older Keychain entry, matching the CLI.
        if !record.privkey.is_empty() { return key_pair(raw); }
    }
    let raw = read_keychain(name)?.ok_or_else(|| format!("The key for \"{name}\" is unavailable on this Mac. Unlock the identity Keychain or restore this identity's key."))?;
    key_pair(&raw)
}

fn read_identity_keychain(name: &str) -> Result<Option<String>, String> {
    if !cfg!(target_os = "macos") || std::env::var("TRANTOR_NO_KEYCHAIN").as_deref() == Ok("1") {
        return Err("Identity Keychain is unavailable on this platform or disabled".into());
    }
    let mut command = crate::identity_env::command("/usr/bin/security");
    command.args(["find-generic-password", "-a", name, "-s", "trantor-identity", "-w"]);
    if let Ok(path) = std::env::var("TRANTOR_IDENTITY_KEYCHAIN") { command.arg(path); }
    let mut child = command.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null())
        .spawn().map_err(|_| "Could not read identity Keychain")?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => std::thread::sleep(std::time::Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Identity Keychain timed out; unlock it and retry".into());
            }
        }
    }
    let output = child.wait_with_output().map_err(|_| "Could not read identity Keychain")?;
    if output.status.code() == Some(44) { return Ok(None); }
    if !output.status.success() { return Err("Identity Keychain is locked or unavailable; unlock it and retry".into()); }
    String::from_utf8(output.stdout).map(Some).map_err(|_| "Invalid identity Keychain record".into())
}

fn load_key(name: &str) -> Result<(SigningKey, String), String> {
    let path = bus_dir().join("keys").join(format!("{}.json", safe_name(name)));
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => Some(raw),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("Could not read identity key file".into()),
    };
    resolve_key(name, raw.as_deref(), read_identity_keychain)
}

fn hex_to_32(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 { return None; }
    let mut out = [0u8; 32];
    for i in 0..32 {
        out[i] = u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()?;
    }
    Some(out)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

pub fn canonical(method: &str, path: &str, body_hash: &str, ts: u128, nonce: &str) -> String {
    format!("{}\n{}\n{}\n{}\n{}\n{}", SCHEME, method.to_uppercase(), path, body_hash, ts, nonce)
}

/// Returns the four headers for one request. `body` must be the EXACT bytes sent — sign what is sent,
/// never a re-serialisation, or the hub's hash will not match ours.
pub fn sign(identity: &str, method: &str, path: &str, body: Option<&str>) -> Result<HashMap<String, String>, String> {
    let (key, pubkey) = load_key(identity)?;
    let body_hash = match body {
        Some(b) if !b.is_empty() => hex(&Sha256::digest(b.as_bytes())),
        _ => String::new(),
    };
    let ts = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis();
    let mut nb = [0u8; 16];
    rand::rng().fill_bytes(&mut nb);
    let nonce = hex(&nb);
    let msg = canonical(method, path, &body_hash, ts, &nonce);
    let sig = key.sign(msg.as_bytes());

    let mut h = HashMap::new();
    h.insert("x-trantor-pubkey".into(), pubkey);
    h.insert("x-trantor-sig".into(), B64.encode(sig.to_bytes()));
    h.insert("x-trantor-ts".into(), ts.to_string());
    h.insert("x-trantor-nonce".into(), nonce);
    Ok(h)
}

/// Per-project hub routing (TDD §12.1): a project lives on exactly ONE hub. Same precedence the JS
/// resolveHub() uses — env, then the per-project pin, then the global default.
pub fn hub_for_project(project: &str) -> String {
    if let Ok(u) = std::env::var("RELAY_URL") { if !u.is_empty() { return u; } }
    let cfg_path = bus_dir().join("config.json");
    if let Ok(raw) = fs::read_to_string(cfg_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(u) = v.get("hubs").and_then(|h| h.get(project)).and_then(|u| u.as_str()) {
                return u.trim_end_matches('/').to_string();
            }
            if let Some(u) = v.get("url").and_then(|u| u.as_str()) {
                return u.trim_end_matches('/').to_string();
            }
        }
    }
    "http://127.0.0.1:4477".into()
}

/// Where projects live on THIS machine: ~/development by convention, TRANTOR_DEV_ROOT to relocate.
pub fn dev_root() -> PathBuf {
    PathBuf::from(
        std::env::var("TRANTOR_DEV_ROOT")
            .unwrap_or_else(|_| format!("{}/development", std::env::var("HOME").unwrap_or_default())),
    )
}

/// The id a checkout records in `.trantor/project.json` (#6724), the same file lib/project.mjs
/// reads. A directory rename used to rename the project: the pin, the board and the sessions
/// stayed under the old name while the new directory showed up as an empty twin. With the id in
/// the checkout the directory name is a label. Malformed ids (path shapes) read as unmarked.
pub fn project_id_of(dir: &Path) -> Option<String> {
    let raw = fs::read_to_string(dir.join(".trantor").join("project.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let id = v.get("id")?.as_str()?.trim();
    let shape = !id.is_empty()
        && id.len() <= 80
        && !id.contains("..")
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    if shape { Some(id.to_string()) } else { None }
}

/// The checkout under `root` that carries project `id`: `<root>/<id>` unless that directory claims
/// a different id, else the child whose marker says `id` — the renamed directory. Every
/// `root.join(project)` by hand was the lookup a rename broke.
pub fn checkout_for(root: &Path, id: &str) -> Option<PathBuf> {
    if id.trim().is_empty() || id.contains('/') || id.contains("..") {
        return None;
    }
    let direct = root.join(id);
    if direct.is_dir() && project_id_of(&direct).map_or(true, |m| m == id) {
        return Some(direct);
    }
    for e in fs::read_dir(root).ok()?.flatten().take(200) {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.starts_with('_') || !e.path().is_dir() {
            continue;
        }
        if project_id_of(&e.path()).as_deref() == Some(id) {
            return Some(e.path());
        }
    }
    None
}

/// Every checkout under `root`, named by its recorded id when it has one, else by its directory.
/// A directory is a project when it is a repo. A scratch folder is not.
pub fn known_projects_under(root: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Ok(rd) = fs::read_dir(root) {
        for e in rd.flatten() {
            if !e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.starts_with('_') {
                continue;
            }
            if e.path().join(".git").exists() {
                out.push(project_id_of(&e.path()).unwrap_or(name));
            }
        }
    }
    out
}

/// A project is something you can actually OPEN: a hub you pinned, or a checkout on this machine.
/// A positive rule, not a blocklist on name shapes: sessions register whatever string they resolved.
/// A renamed checkout lists ONCE, under its recorded id, beside its pin (#6724).
pub fn known_projects() -> Vec<String> {
    let mut pinned: Vec<String> = Vec::new();
    if let Ok(raw) = fs::read_to_string(bus_dir().join("config.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(h) = v.get("hubs").and_then(|h| h.as_object()) {
                pinned.extend(h.keys().cloned());
            }
        }
    }
    projects_in(&dev_root(), pinned)
}

/// The pinned names plus every checkout in the dev root ("all of the projects are in the
/// development folder"), each named by its recorded id (#6724), minus any name whose checkout is
/// a folder of projects: a wrapper the list offered was woken into a dead non-seat session (#6842).
/// The checkout is found by id, so a renamed directory gets the same filter as a direct one.
pub fn projects_in(root: &Path, pinned: Vec<String>) -> Vec<String> {
    let mut out = pinned;
    out.extend(known_projects_under(root));
    out.retain(|name| checkout_for(root, name).map_or(true, |dir| !folder_of_projects(&dir)));
    out.sort();
    out.dedup();
    out
}

/// The immediate child repos of `dir`, bounded like lib/project.mjs countChildRepos (first 200
/// entries, dot-dirs skipped).
fn child_repos(dir: &Path) -> Vec<PathBuf> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = rd
        .flatten()
        .take(200)
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.join(".git").exists())
        .collect();
    out.sort();
    out
}

/// The folder-of-projects rule, the twin of lib/project.mjs nonSeatReason: not a repo itself,
/// two or more child repos. Such a dir can never be a seat, so the app must never offer it.
pub fn folder_of_projects(dir: &Path) -> bool {
    !dir.join(".git").exists() && child_repos(dir).len() >= 2
}

/// The real project(s) inside a folder of projects (#6842): the child repos carrying a CLAUDE.md.
/// A stray clone or worktree beside the real one carries none.
pub fn nested_projects(dir: &Path) -> Vec<PathBuf> {
    child_repos(dir).into_iter().filter(|p| p.join("CLAUDE.md").is_file()).collect()
}

#[cfg(test)]
mod keychain_tests {
    use super::*;
    use ed25519_dalek::Verifier;

    fn record(seed: u8) -> String {
        let key = SigningKey::from_bytes(&[seed; 32]);
        serde_json::json!({ "pubkey": hex(&key.verifying_key().to_bytes()), "privkey": hex(&[seed; 32]) }).to_string()
    }

    #[test]
    fn stub_resolves_raw_account_and_signs_without_exposing_key() {
        let secret = record(7);
        let stub = serde_json::json!({ "pubkey": "stale-display-value", "keychain": "trantor-identity" }).to_string();
        let (key, pubkey) = resolve_key("sasha@mac", Some(&stub), |account| {
            assert_eq!(account, "sasha@mac");
            Ok(Some(secret))
        }).expect("stub resolves");
        assert_eq!(pubkey, hex(&key.verifying_key().to_bytes()));
        let message = canonical("POST", "/send", "abc", 123, "nonce");
        key.verifying_key().verify(message.as_bytes(), &key.sign(message.as_bytes())).expect("signature verifies");
    }

    #[test]
    fn plaintext_rotation_wins_without_reading_keychain() {
        let raw = record(9);
        let (key, _) = resolve_key("human", Some(&raw), |_| panic!("must not read stale Keychain")).expect("file loads");
        assert_eq!(key.to_bytes(), [9; 32]);
    }

    #[test]
    fn missing_stub_recovers_keychain_record_without_regeneration() {
        let (key, _) = resolve_key("human", None, |_| Ok(Some(record(8)))).expect("keychain recovers");
        assert_eq!(key.to_bytes(), [8; 32]);
    }

    #[test]
    fn locked_or_missing_keychain_is_an_explicit_error() {
        let stub = "{\"pubkey\":\"stub\"}";
        let missing = resolve_key("human", Some(stub), |_| Ok(None)).err().expect("missing fails");
        assert!(missing.contains("unavailable on this Mac"));
        let locked = resolve_key("human", Some(stub), |_| Err("Keychain locked".into())).err().expect("locked fails");
        assert!(locked.contains("locked"));
    }

    #[test]
    fn malformed_or_mismatched_records_fail_without_secret_in_error() {
        let secret = "secret-key-material";
        let error = resolve_key("human", None, |_| Ok(Some(secret.into()))).err().expect("invalid fails");
        assert!(!error.contains(secret));
        let malformed = serde_json::json!({ "pubkey": "0".repeat(64), "privkey": "07".repeat(32) }).to_string();
        let error = resolve_key("human", None, |_| Ok(Some(malformed))).err().expect("mismatch fails");
        assert!(error.contains("do not match"));
        assert!(!error.contains(&"07".repeat(32)));
    }
}

#[cfg(test)]
mod project_id_tests {
    use super::*;
    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("trantor-project-id-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }
    fn checkout(root: &Path, dir: &str, id: Option<&str>) -> PathBuf {
        let d = root.join(dir);
        fs::create_dir_all(d.join(".git")).unwrap();
        if let Some(id) = id {
            fs::create_dir_all(d.join(".trantor")).unwrap();
            fs::write(d.join(".trantor/project.json"), format!("{{\"id\":\"{id}\",\"since\":\"2026-09-17\"}}")).unwrap();
        }
        d
    }
    #[test]
    fn a_renamed_checkout_keeps_its_id_and_lists_once() {
        let root = scratch("rename");
        let dir = checkout(&root, "stone-tracker", Some("juans-project"));
        assert_eq!(project_id_of(&dir).as_deref(), Some("juans-project"));
        assert_eq!(checkout_for(&root, "juans-project"), Some(dir.clone()));
        assert_eq!(checkout_for(&root, "stone-tracker"), None, "the directory name is a label, not a project");
        assert_eq!(known_projects_under(&root), vec!["juans-project".to_string()]);
    }
    #[test]
    fn an_unmarked_checkout_is_named_by_its_directory() {
        let root = scratch("plain");
        let dir = checkout(&root, "acme", None);
        assert_eq!(project_id_of(&dir), None);
        assert_eq!(checkout_for(&root, "acme"), Some(dir));
        assert_eq!(known_projects_under(&root), vec!["acme".to_string()]);
    }
    #[test]
    fn a_directory_claiming_another_id_is_not_that_project() {
        let root = scratch("claim");
        checkout(&root, "acme", Some("other"));
        assert_eq!(checkout_for(&root, "acme"), None);
        assert_eq!(checkout_for(&root, "other"), Some(root.join("acme")));
    }
    #[test]
    fn a_path_shaped_id_reads_as_unmarked() {
        let root = scratch("shape");
        let dir = checkout(&root, "acme", Some("../escape"));
        assert_eq!(project_id_of(&dir), None);
        assert_eq!(checkout_for(&root, "../escape"), None);
        assert_eq!(checkout_for(&root, "a/b"), None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_matches_the_js_shape() {
        let c = canonical("post", "/send?x=1", "abc", 123, "nnn");
        assert_eq!(c, "trantor-v1\nPOST\n/send?x=1\nabc\n123\nnnn");
        assert!(!c.ends_with('\n'), "a trailing newline would break signature parity with JS");
    }
    #[test]
    fn safe_name_cannot_traverse() {
        assert!(!safe_name("../../etc/passwd").contains(".."));
        assert_eq!(safe_name("MacBook-Pro-M1:trantor"), "MacBook-Pro-M1_trantor");
        assert_eq!(safe_name("builtbetter.ai"), "builtbetter.ai");
    }
}

#[cfg(test)]
mod folder_of_projects_tests {
    use super::*;

    /// A dev root holding: a real repo, a wrapper (not a repo) with one nested CLAUDE.md repo
    /// plus two stray repos, a scratch dir, and a lone-child dir (one repo inside, not a wrapper).
    fn dev_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("trantor-6842-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("real/.git")).unwrap();
        fs::create_dir_all(root.join("wrapper.ai/builtbetter/.git")).unwrap();
        fs::write(root.join("wrapper.ai/builtbetter/CLAUDE.md"), "# builtbetter").unwrap();
        fs::create_dir_all(root.join("wrapper.ai/builtbetter-git/.git")).unwrap();
        fs::create_dir_all(root.join("wrapper.ai/builtbetter-worktree/.git")).unwrap();
        fs::create_dir_all(root.join("wrapper.ai/.tmp/.git")).unwrap();
        fs::create_dir_all(root.join("scratch")).unwrap();
        fs::create_dir_all(root.join("lone/only/.git")).unwrap();
        root
    }

    #[test]
    fn a_wrapper_dir_is_a_folder_of_projects_and_a_repo_or_lone_child_is_not() {
        let root = dev_root("wrapper");
        assert!(folder_of_projects(&root.join("wrapper.ai")));
        assert!(!folder_of_projects(&root.join("real")), "a git root is a project whatever it holds");
        assert!(!folder_of_projects(&root.join("lone")), "one child repo does not make a wrapper");
        assert!(!folder_of_projects(&root.join("scratch")));
        assert!(!folder_of_projects(&root.join("missing")));
    }

    #[test]
    fn the_nested_project_is_the_child_repo_with_a_claude_md_not_the_strays() {
        let root = dev_root("nested");
        let nested = nested_projects(&root.join("wrapper.ai"));
        assert_eq!(nested, vec![root.join("wrapper.ai/builtbetter")]);
        assert!(nested_projects(&root.join("real")).is_empty());
    }

    #[test]
    fn the_project_list_drops_a_wrapper_even_when_pinned_and_keeps_the_rest() {
        let root = dev_root("list");
        let pinned = vec!["wrapper.ai".to_string(), "remote-only".to_string(), "real".to_string()];
        let list = projects_in(&root, pinned);
        assert_eq!(list, vec!["real".to_string(), "remote-only".to_string()]);
    }
}

#[cfg(test)]
mod parity {
    use super::safe_name;
    #[test]
    fn matches_js_safe_name_for_the_owner_identity() {
        // JS: String(s).replace(/\.{2,}/g,"_").replace(/[^A-Za-z0-9_.-]/g,"_")
        assert_eq!(safe_name("sasha@mac"), "sasha_mac");
        assert_eq!(safe_name("codex:reddit-weekly"), "codex_reddit-weekly");
    }
}

/// A SIGNED request to a hub, from Rust: macOS App Transport Security blocks cleartext HTTP from
/// WKWebView, and the private key stays on this side of the boundary.
pub async fn request(identity: &str, base: &str, method: &str, path: &str, body: Option<String>)
    -> Result<(u16, String), String>
{
    let headers = sign(identity, method, path, body.as_deref())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        // Signed requests, especially local enrollment, must never follow a redirect to another hub.
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|e| e.to_string())?;
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
    let mut req = client.request(m, &url);
    for (k, v) in headers { req = req.header(k, v); }
    if let Some(b) = body { req = req.header("content-type", "application/json").body(b); }
    let res = req.send().await.map_err(|e| format!("{e}"))?;
    let status = res.status().as_u16();
    let text = res.text().await.map_err(|e| e.to_string())?;
    Ok((status, text))
}

/// GET whose response body is streamed under a hard byte cap (#12161 review: `res.bytes()`
/// buffered whatever the hub sent — a malformed or compromised hub could exhaust memory; a
/// timeout is not a byte limit). Returns Err once the stream would exceed `max`. The cap keeps
/// the attachment download honest: prompt attachments (#12161) are JPEGs of a bounded size.
pub async fn request_bytes_capped(
    identity: &str,
    base: &str,
    path: &str,
    max: usize,
) -> Result<(u16, Vec<u8>), String> {
    let headers = sign(identity, "GET", path, None)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build().map_err(|e| e.to_string())?;
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let mut req = client.get(&url);
    for (k, v) in headers { req = req.header(k, v); }
    let mut res = req.send().await.map_err(|e| format!("{e}"))?;
    let status = res.status().as_u16();
    if let Some(len) = res.content_length() {
        if len as usize > max {
            return Err(format!("response of {len} bytes exceeds the {max} byte cap"));
        }
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > max {
            return Err(format!("response exceeds the {max} byte cap"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((status, bytes))
}

/// The hub's SSE stream, each event handed to `on_event`. In Rust for the same ATS reason as
/// request(). Reconnect is ours: capped backoff, and `since` resumes from the last id so nothing drops.
pub async fn stream(identity: &str, base: &str, mut on_event: impl FnMut(String), mut on_connect: impl FnMut()) {
    use futures_util::StreamExt;
    let mut last_id: u64 = 0;
    let mut backoff = 1u64;
    loop {
        let path = if last_id > 0 { format!("/stream?events=1&since={last_id}") } else { "/stream?events=1".into() };
        let headers = match sign(identity, "GET", &path, None) {
            Ok(h) => h,
            Err(_) => {
                tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                backoff = (backoff * 2).min(15);
                continue;
            }
        };
        let client = match reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none()).build() { Ok(c) => c, Err(_) => return };
        let mut req = client.get(format!("{}{}", base.trim_end_matches('/'), path));
        for (k, v) in headers { req = req.header(k, v); }

        match req.send().await {
            Ok(res) if res.status().is_success() => {
                backoff = 1;
                on_connect();
                let mut buf = String::new();
                let mut body = res.bytes_stream();
                while let Some(chunk) = body.next().await {
                    let Ok(bytes) = chunk else { break };
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    // A chunk can split a frame, so only consume complete blank-line-delimited blocks.
                    while let Some(sep) = buf.find("\n\n") {
                        let frame: String = buf.drain(..sep + 2).collect();
                        let (mut name, mut data) = (String::new(), String::new());
                        for line in frame.lines() {
                            if let Some(v) = line.strip_prefix("event:") { name = v.trim().to_string(); }
                            else if let Some(v) = line.strip_prefix("data:") { data.push_str(v.trim()); }
                            else if let Some(v) = line.strip_prefix("id:") {
                                if let Ok(n) = v.trim().parse::<u64>() { last_id = n; }
                            }
                        }
                        // The hub emits a NAMED `ev` channel; anything else is keepalive or legacy.
                        if name == "ev" && !data.is_empty() { on_event(data); }
                    }
                }
            }
            _ => {}
        }
        tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
        backoff = (backoff * 2).min(15);
    }
}

#[cfg(test)]
mod cap_tests {
    use super::*;
    use std::io::{Read, Write};

    /// One-shot HTTP server: reads the request head, answers with `head` + `body`, then closes.
    fn serve_once(head: String, body: Vec<u8>) -> std::net::SocketAddr {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 4096];
            let mut got = 0;
            while got < buf.len() {
                match sock.read(&mut buf[got..]) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => got += n,
                }
                if buf[..got].windows(4).any(|w| w == b"\r\n\r\n") { break; }
            }
            let _ = sock.write_all(head.as_bytes());
            let _ = sock.write_all(&body);
            let _ = sock.flush();
        });
        addr
    }

    /// A test identity whose key file lives in a scratch bus dir (no Keychain).
    fn cap_bus_dir(tag: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!("trantor-12161-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("keys")).unwrap();
        let key = SigningKey::from_bytes(&[7u8; 32]);
        std::fs::write(
            base.join("keys").join(format!("{}.json", safe_name("captest"))),
            format!(
                r#"{{"pubkey":"{}","privkey":"{}"}}"#,
                hex(&key.verifying_key().to_bytes()),
                hex(&key.to_bytes())
            ),
        )
        .unwrap();
        base
    }

    // Repoints the process-wide AGENT_BUS_DIR at the scratch dir for the whole await, serialized
    // by the repo's env lock, restoring the PRIOR value (never a bare remove_var).
    macro_rules! capped_over_scratch_bus {
        ($base:expr, $call:expr) => {{
            let _guard = crate::local_sessions::BUS_DIR_TEST_LOCK.lock().unwrap();
            let prior = std::env::var("AGENT_BUS_DIR").ok();
            unsafe { std::env::set_var("AGENT_BUS_DIR", $base) };
            let out = $call.await;
            unsafe {
                match prior {
                    Some(v) => std::env::set_var("AGENT_BUS_DIR", v),
                    None => std::env::remove_var("AGENT_BUS_DIR"),
                }
            }
            out
        }};
    }

    #[tokio::test]
    async fn a_streamed_response_over_the_cap_is_refused_not_buffered() {
        let base = cap_bus_dir("stream");
        let body: Vec<u8> = [[0xffu8, 0xd8, 0xff].as_slice(), vec![0u8; 8192].as_slice()].concat();
        let addr = serve_once("HTTP/1.1 200 OK\r\ncontent-type: image/jpeg\r\n\r\n".into(), body);
        let result = capped_over_scratch_bus!(
            &base,
            request_bytes_capped("captest", &format!("http://{addr}"), "/session/attachment?id=1&n=0", 1024)
        );
        assert!(
            result.is_err(),
            "an 8 KiB body over a 1 KiB cap must be refused: {:?}",
            result.as_ref().map(|(s, b)| (s, b.len())).map_err(|e| e.clone())
        );
        assert!(result.unwrap_err().contains("cap"));
    }

    #[tokio::test]
    async fn a_content_length_over_the_cap_is_refused_before_reading() {
        let base = cap_bus_dir("length");
        let addr = serve_once(
            "HTTP/1.1 200 OK\r\ncontent-length: 99999999\r\n\r\n".into(),
            b"tiny".to_vec(),
        );
        let result = capped_over_scratch_bus!(
            &base,
            request_bytes_capped("captest", &format!("http://{addr}"), "/session/attachment?id=1&n=0", 1024)
        );
        assert!(
            result.is_err(),
            "a declared 99 MB body must be refused: {:?}",
            result.as_ref().map(|(s, b)| (s, b.len())).map_err(|e| e.clone())
        );
    }

    #[tokio::test]
    async fn a_response_under_the_cap_downloads_whole() {
        let base = cap_bus_dir("under");
        let jpeg: Vec<u8> = [[0xffu8, 0xd8, 0xff].as_slice(), vec![0u8; 509].as_slice()].concat();
        let addr = serve_once(
            format!("HTTP/1.1 200 OK\r\ncontent-type: image/jpeg\r\ncontent-length: {}\r\n\r\n", jpeg.len()),
            jpeg.clone(),
        );
        let result = capped_over_scratch_bus!(
            &base,
            request_bytes_capped("captest", &format!("http://{addr}"), "/session/attachment?id=1&n=0", 1024)
        );
        let (status, bytes) = result.unwrap();
        assert_eq!(status, 200);
        assert_eq!(bytes, jpeg);
    }
}
