use opendj_core::Store;
use opendj_providers::ProviderRegistry;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{RwLock, Semaphore};

pub struct AppState {
    pub store: Store,
    pub providers: RwLock<Arc<ProviderRegistry>>,
    pub download_root: RwLock<PathBuf>,
    pub backup_root: RwLock<PathBuf>,
    pub network_semaphore: Arc<Semaphore>,
    /// Throttles BPM/key analysis and ffmpeg waveform rendering — both are
    /// CPU/GPU-bound local work, unlike `network_semaphore`'s I/O-bound
    /// downloads. Without a cap, opening Library/Sort with many untagged
    /// tracks fired analysis + waveform rendering for every visible track
    /// simultaneously, pegging all cores at once (a real source of fan
    /// noise and battery drain). Scaled to half the machine's cores rather
    /// than a fixed small number: a flat cap of 2 cut peak load nicely but
    /// tanked throughput on many-core machines, turning a big untagged
    /// library into a slow queue. Half leaves the other half free for the
    /// UI/audio thread and other apps while still using most of the
    /// machine's headroom to get through the backlog.
    pub analysis_semaphore: Arc<Semaphore>,
    /// Hard-capped at 1: a full htdemucs inference pass is far heavier than
    /// anything `analysis_semaphore` throttles (seconds to a couple minutes
    /// on CPU, real memory pressure) — running two concurrently would be
    /// brutal on a laptop, so stem separation is strictly serialized rather
    /// than sharing the analysis pool's looser cap.
    pub stem_semaphore: Arc<Semaphore>,
    pub sync_client: opendj_sync::SyncClient,
}

/// Points at a local `npx convex dev` deployment by default so `cargo tauri
/// dev` works without any build-time configuration. CI bakes the real
/// deployment URL in via `CONVEX_URL` at compile time (see
/// `.github/workflows/release.yml`) — no `.env` file, matching how the rest
/// of this repo has no dotenv usage anywhere.
const DEV_CONVEX_URL: &str = "http://127.0.0.1:3210";

impl AppState {
    pub fn new(
        store: Store,
        download_root: PathBuf,
        backup_root: PathBuf,
        concurrency_network: usize,
    ) -> Self {
        let cores = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4);
        let analysis_concurrency = (cores / 2).max(2);
        let convex_url = option_env!("CONVEX_URL").unwrap_or(DEV_CONVEX_URL);

        Self {
            store,
            providers: RwLock::new(Arc::new(ProviderRegistry::new())),
            download_root: RwLock::new(download_root),
            backup_root: RwLock::new(backup_root),
            network_semaphore: Arc::new(Semaphore::new(concurrency_network.max(1))),
            analysis_semaphore: Arc::new(Semaphore::new(analysis_concurrency)),
            stem_semaphore: Arc::new(Semaphore::new(1)),
            sync_client: opendj_sync::SyncClient::new(convex_url),
        }
    }
}
