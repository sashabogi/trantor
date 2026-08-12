pub mod identity;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}


/// The identity this app signs as. Configurable so a second machine or a test can use another key.
fn owner_identity() -> String {
    std::env::var("TRANTOR_IDENTITY").unwrap_or_else(|_| "sasha@mac".to_string())
}

#[tauri::command]
fn sign_request(method: String, path: String, body: Option<String>) -> Result<std::collections::HashMap<String, String>, String> {
    identity::sign(&owner_identity(), &method, &path, body.as_deref())
}

#[tauri::command]
fn hub_for_project(project: String) -> String { identity::hub_for_project(&project) }

#[tauri::command]
fn known_projects() -> Vec<String> { identity::known_projects() }

#[derive(serde::Serialize)]
pub struct HubResponse { pub status: u16, pub body: String }

#[tauri::command]
async fn hub_request(base: String, method: String, path: String, body: Option<String>) -> Result<HubResponse, String> {
    let (status, body) = identity::request(&owner_identity(), &base, &method, &path, body).await?;
    Ok(HubResponse { status, body })
}

/// Streams already running, keyed by hub base URL.
///
/// Without this, every subscriber spawns its OWN connection: BOARD and FEED both subscribe, so each
/// event arrived twice and was rendered twice. One stream per hub, fanned out to all listeners by
/// Tauri's event bus — which is what the event bus is for.
static STREAMS: std::sync::Mutex<Option<std::collections::HashSet<String>>> = std::sync::Mutex::new(None);

#[tauri::command]
async fn start_stream(app: tauri::AppHandle, base: String) {
    use tauri::Emitter;
    {
        let mut g = STREAMS.lock().unwrap();
        let set = g.get_or_insert_with(std::collections::HashSet::new);
        if !set.insert(base.clone()) { return; }   // already streaming this hub
    }
    tauri::async_runtime::spawn(async move {
        identity::stream(&owner_identity(), &base, move |data| {
            let _ = app.emit("hub-event", data);
        }).await;
    });
}

/// The PATH a terminal would have. A Finder-launched app inherits only /usr/bin:/bin:/usr/sbin:/sbin,
/// so every brew/npm/cargo-installed CLI is invisible to anything we spawn. Fixing `node` alone was
/// not enough: the doctor probes each seat with `command -v`, so it reported a machine with no crew
/// CLIs at all while the same command in a terminal found six.
///
/// Ask the user's login shell first (it knows about the install dirs we can't guess, e.g. kimi's
/// ~/.kimi-code/bin), then union the usual roots, then whatever we inherited. Order is preserved and
/// duplicates dropped, so the shell's own precedence wins.
fn terminal_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut parts: Vec<String> = Vec::new();
    let mut push = |raw: &str| {
        for p in raw.split(':') {
            let p = p.trim();
            if !p.is_empty() && !parts.iter().any(|q| q == p) { parts.push(p.to_string()); }
        }
    };

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // -lic so rc files that set PATH are read. Take the LAST line: a noisy profile may print a
    // banner first, and a banner silently swallowing the PATH is exactly this bug again.
    if let Ok(out) = std::process::Command::new(&shell).arg("-lic").arg("printf '%s' \"$PATH\"").output() {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = text.lines().filter(|l| l.contains('/')).next_back() { push(line); }
        }
    }
    for p in ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin",
              &format!("{home}/.local/bin"), &format!("{home}/.bun/bin"),
              &format!("{home}/.cargo/bin"), &format!("{home}/.volta/bin")] {
        push(p);
    }
    push(&std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".to_string()));
    parts.join(":")
}

/// Run the EXISTING doctor engine and hand back its JSON. Deliberately shelling out rather than
/// re-implementing detection in Rust: two detectors would drift, and then the CLI and the app would
/// disagree about whether a seat is wired with no way to tell which is right.
#[tauri::command]
async fn doctor() -> Result<String, String> {
    let root = std::env::var("TRANTOR_ROOT").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{home}/development/trantor")
    });
    // Finder-launched apps get the bare system PATH (no /opt/homebrew/bin), so "node" alone
    // fails outside a terminal. Probe the usual install locations before falling back to PATH.
    let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        .iter().find(|p| std::path::Path::new(p).exists())
        .map(|p| p.to_string()).unwrap_or_else(|| "node".to_string());
    let out = tokio::process::Command::new(node)
        .arg(format!("{root}/bin/doctor.mjs")).arg("--json")
        .env("PATH", terminal_path())
        .output().await.map_err(|e| format!("doctor: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() { return Err(String::from_utf8_lossy(&out.stderr).to_string()); }
    Ok(text)
}


/// Where a project's code lives on THIS machine. Convention first (~/development/<project>),
/// TRANTOR_DEV_ROOT to relocate. Returns None when the repo simply isn't here — a card can
/// reference code on another operator's machine and the UI degrades to text.
fn project_dir(project: &str) -> Option<std::path::PathBuf> {
    let root = std::env::var("TRANTOR_DEV_ROOT").unwrap_or_else(|_| {
        format!("{}/development", std::env::var("HOME").unwrap_or_default())
    });
    let dir = std::path::Path::new(&root).join(project);
    if dir.is_dir() { Some(dir) } else { None }
}

/// The card→code link: which of the thread's file mentions exist in the repo, and which commits
/// touch the card (by "#id" in the message, or failing that, by the card's own files). Runs git
/// HERE because the hub cannot: repos live on operator machines, hubs do not have them.
#[tauri::command]
async fn card_code(project: String, card_id: i64, candidates: Vec<String>) -> Result<String, String> {
    let Some(dir) = project_dir(&project) else {
        return Ok(String::from("{\"dir\":null,\"files\":[],\"commits\":[],\"origin\":null}"));
    };
    // files: resolve each cited path against the repo. Direct join first; then git's own index
    // with a suffix pathspec — a monorepo crew cites paths relative to ITS app root
    // ("lib/marketing/x.ts") while the file lives at apps/web/src/lib/marketing/x.ts, and
    // `git ls-files '*<cited>'` finds it wherever it is (wildmatch spans directories).
    let mut files: Vec<String> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();
    for c in candidates.iter().take(40) {
        if c.contains("..") { continue; }
        let rel = c.trim_start_matches('/');
        if dir.join(rel).is_file() {
            if files.len() < 20 && !files.contains(&rel.to_string()) { files.push(rel.to_string()); }
        } else {
            unresolved.push(rel.to_string());
        }
    }
    if !unresolved.is_empty() {
        let mut args: Vec<String> = vec!["ls-files".into(), "--".into()];
        for u in unresolved.iter().take(30) { args.push(format!("*{u}")); }
        let out = tokio::process::Command::new("git")
            .arg("-C").arg(&dir).args(&args)
            .output().await.ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        for line in out.lines() {
            let f = line.trim().to_string();
            if !f.is_empty() && files.len() < 20 && !files.contains(&f) { files.push(f); }
        }
    }
    let git = |args: Vec<String>| {
        let dir = dir.clone();
        async move {
            tokio::process::Command::new("git")
                .arg("-C").arg(&dir).args(&args)
                .output().await.ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                .unwrap_or_default()
        }
    };
    // commits citing the card id, then commits touching the card's files — dedup, id-cites first
    let mut commits: Vec<(String, String)> = Vec::new();
    let mut push_lines = |out: String, commits: &mut Vec<(String, String)>| {
        for line in out.lines().take(8) {
            if let Some((sha, subject)) = line.split_once(' ') {
                if commits.iter().any(|(s, _)| s == sha) { continue; }
                if commits.len() >= 8 { break; }
                commits.push((sha.to_string(), subject.to_string()));
            }
        }
    };
    let by_id = git(vec!["log".into(), "--all".into(), "-n".into(), "8".into(), "--oneline".into(),
                        format!("--grep=#{}", card_id)]).await;
    push_lines(by_id, &mut commits);
    if !files.is_empty() {
        let mut args: Vec<String> = vec!["log".into(), "-n".into(), "6".into(), "--oneline".into(), "--".into()];
        args.extend(files.iter().cloned());
        let by_files = git(args).await;
        push_lines(by_files, &mut commits);
    }
    // origin → a clickable commit URL when the repo is on GitHub
    let origin_raw = git(vec!["remote".into(), "get-url".into(), "origin".into()]).await;
    let origin = origin_raw.trim();
    let web = if origin.contains("github.com") {
        let o = origin
            .trim_end_matches(".git")
            .replace("git@github.com:", "https://github.com/");
        Some(o)
    } else { None };
    let json = serde_json::json!({
        "dir": dir.to_string_lossy(),
        "files": files,
        "commits": commits.iter().map(|(sha, subject)| serde_json::json!({"sha": sha, "subject": subject})).collect::<Vec<_>>(),
        "origin": web,
    });
    Ok(json.to_string())
}

/// Open code where the operator wants it. Shelled `open` on purpose: macOS routes editor URL
/// schemes (vscode://, cursor://, zed://) without plugin scope ceremony, and `open -R` reveals.
#[tauri::command]
async fn open_code(target: String, kind: String) -> Result<(), String> {
    let mut c = tokio::process::Command::new("open");
    if kind == "reveal" { c.arg("-R"); }
    c.arg(&target);
    let st = c.status().await.map_err(|e| format!("open: {e}"))?;
    if st.success() { Ok(()) } else { Err(format!("open failed for {target}")) }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![greet, sign_request, hub_for_project, known_projects, hub_request, start_stream, doctor, card_code, open_code])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
