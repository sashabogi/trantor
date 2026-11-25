use super::*;
use std::path::PathBuf;

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("trantor-f1-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("src/inner")).unwrap();
    std::fs::create_dir_all(dir.join("docs")).unwrap();
    std::fs::write(dir.join("a.txt"), "alpha").unwrap();
    std::fs::write(dir.join("src/b.txt"), "beta").unwrap();
    std::fs::write(dir.join("src/inner/c.txt"), "gamma").unwrap();
    dir
}

#[test]
fn moves_a_file_into_a_folder() {
    let root = scratch("movefile");
    move_path_in(&root, "a.txt", "docs/a.txt").unwrap();
    assert!(!root.join("a.txt").exists());
    assert_eq!(std::fs::read_to_string(root.join("docs/a.txt")).unwrap(), "alpha");
}

#[test]
fn moves_a_folder_with_its_contents() {
    let root = scratch("movedir");
    move_path_in(&root, "src", "docs/src").unwrap();
    assert!(!root.join("src").exists());
    assert_eq!(std::fs::read_to_string(root.join("docs/src/inner/c.txt")).unwrap(), "gamma");
}

#[test]
fn refuses_to_overwrite_and_leaves_both_alone() {
    let root = scratch("overwrite");
    std::fs::write(root.join("docs/a.txt"), "other").unwrap();
    assert!(move_path_in(&root, "a.txt", "docs/a.txt").is_err());
    assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "alpha");
    assert_eq!(std::fs::read_to_string(root.join("docs/a.txt")).unwrap(), "other");
}

#[test]
fn refuses_dotdot_and_absolute_paths() {
    let root = scratch("escape");
    assert!(move_path_in(&root, "a.txt", "../a.txt").is_err());
    assert!(move_path_in(&root, "../a.txt", "docs/a.txt").is_err());
    assert!(move_path_in(&root, "src/../a.txt", "docs/a.txt").is_err());
    let outside = std::env::temp_dir().join(format!("trantor-f1-outside-{}", std::process::id()));
    assert!(move_path_in(&root, "a.txt", outside.to_str().unwrap()).is_err());
    assert!(move_path_in(&root, "/etc/hosts", "docs/hosts").is_err());
    assert!(root.join("a.txt").exists());
    assert!(!outside.exists());
}

#[test]
fn refuses_a_folder_into_itself_and_a_missing_destination_folder() {
    let root = scratch("self");
    assert!(move_path_in(&root, "src", "src/inner/src").is_err());
    assert!(move_path_in(&root, "a.txt", "nowhere/a.txt").is_err());
    assert!(root.join("src/inner/c.txt").exists());
}

#[test]
fn refuses_a_destination_that_leaves_through_a_symlink() {
    let root = scratch("link");
    let outside = std::env::temp_dir().join(format!("trantor-f1-linkout-{}", std::process::id()));
    std::fs::create_dir_all(&outside).unwrap();
    std::os::unix::fs::symlink(&outside, root.join("escape")).unwrap();
    assert!(move_path_in(&root, "a.txt", "escape/a.txt").is_err());
    assert!(!outside.join("a.txt").exists());
    assert!(root.join("a.txt").exists());
}

#[test]
fn renames_a_folder_in_place_only() {
    let root = scratch("rename");
    rename_folder_in(&root, "src", "lib").unwrap();
    assert!(root.join("lib/inner/c.txt").exists());
    assert!(rename_folder_in(&root, "lib/inner", "docs/inner").is_err());
    assert!(rename_folder_in(&root, "lib", "docs").is_err());
    assert!(rename_folder_in(&root, "a.txt", "b.txt").is_err());
}

#[test]
fn gives_the_absolute_path_and_refuses_an_escape() {
    let root = scratch("abs");
    let full = absolute_path_in(&root, "src/b.txt").unwrap();
    assert_eq!(PathBuf::from(full), root.join("src/b.txt"));
    assert!(absolute_path_in(&root, "../b.txt").is_err());
    assert!(absolute_path_in(&root, "/etc").is_err());
}

#[test]
fn counts_files_in_nested_folders() {
    let root = scratch("count");
    assert_eq!(count_files_in(&root, "src").unwrap(), 2);
    assert!(count_files_in(&root, "a.txt").is_err());
    assert!(count_files_in(&root, "../x").is_err());
}

#[test]
fn deleting_a_folder_copies_it_to_the_trash_first() {
    let root = scratch("delete");
    let trash = scratch("trash");
    let kept = delete_folder_in(&root, "src", &trash).unwrap();
    assert!(!root.join("src").exists());
    let copy = PathBuf::from(&kept);
    assert!(copy.starts_with(&trash));
    assert_eq!(std::fs::read_to_string(copy.join("src/inner/c.txt")).unwrap(), "gamma");
    assert_eq!(std::fs::read_to_string(copy.join("src/b.txt")).unwrap(), "beta");
}

#[test]
fn trashing_a_file_keeps_a_copy_under_its_path() {
    let root = scratch("trashfile");
    let trash = scratch("trashfilebin");
    let kept = trash_file_in(&root, "src/b.txt", &trash).unwrap();
    assert!(PathBuf::from(&kept).starts_with(&trash));
    assert_eq!(std::fs::read_to_string(PathBuf::from(&kept).join("src/b.txt")).unwrap(), "beta");
    assert!(root.join("src/b.txt").exists());
}

#[test]
fn refuses_to_delete_a_file_a_missing_folder_or_an_escape() {
    let root = scratch("deletebad");
    let trash = scratch("deletebadtrash");
    assert!(delete_folder_in(&root, "a.txt", &trash).is_err());
    assert!(delete_folder_in(&root, "ghost", &trash).is_err());
    assert!(delete_folder_in(&root, "../src", &trash).is_err());
    assert!(delete_folder_in(&root, "/tmp", &trash).is_err());
    assert!(delete_folder_in(&root, ".git", &trash).is_err());
    assert!(root.join("a.txt").exists());
}

#[test]
fn reads_an_image_as_base64_and_reports_big_ones_without_bytes() {
    use base64::Engine;
    let root = scratch("image");
    std::fs::write(root.join("p.PNG"), [1u8, 2, 3]).unwrap();
    let body = read_image_in(&root, "p.PNG").unwrap();
    assert_eq!(body.mime, "image/png");
    assert_eq!(body.bytes, 3);
    let decoded = base64::engine::general_purpose::STANDARD.decode(body.data.unwrap()).unwrap();
    assert_eq!(decoded, vec![1, 2, 3]);
    let big = std::fs::File::create(root.join("big.gif")).unwrap();
    big.set_len(IMAGE_VIEW_CAP + 1).unwrap();
    let body = read_image_in(&root, "big.gif").unwrap();
    assert_eq!(body.bytes, IMAGE_VIEW_CAP + 1);
    assert!(body.data.is_none());
    assert!(read_image_in(&root, "a.txt").is_err());
    assert!(read_image_in(&root, "../p.png").is_err());
}
