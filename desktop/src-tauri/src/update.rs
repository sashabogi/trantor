#[allow(unused_imports)]
use super::*;

pub(crate) const RELEASES_URL: &str = "https://api.github.com/repos/sashabogi/trantor/releases?per_page=30";
pub(crate) const APP_PATH: &str = "/Applications/Trantor.app";

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
pub(crate) fn version_newer(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Vec<u64> {
        s.trim()
            .trim_start_matches('v')
            .split('.')
            .map(|p| {
                p.chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0)
            })
            .collect()
    };
    let (l, c) = (parse(latest), parse(current));
    for i in 0..l.len().max(c.len()) {
        let (a, b) = (*l.get(i).unwrap_or(&0), *c.get(i).unwrap_or(&0));
        if a != b {
            return a > b;
        }
    }
    false
}

/// Version out of an asset name: "Trantor_0.3.4_aarch64.dmg" → "0.3.4". Falls back to the tag with
/// its app-v/v prefix stripped — mirrors bin/app.mjs exactly, the two must agree on what "latest" is.
pub(crate) fn asset_version(asset_name: &str, tag: &str) -> String {
    // the version is the digits-and-dots run BETWEEN separators: _0.3.4_ in Trantor_0.3.4_aarch64.dmg
    for (i, _) in asset_name.match_indices(|c| c == '_' || c == '-') {
        let rest = &asset_name[i + 1..];
        let num: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        let followed_by_sep = rest
            .as_bytes()
            .get(num.len())
            .is_some_and(|c| *c == b'_' || *c == b'-');
        if num.contains('.') && followed_by_sep {
            return num;
        }
    }
    tag.trim_start_matches("app-v")
        .trim_start_matches('v')
        .to_string()
}

#[tauri::command]
pub(crate) async fn app_update_check(app: tauri::AppHandle) -> Result<AppUpdate, String> {
    let current = app.package_info().version.to_string();
    // no-cache: GitHub's shared ~60s API cache can hide a release published seconds ago — the
    // exact bug that made `app update` reinstall the PREVIOUS version on the 0.2.0 release.
    let client = reqwest::Client::new();
    let r = client
        .get(RELEASES_URL)
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "trantor-desktop")
        .header("cache-control", "no-cache")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("GitHub unreachable: {e}"))?;
    if !r.status().is_success() {
        return Err(format!("GitHub API {}", r.status()));
    }
    // reqwest here is built without its `json` feature (rustls+stream only) — parse via text
    let body = r.text().await.map_err(|e| e.to_string())?;
    let releases: serde_json::Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;

    let empty: Vec<serde_json::Value> = Vec::new();
    for rel in releases.as_array().unwrap_or(&empty) {
        let assets = rel["assets"].as_array().unwrap_or(&empty);
        let dmgs: Vec<&serde_json::Value> = assets
            .iter()
            .filter(|a| {
                let n = a["name"].as_str().unwrap_or("");
                n.starts_with("Trantor") && n.ends_with(".dmg")
            })
            .collect();
        if dmgs.is_empty() {
            continue;
        }
        let asset: &serde_json::Value = dmgs
            .iter()
            .find(|a| a["name"].as_str().unwrap_or("").contains("_aarch64"))
            .copied()
            .unwrap_or(dmgs[0]);
        let tag = rel["tag_name"].as_str().unwrap_or("").to_string();
        let asset_name = asset["name"].as_str().unwrap_or("").to_string();
        let latest = asset_version(&asset_name, &tag);
        return Ok(AppUpdate {
            update_available: version_newer(&latest, &current),
            url: asset["browser_download_url"]
                .as_str()
                .unwrap_or("")
                .to_string(),
            size: asset["size"].as_u64().unwrap_or(0),
            current,
            latest,
            tag,
            asset_name,
        });
    }
    Err("no release with a Trantor DMG asset found".into())
}

/// Download the DMG, swap /Applications/Trantor.app, relaunch. On success this process EXITS —
/// the caller never sees the Ok. Every binary is an absolute path on purpose: Finder launches
/// apps with a bare PATH, and this must work from exactly such a launch.
#[tauri::command]
pub(crate) async fn app_update_install(url: String, asset_name: String) -> Result<(), String> {
    if !asset_name.starts_with("Trantor")
        || !asset_name.ends_with(".dmg")
        || asset_name.contains('/')
    {
        return Err("refusing unexpected asset name".into());
    }
    if !url.starts_with("https://github.com/")
        && !url.starts_with("https://objects.githubusercontent.com/")
    {
        return Err("refusing non-GitHub download URL".into());
    }
    let dmg = std::env::temp_dir().join(&asset_name);
    let bytes = reqwest::Client::new()
        .get(&url)
        .header("user-agent", "trantor-desktop")
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("download failed: {e}"))?;
    std::fs::write(&dmg, &bytes).map_err(|e| format!("could not write DMG: {e}"))?;

    let run = |bin: &str, args: &[&str]| -> Result<String, String> {
        let out = std::process::Command::new(bin)
            .args(args)
            .output()
            .map_err(|e| format!("{bin}: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "{bin} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    };

    let attach = run(
        "/usr/bin/hdiutil",
        &[
            "attach",
            "-nobrowse",
            "-readonly",
            dmg.to_str().unwrap_or_default(),
        ],
    )?;
    let mount = attach
        .trim()
        .lines()
        .last()
        .unwrap_or("")
        .split('\t')
        .last()
        .unwrap_or("")
        .trim()
        .to_string();
    let result = (|| -> Result<(), String> {
        let src = std::path::Path::new(&mount).join("Trantor.app");
        if !mount.starts_with("/Volumes/") || !src.is_dir() {
            return Err(format!(
                "unexpected DMG layout (mount: {})",
                if mount.is_empty() { "none" } else { &mount }
            ));
        }
        if std::path::Path::new(APP_PATH).exists() {
            std::fs::remove_dir_all(APP_PATH)
                .map_err(|e| format!("could not remove old app: {e}"))?;
        }
        run(
            "/usr/bin/ditto",
            &[src.to_str().unwrap_or_default(), APP_PATH],
        )?;
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
    let _ = identity_env::command("/usr/bin/open")
        .args(["-n", APP_PATH])
        .spawn();
    std::thread::sleep(std::time::Duration::from_millis(300));
    std::process::exit(0);
}

/// The card→code link: which of the thread's file mentions exist in the repo, and which commits
/// touch the card (by "#id" in the message, or failing that, by the card's own files). Runs git
/// HERE because the hub cannot: repos live on operator machines, hubs do not have them.
#[tauri::command]
pub(crate) async fn card_code(
    project: String,
    card_id: i64,
    candidates: Vec<String>,
) -> Result<String, String> {
    let Some(dir) = project_dir(&project) else {
        return Ok(String::from(
            "{\"dir\":null,\"files\":[],\"commits\":[],\"origin\":null}",
        ));
    };
    // files: resolve each cited path against the repo. Direct join first; then git's own index
    // with a suffix pathspec — a monorepo crew cites paths relative to ITS app root
    // ("lib/marketing/x.ts") while the file lives at apps/web/src/lib/marketing/x.ts, and
    // `git ls-files '*<cited>'` finds it wherever it is (wildmatch spans directories).
    let mut files: Vec<String> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();
    for c in candidates.iter().take(40) {
        if c.contains("..") {
            continue;
        }
        let rel = c.trim_start_matches('/');
        if dir.join(rel).is_file() {
            if files.len() < 20 && !files.contains(&rel.to_string()) {
                files.push(rel.to_string());
            }
        } else {
            unresolved.push(rel.to_string());
        }
    }
    if !unresolved.is_empty() {
        let mut args: Vec<String> = vec!["ls-files".into(), "--".into()];
        for u in unresolved.iter().take(30) {
            args.push(format!("*{u}"));
        }
        let out = tokio::process::Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(&args)
            .output()
            .await
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        for line in out.lines() {
            let f = line.trim().to_string();
            if !f.is_empty() && files.len() < 20 && !files.contains(&f) {
                files.push(f);
            }
        }
    }
    let git = |args: Vec<String>| {
        let dir = dir.clone();
        async move {
            tokio::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(&args)
                .output()
                .await
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                .unwrap_or_default()
        }
    };
    // commits citing the card id, then commits touching the card's files — dedup, id-cites first
    let mut commits: Vec<(String, String)> = Vec::new();
    let push_lines = |out: String, commits: &mut Vec<(String, String)>| {
        for line in out.lines().take(8) {
            if let Some((sha, subject)) = line.split_once(' ') {
                if commits.iter().any(|(s, _)| s == sha) {
                    continue;
                }
                if commits.len() >= 8 {
                    break;
                }
                commits.push((sha.to_string(), subject.to_string()));
            }
        }
    };
    let by_id = git(vec![
        "log".into(),
        "--all".into(),
        "-n".into(),
        "8".into(),
        "--oneline".into(),
        format!("--grep=#{}", card_id),
    ])
    .await;
    push_lines(by_id, &mut commits);
    if !files.is_empty() {
        let mut args: Vec<String> = vec![
            "log".into(),
            "-n".into(),
            "6".into(),
            "--oneline".into(),
            "--".into(),
        ];
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
    } else {
        None
    };
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
pub(crate) async fn open_code(target: String, kind: String) -> Result<(), String> {
    let mut c = tokio::process::Command::new("open");
    if kind == "reveal" {
        c.arg("-R");
    }
    c.arg(&target);
    let st = c.status().await.map_err(|e| format!("open: {e}"))?;
    if st.success() {
        Ok(())
    } else {
        Err(format!("open failed for {target}"))
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
        assert_eq!(
            asset_version("Trantor_0.3.4_aarch64.dmg", "app-v0.3.4"),
            "0.3.4"
        );
        assert_eq!(
            asset_version("Trantor-0.10.0-x64.dmg", "app-v0.10.0"),
            "0.10.0"
        );
        // no embedded version → tag with prefixes stripped
        assert_eq!(asset_version("Trantor.dmg", "app-v0.2.0"), "0.2.0");
        assert_eq!(asset_version("Trantor.dmg", "v1.2.3"), "1.2.3");
    }

    #[test]
    fn install_refuses_off_github_urls_and_odd_names() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let err = |u: &str, n: &str| {
            rt.block_on(app_update_install(u.into(), n.into()))
                .unwrap_err()
        };
        assert!(
            err("https://evil.example/x.dmg", "Trantor_0.3.4_aarch64.dmg").contains("non-GitHub")
        );
        assert!(err("https://github.com/x/y.dmg", "NotTrantor.dmg").contains("unexpected asset"));
        assert!(
            err("https://github.com/x/y.dmg", "Trantor_../../x.dmg").contains("unexpected asset")
        );
    }
}
