use super::*;

fn file(tag: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!("write-guard-{tag}-{}", std::process::id()));
    std::fs::write(&path, "newer disk copy").unwrap();
    path
}

#[test]
fn matching_baseline_saves() {
    let path = file("match");
    write_file_checked(&path, "mine", Some("newer disk copy")).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "mine");
    std::fs::remove_file(path).unwrap();
}

#[test]
fn mismatched_baseline_refuses_without_changing_disk() {
    let path = file("mismatch");
    assert_eq!(write_file_checked(&path, "mine", Some("old baseline")).unwrap_err(), "file_changed_on_disk");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "newer disk copy");
    std::fs::remove_file(path).unwrap();
}

#[test]
fn absent_baseline_preserves_existing_callers() {
    let path = file("absent");
    write_file_checked(&path, "classic edit", None).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "classic edit");
    std::fs::remove_file(path).unwrap();
}
