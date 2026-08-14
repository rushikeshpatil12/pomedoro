use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    LogicalPosition, LogicalSize, Manager, State, UserAttentionType, WebviewWindow,
};
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
use winreg::RegKey;

/// Full window size, in logical (DPI-independent) pixels.
const FULL_WIDTH: f64 = 380.0;
const FULL_HEIGHT: f64 = 580.0;

/// 1 inch square at the OS baseline of 96 logical px/inch. Tauri's
/// LogicalSize is automatically scaled by the monitor's DPI factor, so this
/// stays a true 1x1 inch square on any display scaling setting.
const COMPACT_SIZE: f64 = 96.0;
const COMPACT_MARGIN: f64 = 14.0;

/// Toggle whether the window stays above every other app.
#[tauri::command]
fn set_always_on_top(window: WebviewWindow, value: bool) -> Result<(), String> {
    window.set_always_on_top(value).map_err(|e| e.to_string())
}

/// Send the window to the tray without closing the app (timer keeps running).
#[tauri::command]
fn hide_window(window: WebviewWindow) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
fn show_window(window: WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Flash the window/taskbar entry to grab attention when a session ends.
/// `Critical` keeps flashing until the window regains focus, which is what
/// we want for a timer alarm the user might not be looking at.
#[tauri::command]
fn flash_window(window: WebviewWindow) -> Result<(), String> {
    window
        .request_user_attention(Some(UserAttentionType::Critical))
        .map_err(|e| e.to_string())
}

/// Switch between the full timer view and the 1x1" corner widget, resizing
/// and repositioning the OS window to match.
#[tauri::command]
fn toggle_compact(window: WebviewWindow, compact: bool) -> Result<(), String> {
    window.set_resizable(!compact).map_err(|e| e.to_string())?;

    if compact {
        window
            .set_size(LogicalSize::new(COMPACT_SIZE, COMPACT_SIZE))
            .map_err(|e| e.to_string())?;

        if let Ok(Some(monitor)) = window.current_monitor() {
            let scale = monitor.scale_factor();
            let m_pos = monitor.position();
            let m_size = monitor.size();

            let m_logical_x = m_pos.x as f64 / scale;
            let m_logical_y = m_pos.y as f64 / scale;
            let m_logical_w = m_size.width as f64 / scale;
            let m_logical_h = m_size.height as f64 / scale;

            let x = m_logical_x + m_logical_w - COMPACT_SIZE - COMPACT_MARGIN;
            let y = m_logical_y + m_logical_h - COMPACT_SIZE - COMPACT_MARGIN;

            let _ = window.set_position(LogicalPosition::new(x, y));
        }
    } else {
        window
            .set_size(LogicalSize::new(FULL_WIDTH, FULL_HEIGHT))
            .map_err(|e| e.to_string())?;
        let _ = window.center();
    }

    Ok(())
}

// ---------- distraction-site blocking (local proxy, no admin required) ----------
//
// Instead of touching any system file, we run a tiny forward proxy on
// 127.0.0.1 inside this process and point the *per-user* Windows proxy
// setting (HKEY_CURRENT_USER, no elevation needed) at it. The proxy just
// refuses CONNECT/requests to blocked hosts and transparently splices bytes
// for everything else - it never decrypts HTTPS, it only ever looks at the
// requested hostname. Chrome/Edge/IE read this system proxy setting
// automatically; Firefox needs a one-time manual "use system proxy" toggle.
//
// The registry values we overwrite (ProxyEnable/ProxyServer/ProxyOverride)
// are saved to disk *before* we touch them, and restored from that same file
// - both when blocking is turned off normally, and automatically on the next
// app startup if the file is still there (meaning we crashed/were killed
// while blocking was active). The proxy itself keeps running at all times
// with an empty blocklist when inactive, so even if a restore step were ever
// missed, the leftover proxy is a harmless passthrough rather than a block.

const PROXY_PORT: u16 = 8891;
const INTERNET_SETTINGS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

#[derive(Default)]
struct BlockList(Arc<Mutex<HashSet<String>>>);

#[derive(Serialize, Deserialize)]
struct SavedProxyState {
    enable: u32,
    server: String,
    proxy_override: String,
}

fn proxy_state_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("proxy_prev_state.json"))
}

fn internet_settings_key(access: u32) -> std::io::Result<RegKey> {
    RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(INTERNET_SETTINGS_KEY, access)
}

fn notify_proxy_settings_changed() {
    // Tell already-running apps (an open browser window) to re-read the
    // system proxy settings immediately, via the documented WinINet options.
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::Networking::WinInet::{
            InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
        };
        let _ = InternetSetOptionW(None, INTERNET_OPTION_SETTINGS_CHANGED, None, 0);
        let _ = InternetSetOptionW(None, INTERNET_OPTION_REFRESH, None, 0);
    }
}

fn read_current_proxy_state() -> Result<SavedProxyState, String> {
    let key = internet_settings_key(KEY_READ).map_err(|e| e.to_string())?;
    Ok(SavedProxyState {
        enable: key.get_value("ProxyEnable").unwrap_or(0),
        server: key.get_value("ProxyServer").unwrap_or_default(),
        proxy_override: key.get_value("ProxyOverride").unwrap_or_default(),
    })
}

fn write_proxy_state(state: &SavedProxyState) -> Result<(), String> {
    let key = internet_settings_key(KEY_WRITE).map_err(|e| e.to_string())?;
    key.set_value("ProxyEnable", &state.enable)
        .map_err(|e| e.to_string())?;
    key.set_value("ProxyServer", &state.server)
        .map_err(|e| e.to_string())?;
    key.set_value("ProxyOverride", &state.proxy_override)
        .map_err(|e| e.to_string())?;
    notify_proxy_settings_changed();
    Ok(())
}

/// Restore the saved pre-blocking proxy state from disk, if a save file is
/// present (normal disable path, or crash-recovery on the next launch).
fn restore_saved_proxy_state(app: &tauri::AppHandle) -> Result<(), String> {
    let path = proxy_state_file(app)?;
    if !path.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let saved: SavedProxyState = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    write_proxy_state(&saved)?;
    let _ = fs::remove_file(&path);
    Ok(())
}

#[tauri::command]
fn enable_site_blocking(
    app: tauri::AppHandle,
    state: State<BlockList>,
    domains: Vec<String>,
) -> Result<(), String> {
    let path = proxy_state_file(&app)?;
    if !path.exists() {
        let current = read_current_proxy_state()?;
        let json = serde_json::to_string(&current).map_err(|e| e.to_string())?;
        fs::write(&path, json).map_err(|e| e.to_string())?;
    }

    {
        let mut set = state.0.lock().map_err(|_| "block list lock poisoned")?;
        *set = domains
            .into_iter()
            .map(|d| d.trim().to_lowercase())
            .filter(|d| !d.is_empty())
            .collect();
    }

    write_proxy_state(&SavedProxyState {
        enable: 1,
        server: format!("127.0.0.1:{PROXY_PORT}"),
        proxy_override: "<local>".to_string(),
    })
}

#[tauri::command]
fn disable_site_blocking(app: tauri::AppHandle, state: State<BlockList>) -> Result<(), String> {
    {
        let mut set = state.0.lock().map_err(|_| "block list lock poisoned")?;
        set.clear();
    }
    restore_saved_proxy_state(&app)
}

fn is_blocked(host: &str, blocked: &HashSet<String>) -> bool {
    let host = host.to_lowercase();
    blocked
        .iter()
        .any(|b| host == *b || host.ends_with(&format!(".{b}")))
}

fn parse_target(request: &str) -> Option<(String, u16, bool)> {
    let mut lines = request.lines();
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?;
    let target = parts.next()?;

    if method.eq_ignore_ascii_case("CONNECT") {
        let mut sp = target.split(':');
        let host = sp.next()?.to_string();
        let port = sp.next().and_then(|p| p.parse().ok()).unwrap_or(443);
        Some((host, port, true))
    } else {
        let host_header = request
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with("host:"))?
            .splitn(2, ':')
            .nth(1)?
            .trim()
            .to_string();
        let mut sp = host_header.split(':');
        let host = sp.next()?.to_string();
        let port = sp.next().and_then(|p| p.parse().ok()).unwrap_or(80);
        Some((host, port, false))
    }
}

fn handle_proxy_connection(mut client: TcpStream, blocklist: Arc<Mutex<HashSet<String>>>) {
    let mut buf = [0u8; 8192];
    let n = match client.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return,
    };
    let request = String::from_utf8_lossy(&buf[..n]).to_string();
    let Some((host, port, is_connect)) = parse_target(&request) else {
        return;
    };

    let blocked = blocklist
        .lock()
        .map(|set| is_blocked(&host, &set))
        .unwrap_or(false);

    if blocked {
        let body = "Blocked by Pomedoro while you're focusing.";
        let resp = format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = client.write_all(resp.as_bytes());
        return;
    }

    let Ok(mut upstream) = TcpStream::connect((host.as_str(), port)) else {
        let _ = client.write_all(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        return;
    };

    if is_connect {
        if client
            .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            .is_err()
        {
            return;
        }
    } else if upstream.write_all(&buf[..n]).is_err() {
        return;
    }

    let (Ok(mut client_read), Ok(mut upstream_write)) = (client.try_clone(), upstream.try_clone())
    else {
        return;
    };
    let uploader = thread::spawn(move || {
        let _ = std::io::copy(&mut client_read, &mut upstream_write);
    });
    let _ = std::io::copy(&mut upstream, &mut client);
    let _ = uploader.join();
}

fn start_proxy_server(blocklist: Arc<Mutex<HashSet<String>>>) {
    thread::spawn(move || {
        let Ok(listener) = TcpListener::bind(("127.0.0.1", PROXY_PORT)) else {
            return;
        };
        for stream in listener.incoming().flatten() {
            let blocklist = blocklist.clone();
            thread::spawn(move || handle_proxy_connection(stream, blocklist));
        }
    });
}

// There's no public, supported API for a third-party app to toggle Windows
// Focus Assist (or silence just one other app's notifications) - the closest
// reliable option is a one-click deep link into the Settings page so the
// user can flip it on themselves.
#[tauri::command]
fn open_focus_assist_settings() -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/C", "start", "", "ms-settings:quiethours"])
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            set_always_on_top,
            hide_window,
            show_window,
            quit_app,
            flash_window,
            toggle_compact,
            enable_site_blocking,
            disable_site_blocking,
            open_focus_assist_settings,
        ])
        .manage(BlockList::default())
        .setup(|app| {
            let blocklist = app.state::<BlockList>().0.clone();
            start_proxy_server(blocklist);

            // If the app crashed or was killed while blocking was active, the
            // saved-state file from enable_site_blocking will still be on
            // disk - restore the user's original proxy settings from it now.
            if let Err(e) = restore_saved_proxy_state(&app.handle().clone()) {
                eprintln!("proxy state recovery failed: {e}");
            }

            let show_item = MenuItem::with_id(app, "show", "Show Pomedoro", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Pomedoro")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(win) = app.get_webview_window("main") {
                            let visible = win.is_visible().unwrap_or(false);
                            if visible {
                                let _ = win.hide();
                            } else {
                                let _ = win.show();
                                let _ = win.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        // Closing the window (via our custom UI) tucks the app into the tray
        // instead of quitting, so the timer keeps counting down in the
        // background. Actual exit happens only via the tray "Quit" item.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
