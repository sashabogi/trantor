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

/// The name this app SIGNS as. The hub rejects any /send whose `from` does not match the signer,
/// so the web side has to know it rather than assume "sasha@mac" — TRANTOR_IDENTITY can change it,
/// and a hardcoded copy would 403 the moment it did.
#[tauri::command]
fn identity_name() -> String { owner_identity() }

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

/// Candidate icon paths, best first. This is a FIXED list rather than a directory walk on purpose:
/// a walk of a repo the size of `flutter` or `crm-platform` would hit node_modules and cost more
/// than the row it decorates. Order encodes quality, not just likelihood — a purpose-built app icon
/// beats a 16px favicon.ico scaled up into a blurry smear, so .ico is deliberately LAST.
const ICON_CANDIDATES: &[&str] = &[
    // purpose-built app icons (Next.js app router, Tauri, plain assets)
    "src/app/icon.png", "public/icon.png", "assets/icon.png",
    "src-tauri/icons/128x128@2x.png", "src-tauri/icons/128x128.png", "src-tauri/icons/icon.png",
    // touch icons are ≥120px by spec — always better than a favicon
    "public/apple-touch-icon.png", "apple-touch-icon.png", "assets/web/apple-touch-icon.png",
    // brand logos
    "public/logo.png", "assets/logo.png", "assets/web/logo.png", ".github/assets/logo.png",
    "public/logo.svg", "logo.svg", "logo.png",
    // favicons — png before ico, ico last (16px, and WKWebView renders it poorly)
    "public/favicon.png", "assets/favicon.png",
    "src/app/favicon.ico", "public/favicon.ico", "favicon.ico",
];

/// Monorepo layouts put the web app one level down. Checked only after the top-level list misses,
/// and only for a bounded set of parent dirs — `apps/web/public/favicon.ico` (crm-platform) and
/// `web/app/favicon.ico` (polymarket-playground) are both real cases on this machine.
/// …and a desktop shell is very often its own subpackage — Trantor's own mark lives at
/// `desktop/src-tauri/icons/`, so without this the app is the one project that cannot show its face.
const ICON_SUBROOTS: &[&str] = &["apps/web", "apps/app", "web", "packages/web", "src", "desktop"];

fn mime_for(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// A project's own icon as a `data:` URI, read from the repo on THIS machine.
///
/// Repos live here and hubs do not — the same reason `card_code` runs locally. Returns null rather
/// than erroring whenever there is nothing good to show (no repo, no art, unreadable, or absurdly
/// large): roughly 60% of the projects on this machine ship no icon at all, so "none" is the normal
/// path and the caller falls back to a monogram. A hard error here would blank a sidebar row.
#[tauri::command]
fn project_icon(project: String) -> Option<String> {
    // Never let a hub-supplied project name walk the filesystem.
    if project.is_empty() || project.contains('/') || project.contains("..") { return None; }
    let dir = project_dir(&project)?;

    let mut roots: Vec<std::path::PathBuf> = vec![dir.clone()];
    for sub in ICON_SUBROOTS { roots.push(dir.join(sub)); }

    for root in roots {
        for cand in ICON_CANDIDATES {
            let p = root.join(cand);
            if !p.is_file() { continue; }
            let Some(mime) = mime_for(&p) else { continue };
            // 512KB ceiling: this is a 20px sidebar glyph. Anything larger is a source asset
            // (crebral-desktop-lite ships a 512@2x App Store icon) and inlining it would bloat
            // every render for no visible gain.
            match std::fs::metadata(&p) {
                Ok(m) if m.len() > 0 && m.len() <= 512 * 1024 => {}
                _ => continue,
            }
            let Ok(bytes) = std::fs::read(&p) else { continue };
            return Some(format!("data:{};base64,{}", mime, b64(&bytes)));
        }
    }
    None
}

/// Minimal base64. Pulling a crate in for one call site that runs a few dozen times at startup
/// would be a heavier dependency than the seven lines it replaces.
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if c.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

// ── local session truth ────────────────────────────────────────────────────────────────────────
// Sasha's ruling on what ACTIVE means (2026-08-13): "any project that has a terminal window open
// and is registered." Hub heartbeats cannot answer that — they ride hook fires, so an idle session
// goes dark after 5 quiet minutes and its project fell out of ACTIVE NOW while its window sat
// right there. Same quiet≠dead trap the delivery fix hit; same cure: consult PROCESS truth.
// Heartbeats keep the one job they are good at — "actually mid-turn right now" (the blink).

/// Parse `lsof -Fn` field output (p<pid> / fcwd / n<path>) into cwd paths.
fn lsof_cwds(out: &str) -> Vec<String> {
    out.lines().filter(|l| l.starts_with('n')).map(|l| l[1..].to_string()).collect()
}

/// A cwd is a project when it sits DIRECTLY under the dev root (or IS a project dir): the project
/// is the first path component after the root, so a session deep in a monorepo still maps to it.
fn project_of_cwd(cwd: &str, root: &str) -> Option<String> {
    let rel = cwd.strip_prefix(root)?.trim_start_matches('/');
    let first = rel.split('/').next()?.trim();
    if first.is_empty() || first.starts_with('.') { return None; }
    Some(first.to_string())
}

/// Projects with a live session process on THIS machine: interactive `claude` windows (cwd under
/// the dev root) plus crew-runner seats (project dir is argv[2]; ~/.agent-bus/fleet → "fleet").
#[tauri::command]
fn local_sessions() -> Vec<String> {
    let root = std::env::var("TRANTOR_DEV_ROOT").unwrap_or_else(|_| {
        format!("{}/development", std::env::var("HOME").unwrap_or_default())
    });
    let sh = |bin: &str, args: &[&str]| -> String {
        std::process::Command::new(bin).args(args).output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string()).unwrap_or_default()
    };
    let mut out: Vec<String> = Vec::new();

    // interactive claude windows
    let pids: Vec<String> = sh("/usr/bin/pgrep", &["-x", "claude"])
        .lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    if !pids.is_empty() {
        let list = pids.join(",");
        for cwd in lsof_cwds(&sh("/usr/sbin/lsof", &["-a", "-d", "cwd", "-p", &list, "-Fn"])) {
            if let Some(p) = project_of_cwd(&cwd, &root) { out.push(p); }
        }
    }

    // crew seats: `node …/crew-runner.mjs <agent> <projectDir>`
    for line in sh("/usr/bin/pgrep", &["-fl", "crew-runner.mjs"]).lines() {
        if let Some(dir) = line.split_whitespace().last() {
            if let Some(name) = std::path::Path::new(dir).file_name().and_then(|n| n.to_str()) {
                if !name.is_empty() && !name.starts_with('.') { out.push(name.to_string()); }
            }
        }
    }

    out.sort();
    out.dedup();
    out
}

// ── self-update ────────────────────────────────────────────────────────────────────────────────
// The app used to have NO idea a newer release existed: the only update path was someone typing
// `trantor app update` by hand, so a teammate's install stayed stale silently forever. These two
// commands close the loop — same release discovery as bin/app.mjs (any release carrying a
// Trantor_*.dmg is an app release, newest wins), same install steps, but runs in-process so it
// needs no CLI on PATH (a Finder-launched app gets a bare PATH — the 0.3.3 doctor bug).

const RELEASES_URL: &str = "https://api.github.com/repos/sashabogi/trantor/releases?per_page=30";
const APP_PATH: &str = "/Applications/Trantor.app";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdate {
    pub current: String,
    pub latest: String,
    pub tag: String,
    pub asset_name: String,
    pub url: String,
    pub size: u64,
    pub update_available: bool,
}

/// "0.3.4" < "0.3.10" (numeric per part, not lexicographic — the whole reason this isn't a string
/// compare). Unparseable parts count as 0 so a weird tag never panics.
fn version_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim().trim_start_matches('v').split('.')
            .map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap_or(0))
            .collect()
    };
    let (l, c) = (parse(latest), parse(current));
    for i in 0..l.len().max(c.len()) {
        let (a, b) = (*l.get(i).unwrap_or(&0), *c.get(i).unwrap_or(&0));
        if a != b { return a > b; }
    }
    false
}

/// Version out of an asset name: "Trantor_0.3.4_aarch64.dmg" → "0.3.4". Falls back to the tag with
/// its app-v/v prefix stripped — mirrors bin/app.mjs exactly, the two must agree on what "latest" is.
fn asset_version(asset_name: &str, tag: &str) -> String {
    // the version is the digits-and-dots run BETWEEN separators: _0.3.4_ in Trantor_0.3.4_aarch64.dmg
    for (i, _) in asset_name.match_indices(|c| c == '_' || c == '-') {
        let rest = &asset_name[i + 1..];
        let num: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        let followed_by_sep = rest.as_bytes().get(num.len()).is_some_and(|c| *c == b'_' || *c == b'-');
        if num.contains('.') && followed_by_sep { return num; }
    }
    tag.trim_start_matches("app-v").trim_start_matches('v').to_string()
}

#[tauri::command]
async fn app_update_check(app: tauri::AppHandle) -> Result<AppUpdate, String> {
    let current = app.package_info().version.to_string();
    // no-cache: GitHub's shared ~60s API cache can hide a release published seconds ago — the
    // exact bug that made `app update` reinstall the PREVIOUS version on the 0.2.0 release.
    let client = reqwest::Client::new();
    let r = client.get(RELEASES_URL)
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "trantor-desktop")
        .header("cache-control", "no-cache")
        .timeout(std::time::Duration::from_secs(15))
        .send().await.map_err(|e| format!("GitHub unreachable: {e}"))?;
    if !r.status().is_success() { return Err(format!("GitHub API {}", r.status())); }
    // reqwest here is built without its `json` feature (rustls+stream only) — parse via text
    let body = r.text().await.map_err(|e| e.to_string())?;
    let releases: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;

    let empty: Vec<serde_json::Value> = Vec::new();
    for rel in releases.as_array().unwrap_or(&empty) {
        let assets = rel["assets"].as_array().unwrap_or(&empty);
        let dmgs: Vec<&serde_json::Value> = assets.iter().filter(|a| {
            let n = a["name"].as_str().unwrap_or("");
            n.starts_with("Trantor") && n.ends_with(".dmg")
        }).collect();
        if dmgs.is_empty() { continue; }
        let asset: &serde_json::Value = dmgs.iter().find(|a| a["name"].as_str().unwrap_or("").contains("_aarch64")).copied().unwrap_or(dmgs[0]);
        let tag = rel["tag_name"].as_str().unwrap_or("").to_string();
        let asset_name = asset["name"].as_str().unwrap_or("").to_string();
        let latest = asset_version(&asset_name, &tag);
        return Ok(AppUpdate {
            update_available: version_newer(&latest, &current),
            url: asset["browser_download_url"].as_str().unwrap_or("").to_string(),
            size: asset["size"].as_u64().unwrap_or(0),
            current, latest, tag, asset_name,
        });
    }
    Err("no release with a Trantor DMG asset found".into())
}

/// Download the DMG, swap /Applications/Trantor.app, relaunch. On success this process EXITS —
/// the caller never sees the Ok. Every binary is an absolute path on purpose: Finder launches
/// apps with a bare PATH, and this must work from exactly such a launch.
#[tauri::command]
async fn app_update_install(url: String, asset_name: String) -> Result<(), String> {
    if !asset_name.starts_with("Trantor") || !asset_name.ends_with(".dmg") || asset_name.contains('/') {
        return Err("refusing unexpected asset name".into());
    }
    if !url.starts_with("https://github.com/") && !url.starts_with("https://objects.githubusercontent.com/") {
        return Err("refusing non-GitHub download URL".into());
    }
    let dmg = std::env::temp_dir().join(&asset_name);
    let bytes = reqwest::Client::new().get(&url)
        .header("user-agent", "trantor-desktop")
        .timeout(std::time::Duration::from_secs(300))
        .send().await.map_err(|e| format!("download failed: {e}"))?
        .error_for_status().map_err(|e| format!("download failed: {e}"))?
        .bytes().await.map_err(|e| format!("download failed: {e}"))?;
    std::fs::write(&dmg, &bytes).map_err(|e| format!("could not write DMG: {e}"))?;

    let run = |bin: &str, args: &[&str]| -> Result<String, String> {
        let out = std::process::Command::new(bin).args(args).output()
            .map_err(|e| format!("{bin}: {e}"))?;
        if !out.status.success() {
            return Err(format!("{bin} failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    };

    let attach = run("/usr/bin/hdiutil", &["attach", "-nobrowse", "-readonly", dmg.to_str().unwrap_or_default()])?;
    let mount = attach.trim().lines().last().unwrap_or("")
        .split('\t').last().unwrap_or("").trim().to_string();
    let result = (|| -> Result<(), String> {
        let src = std::path::Path::new(&mount).join("Trantor.app");
        if !mount.starts_with("/Volumes/") || !src.is_dir() {
            return Err(format!("unexpected DMG layout (mount: {})", if mount.is_empty() { "none" } else { &mount }));
        }
        if std::path::Path::new(APP_PATH).exists() {
            std::fs::remove_dir_all(APP_PATH).map_err(|e| format!("could not remove old app: {e}"))?;
        }
        run("/usr/bin/ditto", &[src.to_str().unwrap_or_default(), APP_PATH])?;
        // the download carries quarantine; the user explicitly clicked Update — clear it so
        // Gatekeeper doesn't refuse the unsigned build on relaunch
        let _ = run("/usr/bin/xattr", &["-dr", "com.apple.quarantine", APP_PATH]);
        Ok(())
    })();
    let _ = run("/usr/bin/hdiutil", &["detach", &mount, "-quiet"]);
    let _ = std::fs::remove_file(&dmg);
    result?;

    // -n: a fresh instance of the NEW bundle even though this (old) one is still alive for a
    // few more milliseconds. Then exit — the overlap is the handoff.
    let _ = std::process::Command::new("/usr/bin/open").args(["-n", APP_PATH]).spawn();
    std::thread::sleep(std::time::Duration::from_millis(300));
    std::process::exit(0);
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
        .invoke_handler(tauri::generate_handler![greet, sign_request, identity_name, hub_for_project, known_projects, hub_request, start_stream, doctor, card_code, open_code, project_icon, local_sessions, app_update_check, app_update_install])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod icon_tests {
    use super::*;

    // Hand-rolled base64 is exactly the kind of code that looks right and is wrong on the last
    // chunk, which is where every padding bug lives — so all three remainders are covered.
    #[test]
    fn base64_matches_the_reference_vectors() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(b"foob"), "Zm9vYg==");
        assert_eq!(b64(b"fooba"), "Zm9vYmE=");
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_handles_high_bytes() {
        // PNG magic — the real payload starts with bytes that are not valid UTF-8.
        assert_eq!(b64(&[0x89, 0x50, 0x4E, 0x47]), "iVBORw==");
        assert_eq!(b64(&[0xFF, 0xFF, 0xFF]), "////");
    }

    #[test]
    fn a_project_name_cannot_escape_the_dev_root() {
        assert_eq!(project_icon("../../etc".into()), None);
        assert_eq!(project_icon("a/b".into()), None);
        assert_eq!(project_icon("".into()), None);
    }

    #[test]
    fn mime_is_resolved_by_extension_and_rejects_the_rest() {
        use std::path::Path;
        assert_eq!(mime_for(Path::new("a/icon.png")), Some("image/png"));
        assert_eq!(mime_for(Path::new("a/logo.SVG")), Some("image/svg+xml"));
        assert_eq!(mime_for(Path::new("a/favicon.ico")), Some("image/x-icon"));
        assert_eq!(mime_for(Path::new("a/readme.md")), None);
        assert_eq!(mime_for(Path::new("a/noext")), None);
    }

    // .ico last is a deliberate quality ordering, not an accident — a 16px favicon scaled into a
    // 20px slot is the blurry result this whole change exists to avoid.
    #[test]
    fn purpose_built_icons_outrank_favicons() {
        let pos = |s: &str| ICON_CANDIDATES.iter().position(|c| *c == s).expect(s);
        assert!(pos("public/icon.png") < pos("public/favicon.ico"));
        assert!(pos("public/apple-touch-icon.png") < pos("public/favicon.ico"));
        assert!(pos("public/favicon.png") < pos("public/favicon.ico"));
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;

    #[test]
    fn lsof_field_output_yields_only_paths() {
        let out = "p31023\nfcwd\nn/Users/s/development/crebral-scribe\np33890\nfcwd\nn/Users/s/development/crebral-health\n";
        assert_eq!(lsof_cwds(out), vec!["/Users/s/development/crebral-scribe", "/Users/s/development/crebral-health"]);
        assert!(lsof_cwds("").is_empty());
    }

    // a session deep inside a monorepo still belongs to its project, and a shell sitting AT the
    // dev root belongs to nothing
    #[test]
    fn cwd_maps_to_the_first_component_under_the_root() {
        let r = "/Users/s/development";
        assert_eq!(project_of_cwd("/Users/s/development/crebral-health", r), Some("crebral-health".into()));
        assert_eq!(project_of_cwd("/Users/s/development/crm-platform/apps/web", r), Some("crm-platform".into()));
        assert_eq!(project_of_cwd("/Users/s/development", r), None);
        assert_eq!(project_of_cwd("/Users/s/development/.hidden", r), None);
        assert_eq!(project_of_cwd("/Users/s/elsewhere/thing", r), None);
    }
}

#[cfg(test)]
mod update_tests {
    use super::*;

    // numeric-per-part is the whole point: a string compare calls "0.3.10" OLDER than "0.3.9"
    #[test]
    fn version_compare_is_numeric_not_lexicographic() {
        assert!(version_newer("0.3.10", "0.3.9"));
        assert!(version_newer("0.4.0", "0.3.9"));
        assert!(version_newer("1.0.0", "0.99.99"));
        assert!(!version_newer("0.3.4", "0.3.4"));
        assert!(!version_newer("0.3.3", "0.3.4"));
        // downgrade must never be offered as an update
        assert!(!version_newer("0.3.3", "0.3.10"));
    }

    #[test]
    fn version_compare_survives_junk() {
        assert!(version_newer("v0.4", "0.3.9"));
        assert!(version_newer("0.3.4", "0.3"));
        assert!(!version_newer("garbage", "0.0.1"));
    }

    // must agree with bin/app.mjs's regex [_-]([0-9.]+)[_-] — the CLI and the app answering
    // "what's latest" differently would be its own bug
    #[test]
    fn asset_version_matches_the_cli_parse() {
        assert_eq!(asset_version("Trantor_0.3.4_aarch64.dmg", "app-v0.3.4"), "0.3.4");
        assert_eq!(asset_version("Trantor-0.10.0-x64.dmg", "app-v0.10.0"), "0.10.0");
        // no embedded version → tag with prefixes stripped
        assert_eq!(asset_version("Trantor.dmg", "app-v0.2.0"), "0.2.0");
        assert_eq!(asset_version("Trantor.dmg", "v1.2.3"), "1.2.3");
    }

    #[test]
    fn install_refuses_off_github_urls_and_odd_names() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = |u: &str, n: &str| rt.block_on(app_update_install(u.into(), n.into())).unwrap_err();
        assert!(err("https://evil.example/x.dmg", "Trantor_0.3.4_aarch64.dmg").contains("non-GitHub"));
        assert!(err("https://github.com/x/y.dmg", "NotTrantor.dmg").contains("unexpected asset"));
        assert!(err("https://github.com/x/y.dmg", "Trantor_../../x.dmg").contains("unexpected asset"));
    }
}
