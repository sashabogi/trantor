//! Device presets, user-agent presets and the letterbox math for emulation.

use super::types::{BrowserError, BrowserResult, Rect};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Device {
    pub name: String,
    pub w: f64,
    pub h: f64,
    #[serde(default)]
    pub mobile: bool,
}

pub const DEFAULT_UA: &str = "Safari";

const PRESETS: [(&str, f64, f64, bool); 6] = [
    ("iPhone 15", 393.0, 852.0, true),
    ("iPhone SE", 375.0, 667.0, true),
    ("Pixel 8", 412.0, 915.0, true),
    ("iPad", 820.0, 1180.0, true),
    ("Laptop", 1280.0, 800.0, false),
    ("Desktop", 1920.0, 1080.0, false),
];

#[cfg(test)]
pub fn presets() -> Vec<Device> {
    PRESETS.iter().map(|&(name, w, h, mobile)| Device { name: name.into(), w, h, mobile }).collect()
}

/// A preset by name, ignoring case.
pub fn preset(name: &str) -> Option<Device> {
    PRESETS
        .iter()
        .find(|p| p.0.eq_ignore_ascii_case(name.trim()))
        .map(|&(name, w, h, mobile)| Device { name: name.into(), w, h, mobile })
}

pub fn custom(w: f64, h: f64) -> Device {
    Device { name: format!("{}x{}", w.round(), h.round()), w, h, mobile: false }
}

impl Device {
    pub fn validate(&self) -> BrowserResult<()> {
        let ok = |v: f64| v.is_finite() && (50.0..=10000.0).contains(&v);
        if ok(self.w) && ok(self.h) {
            Ok(())
        } else {
            Err(BrowserError::new("bad_request", "a device is between 50 and 10000 pixels each way"))
        }
    }

    /// The user-agent preset a mobile device switches to.
    pub fn ua_preset(&self) -> &'static str {
        let n = self.name.to_ascii_lowercase();
        if n.starts_with("ipad") {
            "iPad"
        } else if n.starts_with("pixel") || n.contains("android") {
            "Android"
        } else {
            "iPhone"
        }
    }
}

const UAS: [(&str, &str); 6] = [
    ("Safari", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15"),
    ("Chrome", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
    ("Firefox", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0"),
    ("iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"),
    ("iPad", "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"),
    ("Android", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36"),
];

/// The canonical preset name for `name` (case-insensitive), if it is one.
pub fn ua_preset(name: &str) -> Option<&'static str> {
    UAS.iter().map(|(n, _)| *n).find(|n| n.eq_ignore_ascii_case(name.trim()))
}

pub fn ua_string(preset: &str) -> &'static str {
    UAS.iter().find(|(n, _)| *n == preset).map(|(_, s)| *s).unwrap_or(UAS[0].1)
}

/// The preset in force: a mobile device's own while emulating, else the operator's choice.
pub fn effective_ua<'a>(chosen: &'a str, emulation: Option<&Device>) -> &'a str {
    match emulation {
        Some(d) if d.mobile => d.ua_preset(),
        _ => chosen,
    }
}

/// Where the page sits inside the tab's rect and how far it is scaled to fit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Letterbox {
    pub frame: Rect,
    pub scale: f64,
}

pub fn letterbox(rect: Rect, d: &Device) -> Letterbox {
    let scale = (rect.w / d.w).min(rect.h / d.h).min(1.0);
    let (w, h) = (d.w * scale, d.h * scale);
    Letterbox { frame: Rect { x: rect.x + (rect.w - w) / 2.0, y: rect.y + (rect.h - h) / 2.0, w, h }, scale }
}

#[cfg(test)]
impl Rect {
    /// Clicks outside the page frame land on the letterbox, which ignores them.
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TAB: Rect = Rect { x: 10.0, y: 20.0, w: 800.0, h: 1000.0 };

    #[test]
    fn a_device_that_fits_is_centred_at_full_size() {
        let lb = letterbox(TAB, &preset("iphone 15").expect("preset"));
        assert_eq!(lb.scale, 1.0);
        assert_eq!(lb.frame, Rect { x: 10.0 + (800.0 - 393.0) / 2.0, y: 20.0 + (1000.0 - 852.0) / 2.0, w: 393.0, h: 852.0 });
    }

    #[test]
    fn a_device_larger_than_the_tab_scales_down_to_fit_and_stays_centred() {
        let d = preset("Desktop").expect("preset");
        let lb = letterbox(TAB, &d);
        assert!((lb.scale - 800.0 / 1920.0).abs() < 1e-9);
        assert!((lb.frame.w - 800.0).abs() < 1e-9 && (lb.frame.h - 1080.0 * lb.scale).abs() < 1e-9);
        assert!((lb.frame.y - (20.0 + (1000.0 - lb.frame.h) / 2.0)).abs() < 1e-9);
        // the page's CSS viewport is the device size again once pageZoom = scale
        assert!((lb.frame.w / lb.scale - d.w).abs() < 1e-6);
    }

    #[test]
    fn the_margins_around_the_frame_ignore_clicks() {
        let lb = letterbox(TAB, &preset("iPad").expect("preset"));
        assert!(lb.frame.x > TAB.x && lb.frame.contains(lb.frame.x + 1.0, lb.frame.y + 1.0));
        assert!(!lb.frame.contains(TAB.x + 1.0, TAB.y + 1.0));
        assert!(!lb.frame.contains(lb.frame.x - 1.0, lb.frame.y + 10.0));
        assert!(!lb.frame.contains(lb.frame.x + lb.frame.w + 1.0, lb.frame.y + 10.0));
    }

    #[test]
    fn mobile_devices_pick_a_user_agent_and_desktops_keep_the_chosen_one() {
        assert_eq!(effective_ua("Safari", preset("iPhone 15").as_ref()), "iPhone");
        assert_eq!(effective_ua("Safari", preset("iPad").as_ref()), "iPad");
        assert_eq!(effective_ua("Chrome", preset("Pixel 8").as_ref()), "Android");
        assert_eq!(effective_ua("Chrome", preset("Laptop").as_ref()), "Chrome");
        assert_eq!(effective_ua("Chrome", None), "Chrome");
        assert!(ua_string("iPhone").contains("Mobile"));
        assert_eq!(ua_preset("CHROME"), Some("Chrome"));
        assert_eq!(ua_preset("netscape"), None);
        assert_eq!(presets().len(), 6);
        assert!(custom(10.0, 10.0).validate().is_err() && custom(500.0, 500.0).validate().is_ok());
    }
}
