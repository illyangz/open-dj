mod commands;
mod jobs;
mod state;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle();
            let data_dir = handle.path().app_data_dir().expect("resolve app data dir");
            std::fs::create_dir_all(&data_dir).expect("create app data dir");

            let db_path = data_dir.join("opendj.sqlite3");
            let conn = opendj_core::db::open(&db_path).expect("open queue database");
            let store = opendj_core::Store::new(conn);

            let settings = store.get_settings().expect("load settings");
            let download_root = if settings.download_root.is_empty() {
                // Default to ~/Music/OpenDJ rather than the hidden app-data
                // folder — downloads need to be somewhere the user can find
                // in Finder and drag straight into a DJ library or crate.
                handle
                    .path()
                    .audio_dir()
                    .map(|dir| dir.join("OpenDJ"))
                    .unwrap_or_else(|_| data_dir.join("Downloads"))
            } else {
                std::path::PathBuf::from(&settings.download_root)
            };
            let backup_root = data_dir.join("Backups");
            std::fs::create_dir_all(&download_root).ok();

            // Waveform images and audio playback are served through the
            // asset:// protocol, which is scope-gated — grant it the
            // current download folder plus the legacy hidden app-data
            // Downloads folder (older jobs, downloaded before the default
            // moved to ~/Music/OpenDJ, still point there).
            let scope = handle.asset_protocol_scope();
            let _ = scope.allow_directory(&download_root, true);
            let _ = scope.allow_directory(data_dir.join("Downloads"), true);

            let app_state = AppState::new(
                store,
                download_root,
                backup_root,
                settings.concurrency_network.max(1) as usize,
            );
            if !settings.youtube_cookies_browser.is_empty() {
                app_state
                    .providers
                    .blocking_read()
                    .set_cookies_browser(Some(settings.youtube_cookies_browser.clone()));
            }
            if !settings.youtube_cookies_file.is_empty() {
                app_state
                    .providers
                    .blocking_read()
                    .set_cookies_file(Some(settings.youtube_cookies_file.clone()));
            }
            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ingest_inputs,
            commands::list_jobs,
            commands::pause_job,
            commands::resume_job,
            commands::cancel_job,
            commands::retry_job,
            commands::delete_job,
            commands::scan_file,
            commands::generate_waveform,
            commands::analyze_track,
            commands::preview_replacement,
            commands::apply_replacement,
            commands::list_mutation_journal,
            commands::restore_mutation,
            commands::list_providers,
            commands::search_providers,
            commands::build_organization_plan,
            commands::find_duplicate_tracks,
            commands::scan_library_folder,
            commands::write_text_file,
            commands::get_settings,
            commands::update_settings,
            commands::check_system_tools,
            commands::fetch_soundcloud_likes,
            commands::download_soundcloud_track,
            commands::export_diagnostics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
