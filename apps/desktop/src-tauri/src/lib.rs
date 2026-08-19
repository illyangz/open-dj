mod commands;
mod community_commands;
mod jobs;
mod state;
mod stem_commands;
mod sync_commands;

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
            stem_commands::register_progress_bridge(handle.clone());
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
            commands::set_cue_point,
            commands::delete_cue_point,
            commands::list_cue_points,
            commands::create_crate,
            commands::rename_crate,
            commands::delete_crate,
            commands::list_crates,
            commands::add_track_to_crate,
            commands::remove_track_from_crate,
            commands::list_crate_tracks,
            commands::reorder_crate_tracks,
            commands::scan_file,
            commands::generate_waveform,
            commands::generate_band_waveform,
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
            commands::write_binary_file,
            commands::get_settings,
            commands::update_settings,
            commands::check_system_tools,
            commands::fetch_soundcloud_likes,
            commands::download_soundcloud_track,
            commands::export_diagnostics,
            sync_commands::ensure_device_identity,
            sync_commands::import_device_identity,
            sync_commands::push_track_sync_state,
            sync_commands::pull_track_sync_state,
            sync_commands::push_preferences,
            sync_commands::pull_preferences,
            stem_commands::separate_track_stems,
            community_commands::share_crate,
            community_commands::share_song,
            community_commands::share_post,
            community_commands::list_community_feed,
            community_commands::toggle_community_upvote,
            community_commands::list_my_upvotes,
            community_commands::list_community_mentions,
            community_commands::add_community_comment,
            community_commands::list_community_comments,
            community_commands::search_community_usernames,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
