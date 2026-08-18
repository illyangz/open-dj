#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("job {0} not found")]
    JobNotFound(uuid::Uuid),
    #[error("input {0} not found")]
    InputNotFound(uuid::Uuid),
    #[error("invalid state transition: {0} cannot {1}")]
    InvalidTransition(String, &'static str),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, CoreError>;
