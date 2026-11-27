//! The Tauri commands of docs/CONTRACT-browser.md. All async, so the webview calls they make
//! never run on the main thread they wait for.

use super::device::Device;
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
pub async fn browser_navigate(h: State<'_, BrowserHandle>, project: String, url: String, page: Option<String>) -> Res<()> {
    msg(h.0.navigate(&project, &url, page.as_deref()))
}

#[tauri::command]
pub async fn browser_back(h: State<'_, BrowserHandle>, project: String, page: Option<String>) -> Res<()> {
    msg(h.0.back(&project, page.as_deref()))
}

#[tauri::command]
pub async fn browser_forward(h: State<'_, BrowserHandle>, project: String, page: Option<String>) -> Res<()> {
    msg(h.0.forward(&project, page.as_deref()))
}

#[tauri::command]
pub async fn browser_reload(h: State<'_, BrowserHandle>, project: String, page: Option<String>) -> Res<()> {
    msg(h.0.reload(&project, page.as_deref()))
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

/// Makes a page and activates it; returns its id.
#[tauri::command]
pub async fn browser_new_page(h: State<'_, BrowserHandle>, project: String, url: Option<String>) -> Res<String> {
    msg(h.0.create_page(&project, url.as_deref(), false, true))
}

#[tauri::command]
pub async fn browser_close_page(h: State<'_, BrowserHandle>, project: String, page: String) -> Res<()> {
    msg(h.0.close_page(&project, &page))
}

#[tauri::command]
pub async fn browser_select_page(h: State<'_, BrowserHandle>, project: String, page: String) -> Res<()> {
    msg(h.0.select_page(&project, &page))
}

/// `level` None resets to 1.0; the core clamps to 0.3..=3.0.
#[tauri::command]
pub async fn browser_zoom(h: State<'_, BrowserHandle>, project: String, level: Option<f64>) -> Res<()> {
    msg(h.0.zoom(&project, level))
}

#[tauri::command]
pub async fn browser_find(h: State<'_, BrowserHandle>, project: String, text: String, backwards: bool, page: Option<String>) -> Res<serde_json::Value> {
    msg(h.0.find(&project, &text, backwards, page.as_deref())).map(|found| serde_json::json!({ "found": found }))
}

#[tauri::command]
pub async fn browser_find_clear(h: State<'_, BrowserHandle>, project: String, page: Option<String>) -> Res<()> {
    msg(h.0.find_clear(&project, page.as_deref()))
}

#[tauri::command]
pub async fn browser_inspect(h: State<'_, BrowserHandle>, project: String, page: Option<String>) -> Res<()> {
    msg(h.0.inspect(&project, page.as_deref()))
}

#[tauri::command]
pub async fn browser_set_user_agent(h: State<'_, BrowserHandle>, project: String, preset: Option<String>) -> Res<()> {
    msg(h.0.set_user_agent(&project, preset.as_deref()))
}

#[tauri::command]
pub async fn browser_emulate(h: State<'_, BrowserHandle>, project: String, device: Option<Device>) -> Res<()> {
    msg(h.0.emulate(&project, device))
}

#[tauri::command]
pub async fn browser_history(h: State<'_, BrowserHandle>, project: String) -> Res<Vec<HistoryEntry>> {
    Ok(h.0.history(&project))
}

#[tauri::command]
pub async fn browser_favorites(h: State<'_, BrowserHandle>, project: String) -> Res<Vec<Favorite>> {
    Ok(h.0.favorites(&project))
}

#[tauri::command]
pub async fn browser_favorite_toggle(h: State<'_, BrowserHandle>, project: String, url: String, title: String) -> Res<bool> {
    Ok(h.0.favorite_toggle(&project, &url, &title))
}

#[tauri::command]
pub async fn browser_permissions(h: State<'_, BrowserHandle>, project: String) -> Res<Vec<Permission>> {
    Ok(h.0.permissions(&project))
}

#[tauri::command]
pub async fn browser_permission_revoke(h: State<'_, BrowserHandle>, project: String, host: String) -> Res<()> {
    h.0.permission_revoke(&project, &host);
    Ok(())
}

#[tauri::command]
pub async fn browser_clear_storage(h: State<'_, BrowserHandle>, project: String) -> Res<()> {
    msg(h.0.clear_storage(&project))
}
