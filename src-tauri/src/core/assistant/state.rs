//! Cancellation state for active assistant provider requests.

use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct AssistantState {
    current_request: Mutex<Option<CancellationToken>>,
}

impl AssistantState {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new request and cancel any prior one. An editor can have at
    /// most one active generation.
    pub async fn begin_request(&self) -> CancellationToken {
        let token = CancellationToken::new();
        let mut current = self.current_request.lock().await;
        if let Some(previous) = current.take() {
            previous.cancel();
        }
        *current = Some(token.clone());
        token
    }

    /// Cancel the active request, if any. Cancelling twice is harmless.
    pub async fn cancel_current(&self) {
        if let Some(token) = self.current_request.lock().await.take() {
            token.cancel();
        }
    }

    /// Forget the completed request. At most one request is active.
    pub async fn finish_request(&self) {
        self.current_request.lock().await.take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn new_request_cancels_previous_and_completed_request_is_cleared() {
        let state = AssistantState::new();
        let first = state.begin_request().await;
        let second = state.begin_request().await;
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());

        state.finish_request().await;
        state.finish_request().await;
        let third = state.begin_request().await;
        assert!(!second.is_cancelled());
        assert!(!third.is_cancelled());
    }
}
