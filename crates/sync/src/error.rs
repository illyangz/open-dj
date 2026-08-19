#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    /// Convex's own `{status: "error", errorMessage}` envelope — a
    /// successful HTTP response that failed at the function level (e.g.
    /// `requireIdentity` throwing "unknown identity").
    #[error("sync backend error: {0}")]
    Remote(String),
}

pub type Result<T> = std::result::Result<T, SyncError>;
