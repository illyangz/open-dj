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
}

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

        Self {
            store,
            providers: RwLock::new(Arc::new(ProviderRegistry::new())),
            download_root: RwLock::new(download_root),
            backup_root: RwLock::new(backup_root),
            network_semaphore: Arc::new(Semaphore::new(concurrency_network.max(1))),
            analysis_semaphore: Arc::new(Semaphore::new(analysis_concurrency)),
        }
    }
}
