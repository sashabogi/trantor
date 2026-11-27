use super::*;

#[test]
fn watcher_emits_after_start_returns_and_unwatch_releases_it() {
    let project = format!("watch-{}", std::process::id());
    let root = std::env::temp_dir().join(&project);
    std::fs::create_dir_all(&root).unwrap();
    let file = root.join("live.txt");
    std::fs::write(&file, "before").unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let key = FileWatchKey { root: root.clone(), project: project.clone(), seat: None };
    start_file_watch(root.clone(), project.clone(), None, move |paths| tx.send(paths).is_ok()).unwrap();
    // The command has returned: only the managed registry can retain the OS subscription.
    std::fs::write(&file, "after return").unwrap();
    let paths = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(paths.iter().any(|path| path == "live.txt"));
    assert!(lock_or_recover(&FILE_WATCHERS).as_ref().unwrap().contains_key(&key));
    file_unwatch(project, None);
    assert!(!lock_or_recover(&FILE_WATCHERS).as_ref().unwrap().contains_key(&key));
    while rx.try_recv().is_ok() {}
    std::fs::write(&file, "after unwatch").unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(500)).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn unwatch_releases_only_its_scope() {
    let project = format!("watch-scopes-{}", std::process::id());
    let root = std::env::temp_dir().join(&project);
    std::fs::create_dir_all(&root).unwrap();
    let main_key = FileWatchKey { root: root.clone(), project: project.clone(), seat: None };
    let seat_key = FileWatchKey { root: root.clone(), project: project.clone(), seat: Some("agent".into()) };
    start_file_watch(root.clone(), project.clone(), None, |_| true).unwrap();
    start_file_watch(root.clone(), project.clone(), Some("agent".into()), |_| true).unwrap();
    file_unwatch(project.clone(), Some("agent".into()));
    {
        let map = lock_or_recover(&FILE_WATCHERS);
        let map = map.as_ref().unwrap();
        assert!(map.contains_key(&main_key));
        assert!(!map.contains_key(&seat_key));
    }
    file_unwatch(project, None);
    std::fs::remove_dir_all(root).unwrap();
}
