#[allow(unused_imports)]
use super::*;

/// Candidate icon paths, best first. This is a FIXED list rather than a directory walk on purpose:
/// a walk of a repo the size of `flutter` or `crm-platform` would hit node_modules and cost more
/// than the row it decorates. Order encodes quality, not just likelihood — a purpose-built app icon
/// beats a 16px favicon.ico scaled up into a blurry smear, so .ico is deliberately LAST.
pub(crate) const ICON_CANDIDATES: &[&str] = &[
    // purpose-built app icons (Next.js app router, Tauri, plain assets)
    "src/app/icon.png",
    "public/icon.png",
    "assets/icon.png",
    "src-tauri/icons/128x128@2x.png",
    "src-tauri/icons/128x128.png",
    "src-tauri/icons/icon.png",
    // touch icons are ≥120px by spec — always better than a favicon
    "public/apple-touch-icon.png",
    "apple-touch-icon.png",
    "assets/web/apple-touch-icon.png",
    // brand logos
    "public/logo.png",
    "assets/logo.png",
    "assets/web/logo.png",
    ".github/assets/logo.png",
    "public/logo.svg",
    "logo.svg",
    "logo.png",
    // favicons — png before ico, ico last (16px, and WKWebView renders it poorly)
    "public/favicon.png",
    "assets/favicon.png",
    "src/app/favicon.ico",
    "public/favicon.ico",
    "favicon.ico",
];

/// Monorepo layouts put the web app one level down (apps/web, web/app), and a desktop shell is its
/// own subpackage (Trantor's mark lives at desktop/src-tauri/icons/). Checked after the top level misses.
pub(crate) const ICON_SUBROOTS: &[&str] = &[
    "apps/web",
    "apps/app",
    "web",
    "packages/web",
    "src",
    "desktop",
];

pub(crate) fn mime_for(path: &std::path::Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// A project's own icon as a `data:` URI, read from the repo on THIS machine (repos live here, hubs
/// do not). Null, never an error, when there is nothing to show: most projects ship no icon.
#[tauri::command]
pub(crate) fn project_icon(project: String) -> Option<String> {
    // Never let a hub-supplied project name walk the filesystem.
    if project.is_empty() || project.contains('/') || project.contains("..") {
        return None;
    }
    let dir = project_dir(&project)?;

    let mut roots: Vec<std::path::PathBuf> = vec![dir.clone()];
    for sub in ICON_SUBROOTS {
        roots.push(dir.join(sub));
    }

    for root in roots {
        for cand in ICON_CANDIDATES {
            let p = root.join(cand);
            if !p.is_file() {
                continue;
            }
            let Some(mime) = mime_for(&p) else { continue };
            // 512KB ceiling: this is a 20px sidebar glyph. Anything larger is a source asset
            // (crebral-desktop-lite ships a 512@2x App Store icon) and inlining it would bloat
            // every render for no visible gain.
            match std::fs::metadata(&p) {
                Ok(m) if m.len() > 0 && m.len() <= 512 * 1024 => {}
                _ => continue,
            }
            let Ok(bytes) = std::fs::read(&p) else {
                continue;
            };
            return Some(format!("data:{};base64,{}", mime, b64(&bytes)));
        }
    }
    None
}

/// Minimal base64. Pulling a crate in for one call site that runs a few dozen times at startup
/// would be a heavier dependency than the seven lines it replaces.
pub(crate) fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if c.len() > 1 {
            T[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

// ── local session truth ────────────────────────────────────────────────────────────────────────
// ACTIVE means a registered project with a terminal open. Heartbeats ride hook fires and go dark
// on an idle session, so this consults process truth, and herdr as well (#6163): a pane herdr can
// still name counts as open even when it runs on another machine. Contract: docs/CONTRACT-desktop.md.


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
