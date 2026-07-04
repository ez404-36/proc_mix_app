//! Sound-notification playback.
//!
//! Plays a short audio cue (a bundled built-in tone or a user-uploaded custom
//! sound) when a command or workflow run finishes. The app never synthesises
//! audio — it only decodes and plays files: the built-in `.wav` tones are
//! generated offline by `examples/gen_sounds.rs` and bundled as resources, and
//! custom sounds are copied into the app data directory on upload.
//!
//! Playback is **best-effort**: no audio device, a decode failure, or any other
//! error is logged with `tracing::warn!` and swallowed. A failed cue must never
//! fail — or even perturb — the run that triggered it.
//!
//! Threading: `rodio`'s `OutputStream` is `!Send` and blocking, so it must be
//! created, used, and dropped on the same OS thread — never held across an
//! `.await` and never stored in (Send) Tauri state. Every playback therefore
//! runs a short-lived stream inside a `tokio::task::spawn_blocking` closure via
//! {@link play_file}. Creating a fresh stream per cue is cheap relative to the
//! human-perceptible latency of a notification and avoids all `!Send` hazards.

use std::path::PathBuf;

pub mod resolve;
pub mod trigger;

/// Play the audio file at `path` at `volume` (0.0–1.0) without blocking the
/// caller. Spawns the blocking playback on a dedicated thread and returns
/// immediately; the cue plays to completion in the background.
///
/// Best-effort: a missing file, missing audio device, or decode error is
/// logged at `warn` and otherwise ignored. Never returns an error to the
/// caller — a notification sound must not be able to affect a run.
///
/// Desktop only; a no-op stub on mobile (see the `imp` module below).
pub fn play_file(path: PathBuf, volume: f32) {
    imp::play_file(path, volume);
}

/// Desktop implementation: real `rodio` playback.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod imp {
    use std::io::BufReader;
    use std::path::{Path, PathBuf};

    use rodio::{Decoder, OutputStream, Sink, Source};

    /// Clamp a caller-supplied volume into rodio's sane range. Values outside
    /// `0.0..=1.0` (e.g. a corrupt settings row) are coerced rather than trusted.
    fn clamp_volume(volume: f32) -> f32 {
        if !volume.is_finite() {
            return 1.0;
        }
        volume.clamp(0.0, 1.0)
    }

    /// Play the audio file at `path` at `volume`, blocking until it finishes.
    /// Factored out so it is unit-testable without spawning a task. Returns
    /// `Err` with a human-readable reason on any failure (device/decode/io).
    fn play_blocking(path: &Path, volume: f32) -> Result<(), String> {
        let file = std::fs::File::open(path)
            .map_err(|e| format!("open sound file {}: {e}", path.display()))?;
        let source = Decoder::new(BufReader::new(file))
            .map_err(|e| format!("decode sound file {}: {e}", path.display()))?;

        // A fresh default output stream for this single cue. `_stream` MUST stay
        // alive until the sound finishes — dropping it stops playback — so it is
        // held for the whole function and dropped at the end, on this thread.
        let (_stream, handle) =
            OutputStream::try_default().map_err(|e| format!("open audio output stream: {e}"))?;
        let sink = Sink::try_new(&handle).map_err(|e| format!("create audio sink: {e}"))?;
        sink.set_volume(clamp_volume(volume));
        // `convert_samples` normalises the decoded sample type across the
        // different (wav/mp3/ogg/flac) decoders.
        sink.append(source.convert_samples::<f32>());
        sink.sleep_until_end();
        Ok(())
    }

    pub fn play_file(path: PathBuf, volume: f32) {
        tokio::task::spawn_blocking(move || {
            if let Err(reason) = play_blocking(&path, volume) {
                tracing::warn!(target: "procmix::sound", "sound playback skipped: {reason}");
            }
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn clamp_volume_bounds_and_nan() {
            assert_eq!(clamp_volume(0.5), 0.5);
            assert_eq!(clamp_volume(-1.0), 0.0);
            assert_eq!(clamp_volume(2.0), 1.0);
            assert_eq!(clamp_volume(0.0), 0.0);
            assert_eq!(clamp_volume(1.0), 1.0);
            // NaN / non-finite coerces to full volume rather than propagating.
            assert_eq!(clamp_volume(f32::NAN), 1.0);
            assert_eq!(clamp_volume(f32::INFINITY), 1.0);
        }

        #[test]
        fn play_blocking_missing_file_is_error_not_panic() {
            let res = play_blocking(Path::new("/no/such/sound/file.wav"), 1.0);
            assert!(res.is_err());
            assert!(res.unwrap_err().contains("open sound file"));
        }

        #[test]
        fn play_blocking_undecodable_file_is_error_not_panic() {
            // This source file is real bytes but not valid audio → decode error.
            let res = play_blocking(Path::new(file!()), 0.5);
            assert!(res.is_err());
        }
    }
}

/// Mobile stub: no audio backend, so playback is a no-op.
#[cfg(any(target_os = "android", target_os = "ios"))]
mod imp {
    use std::path::PathBuf;
    pub fn play_file(_path: PathBuf, _volume: f32) {}
}
