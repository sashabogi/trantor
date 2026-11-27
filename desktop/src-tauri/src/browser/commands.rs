//! The Tauri commands of docs/CONTRACT-browser.md. All async, so the webview calls they make
//! never run on the main thread they wait for.

use super::types::*;
use super::BrowserHandle;
use tauri::State;

type Res<T> = Result<T, String>;

fn msg<T>(r: BrowserResult<T>) -> Res<T> {
    r.map_err(|e| e.message)
}

#[tauri::command]
pub async fn browser_open(h: State<'_, BrowserHandle>, project: String, url: Option<String>, rect: Rect) -> Res<BrowserState> {
    msg(h.0.open(&project, url, rect))
}

#[tauri::command]
pub async fn browser_set_rect(h: State<'_, BrowserHandle>, project: String, rect: Rect) -> Res<()> {
    msg(h.0.set_rect(&project, rect))
}

#[tauri::command]
pub async fn browser_set_visible(h: State<'_, BrowserHandle>, project: String, visible: bool) -> Res<()> {
    msg(h.0.set_visible(&project, visible))
}

#[tauri::command]
pub async fn browser_navigate(h: State<'_, BrowserHandle>, project: String, url: String) -> Res<()> {
    msg(h.0.navigate(&project, &url))
}

#[tauri::command]
pub async fn browser_back(h: State<'_, BrowserHandle>, project: String) -> Res<()> {
    msg(h.0.back(&project))
}

#[tauri::command]
pub async fn browser_forward(h: State<'_, BrowserHandle>, project: String) -> Res<()> {
    msg(h.0.forward(&project))
}

#[tauri::command]
pub async fn browser_reload(h: State<'_, BrowserHandle>, project: String) -> Res<()> {
    msg(h.0.reload(&project))
}

#[tauri::command]
pub async fn browser_pop_out(h: State<'_, BrowserHandle>, project: String) -> Res<()> {
    msg(h.0.pop_out(&project))
}

#[tauri::command]
pub async fn browser_put_back(h: State<'_, BrowserHandle>, project: String, rect: Rect) -> Res<()> {
    msg(h.0.put_back(&project, rect))
}

#[tauri::command]
pub async fn browser_close(h: State<'_, BrowserHandle>, project: String) -> Res<()> {
    msg(h.0.close(&project))
}

#[tauri::command]
pub async fn browser_state(h: State<'_, BrowserHandle>, project: String) -> Res<BrowserState> {
    Ok(h.0.state(&project))
}

#[tauri::command]
pub async fn browser_take_over(h: State<'_, BrowserHandle>, project: String) -> Res<()> {
    h.0.take_over(&project);
    Ok(())
}

#[tauri::command]
pub async fn browser_give_back(h: State<'_, BrowserHandle>, project: String) -> Res<()> {
    h.0.give_back(&project);
    Ok(())
}

/// Answers a `browser://ask`: `choice` is "once", "site" or "deny".
#[tauri::command]
pub async fn browser_answer(h: State<'_, BrowserHandle>, id: String, choice: String) -> Res<()> {
    h.0.answer(&id, &choice)
}

/// The Steps list: what agents did in this project's browser, oldest first.
#[tauri::command]
pub async fn browser_steps(h: State<'_, BrowserHandle>, project: String) -> Res<Vec<Step>> {
    Ok(h.0.steps(&project))
}
