use super::*;

fn question(multi: bool) -> AskQuestion {
    serde_json::from_value(serde_json::json!({"question":"Ship?", "multiSelect":multi,
        "options":[{"label":"Yes"},{"label":"No"},{"label":"Maybe"}]}))
    .unwrap()
}

#[test]
fn single_choice_bytes_match_terminal_navigation() {
    assert_eq!(answer_keystrokes(question(false), vec![0], None), "\r");
    assert_eq!(
        answer_keystrokes(question(false), vec![2], None),
        "\x1b[B\x1b[B\r"
    );
}

#[test]
fn multi_choice_sorts_and_deduplicates_one_downward_sweep() {
    for picks in [vec![0, 2], vec![2, 0], vec![2, 0, 2]] {
        assert_eq!(
            answer_keystrokes(question(true), picks, None),
            " \x1b[B\x1b[B \r"
        );
    }
}

#[test]
fn invalid_indices_are_dropped_and_empty_selection_types_nothing() {
    assert_eq!(
        answer_keystrokes(question(false), vec![0, 99, -1], None),
        "\r"
    );
    assert_eq!(answer_keystrokes(question(false), vec![99, -1], None), "");
    assert_eq!(answer_keystrokes(question(true), vec![], None), "");
}

#[test]
fn other_walks_past_options_and_preserves_text_bytes() {
    for multi in [false, true] {
        assert_eq!(
            answer_keystrokes(question(multi), vec![], Some("  Later  ".into())),
            "\x1b[B\x1b[B\x1b[B\r  Later  \r"
        );
        assert_eq!(
            answer_keystrokes(question(multi), vec![], Some("  ".into())),
            ""
        );
    }
}
