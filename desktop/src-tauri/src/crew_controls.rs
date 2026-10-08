fn seat_arg(value: &str) -> bool {
    !value.is_empty() && !value.starts_with('-') && value.chars().all(|c| c.is_ascii_alphanumeric() || "-_:/.".contains(c))
}

fn allowed(args: &[String]) -> bool {
    let parts: Vec<&str> = args.iter().map(String::as_str).collect();
    match parts.as_slice() {
        ["balances", "--json"] | ["agent-settings", "status", "--json"] => true,
        ["up" | "down" | "seat-why", seat, "--json"] => seat_arg(seat),
        ["swap", seat, replacement, "--json"] => seat_arg(seat) && seat_arg(replacement),
        _ => false,
    }
}

#[tauri::command]
pub(crate) async fn workspace_cli(project: String, args: Vec<String>) -> Result<String, String> {
    if !allowed(&args) { return Err("Unsupported Workspace command".into()); }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    super::hub::run_cli_json_at(&refs, Some(&project)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn accepts(args: &[&str]) -> bool { allowed(&args.iter().map(|s| s.to_string()).collect::<Vec<_>>()) }
    #[test]
    fn only_scoped_crew_commands() {
        assert!(accepts(&["down", "glm", "--json"]));
        assert!(accepts(&["swap", "kimi", "glm:zai-coding-plan", "--json"]));
        assert!(!accepts(&["down", "--json"]));
        assert!(!accepts(&["down", "--all", "--json"]));
        assert!(!accepts(&["up", "glm;touch /tmp/no", "--json"]));
    }
}
