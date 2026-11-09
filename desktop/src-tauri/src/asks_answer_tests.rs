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
fn multi_choice_sorts_one_downward_sweep() {
    for picks in [vec![0, 2], vec![2, 0]] {
        assert_eq!(
            answer_keystrokes(question(true), picks, None),
            " \x1b[B\x1b[B \x1b[B\x1b[B\r\r"
        );
    }
}

#[test]
fn out_of_range_picks_reject_the_entire_answer() {
    for multi in [false, true] {
        for picks in [vec![0, 3], vec![0, -1], vec![99, -1]] {
            for other in [None, Some("Oslo".into())] {
                assert_eq!(answer_keystrokes(question(multi), picks.clone(), other), "");
            }
        }
    }
}

#[test]
fn duplicate_picks_reject_the_entire_answer() {
    for multi in [false, true] {
        for picks in [vec![0, 0], vec![2, 0, 2]] {
            for other in [None, Some("Kiwi".into())] {
                assert_eq!(answer_keystrokes(question(multi), picks.clone(), other), "");
            }
        }
    }
}

#[test]
fn empty_selection_types_nothing() {
    for multi in [false, true] {
        assert_eq!(answer_keystrokes(question(multi), vec![], None), "");
    }
}

#[test]
fn single_other_types_inline_before_enter() {
    assert_eq!(
        answer_keystrokes(question(false), vec![], Some("  Later  ".into())),
        "\x1b[B\x1b[B\x1b[B  Later  \r"
    );
}

#[test]
fn multi_other_moves_to_submit_before_enter_and_review() {
    assert_eq!(
        answer_keystrokes(question(true), vec![], Some("  Later  ".into())),
        "\x1b[B\x1b[B\x1b[B  Later  \x1b[B\r\r"
    );
    assert_eq!(
        answer_keystrokes(question(true), vec![2, 0], Some("Kiwi fruit".into())),
        " \x1b[B\x1b[B \x1b[BKiwi fruit\x1b[B\r\r"
    );
}

#[test]
fn other_strips_control_characters_before_blank_detection() {
    for multi in [false, true] {
        assert_eq!(
            answer_keystrokes(question(multi), vec![], Some(" \r\n\t\x1b\u{7f} ".into())),
            ""
        );
    }
    assert_eq!(
        answer_keystrokes(question(false), vec![], Some("Os\r\nlo\t\x1b\u{7f}".into())),
        "\x1b[B\x1b[B\x1b[BOslo\r"
    );
    assert_eq!(
        answer_keystrokes(question(false), vec![0], Some("\r\n".into())),
        "\r"
    );
}

#[test]
fn single_select_rejects_multiple_answers() {
    assert_eq!(answer_keystrokes(question(false), vec![0, 1], None), "");
    assert_eq!(
        answer_keystrokes(question(false), vec![0], Some("Oslo".into())),
        ""
    );
}

fn answer(picks: &[i64], other: Option<&str>) -> AskAnswer {
    AskAnswer {
        picks: picks.to_vec(),
        other: other.map(str::to_string),
    }
}

#[test]
fn three_questions_type_in_order_and_submit_review_once() {
    let mut single = question(false);
    single.options.truncate(2);
    assert_eq!(
        answers_keystrokes(
            vec![question(true), question(true), single],
            vec![
                answer(&[0, 2], Some("Kiwi")),
                answer(&[1], None),
                answer(&[], Some("Oslo"))
            ],
        ),
        " \x1b[B\x1b[B \x1b[BKiwi\x1b[B\r\x1b[B \x1b[B\x1b[B\x1b[B\r\x1b[B\x1b[BOslo\r\r"
    );
}

#[test]
fn several_single_questions_add_one_review_enter() {
    assert_eq!(
        answers_keystrokes(
            vec![question(false), question(false)],
            vec![answer(&[0], None), answer(&[2], None)]
        ),
        "\r\x1b[B\x1b[B\r\r"
    );
}

#[test]
fn invalid_later_answer_discards_all_keys() {
    for last in [
        answer(&[], None),
        answer(&[99], None),
        answer(&[0, 3], None),
        answer(&[0, -1], None),
        answer(&[0, 0], None),
        answer(&[0, 1], None),
        answer(&[], Some("\n")),
    ] {
        assert_eq!(
            answers_keystrokes(
                vec![question(true), question(false)],
                vec![answer(&[0], None), last]
            ),
            ""
        );
    }
}

// Regression from the live drill: the hub sent `other: ""` beside picks [0], the blank text won,
// and the relay typed nothing ("No answer was selected").
#[test]
fn blank_other_is_ignored_and_the_pick_is_typed() {
    assert_eq!(
        answer_keystrokes(question(false), vec![0], Some(String::new())),
        "\r"
    );
    assert_eq!(
        answer_keystrokes(question(false), vec![1], Some("   ".into())),
        "\x1b[B\r"
    );
}

#[test]
fn two_question_measured_fixture_preserves_spaces_in_other() {
    let mut multi = question(true);
    multi.options.truncate(2);
    let mut single = question(false);
    single.options.truncate(2);
    assert_eq!(
        answers_keystrokes(
            vec![multi, single],
            vec![
                answer(&[0], Some("Star fruit")),
                answer(&[], Some("New York"))
            ]
        ),
        " \x1b[B\x1b[BStar fruit\x1b[B\r\x1b[B\x1b[BNew York\r\r"
    );
}

#[test]
fn lone_question_measured_fixtures() {
    let mut single = question(false);
    single.options.truncate(2);
    assert_eq!(answer_keystrokes(single.clone(), vec![1], None), "\x1b[B\r");
    assert_eq!(
        answer_keystrokes(single.clone(), vec![], Some("Oslo".into())),
        "\x1b[B\x1b[BOslo\r"
    );
    single.multi_select = true;
    assert_eq!(
        answer_keystrokes(single, vec![], Some("Kiwi".into())),
        "\x1b[B\x1b[BKiwi\x1b[B\r\r"
    );
}
