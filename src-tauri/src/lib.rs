use tauri::{
  menu::{MenuBuilder, MenuItemBuilder},
  tray::TrayIconBuilder,
  AppHandle, Manager, WindowEvent,
};

#[tauri::command]
fn show_floating(app: AppHandle) -> Result<(), String> {
  let window = app
    .get_webview_window("floating")
    .ok_or_else(|| "floating window is not available".to_string())?;
  window.show().map_err(|error| error.to_string())?;
  window.set_focus().map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![show_floating])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let open_main = MenuItemBuilder::with_id("open-main", "打开挂起记录").build(app)?;
      let open_floating = MenuItemBuilder::with_id("open-floating", "打开悬浮窗").build(app)?;
      let quit = MenuItemBuilder::with_id("quit", "退出程序").build(app)?;
      let menu = MenuBuilder::new(app)
        .items(&[&open_main, &open_floating, &quit])
        .build()?;

      let icon = app
        .default_window_icon()
        .cloned()
        .ok_or_else(|| "application icon is missing".to_string())?;

      TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("挂起记录")
        .on_menu_event(|app, event| match event.id.as_ref() {
          "open-main" => {
            if let Some(window) = app.get_webview_window("main") {
              let _ = window.show();
              let _ = window.set_focus();
            }
          }
          "open-floating" => {
            let _ = show_floating(app.clone());
          }
          "quit" => app.exit(0),
          _ => {}
        })
        .build(app)?;

      Ok(())
    })
    .on_window_event(|window, event| {
      if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        let _ = window.hide();
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
