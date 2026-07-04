//! One-time generator for ProcMix's built-in notification-sound assets.
//!
//! The app never synthesises audio at runtime — it plays static `.wav` files
//! (built-ins bundled as resources, plus user uploads) through `rodio`. This
//! example renders the built-in tones ONCE and writes them to `sounds/*.wav`,
//! which are then COMMITTED to the repository and shipped via
//! `tauri.conf.json`'s `bundle.resources`.
//!
//! Run (from `app/src-tauri`):
//!
//! ```sh
//! cargo run --example gen_sounds
//! ```
//!
//! Re-run after editing a `Tone` recipe below to regenerate the assets, then
//! commit the changed `.wav` files. The tones are intentionally short, quiet,
//! and click-free (a linear attack/decay envelope forces the first/last
//! samples to zero) so they are pleasant as completion cues.
//!
//! Dev-only: depends solely on `hound` (a pure PCM WAV writer with no
//! ALSA/system-audio requirement), so it builds and runs on any machine even
//! where the `rodio` playback path cannot compile.

use std::f32::consts::TAU;
use std::path::PathBuf;

/// Output sample rate. 44.1 kHz is universally decodable by `rodio` and keeps
/// the assets tiny for sub-second tones.
const SAMPLE_RATE: u32 = 44_100;

/// Peak amplitude of a rendered tone as a fraction of full scale. Kept well
/// below 1.0 so the built-ins are a gentle cue rather than a jarring blast;
/// the user's configured volume scales this further at playback time.
const PEAK_AMPLITUDE: f32 = 0.35;

/// Fraction of each segment spent fading in and out. A short linear ramp at
/// both ends drives the boundary samples to zero, eliminating the click a
/// hard-edged sine start/stop would otherwise produce.
const FADE_FRACTION: f32 = 0.15;

/// A single constant-frequency portion of a tone.
struct Segment {
    /// Sine frequency in Hz.
    freq: f32,
    /// Duration of this segment in milliseconds.
    ms: u32,
}

/// A built-in tone recipe: an ordered list of segments plus the output file
/// stem (written as `<stem>.wav`). Editing these is the ONLY thing needed to
/// retune the built-in sounds.
struct Tone {
    stem: &'static str,
    segments: &'static [Segment],
}

/// The built-in tone catalogue. Every tone is exactly THREE notes.
/// `success`/`error` are the two default cues; `chime`/`buzz` are extra options
/// the user can pick per command/workflow.
///
/// - `success`: a bright rising major arpeggio resolving on a held high note
///   (C6 -> E6 -> G6), a "done" fanfare.
/// - `error`:   a falling three-step buzz in the mid register (G4 -> D#4 ->
///   C4) — brighter than a sub-bass so it reads clearly on small speakers.
/// - `chime`:   a soft three-note arpeggio in a different register (E5 -> A5 ->
///   C6), distinct from `success`.
/// - `buzz`:    three short repeated mid-register pulses (E4), a terse "nope".
const TONES: &[Tone] = &[
    Tone {
        stem: "success",
        segments: &[
            Segment {
                freq: 1046.50,
                ms: 130,
            }, // C6
            Segment {
                freq: 1318.51,
                ms: 130,
            }, // E6
            Segment {
                freq: 1567.98,
                ms: 280,
            }, // G6 (held resolution)
        ],
    },
    Tone {
        stem: "error",
        segments: &[
            Segment {
                freq: 392.00,
                ms: 120,
            }, // G4
            Segment {
                freq: 311.13,
                ms: 120,
            }, // D#4
            Segment {
                freq: 261.63,
                ms: 240,
            }, // C4 (held resolution)
        ],
    },
    Tone {
        stem: "chime",
        segments: &[
            Segment {
                freq: 659.25,
                ms: 90,
            }, // E5
            Segment {
                freq: 880.00,
                ms: 90,
            }, // A5
            Segment {
                freq: 1046.50,
                ms: 160,
            }, // C6
        ],
    },
    Tone {
        stem: "buzz",
        segments: &[
            Segment {
                freq: 330.00,
                ms: 160,
            }, // E4
            Segment {
                freq: 330.00,
                ms: 160,
            }, // E4
            Segment {
                freq: 330.00,
                ms: 220,
            }, // E4 (held)
        ],
    },
];

/// Render one segment into `out`, appending its 16-bit PCM samples with a
/// per-segment attack/decay envelope so each note is individually click-free.
fn render_segment(seg: &Segment, out: &mut Vec<i16>) {
    let total = (SAMPLE_RATE as u64 * seg.ms as u64 / 1000) as usize;
    if total == 0 {
        return;
    }
    let fade = ((total as f32) * FADE_FRACTION).max(1.0) as usize;
    for n in 0..total {
        let t = n as f32 / SAMPLE_RATE as f32;
        let sine = (TAU * seg.freq * t).sin();
        // Linear fade-in over the first `fade` samples and fade-out over the
        // last `fade` samples; flat in between. `min` handles a short segment
        // where the two ramps would overlap.
        let env_in = (n as f32 / fade as f32).min(1.0);
        let env_out = ((total - n) as f32 / fade as f32).min(1.0);
        let env = env_in.min(env_out);
        let sample = sine * env * PEAK_AMPLITUDE;
        out.push((sample * i16::MAX as f32) as i16);
    }
}

/// Render a full tone (all segments concatenated) to a mono 16-bit WAV file.
fn write_tone(tone: &Tone, dir: &std::path::Path) -> Result<PathBuf, hound::Error> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut samples: Vec<i16> = Vec::new();
    for seg in tone.segments {
        render_segment(seg, &mut samples);
    }
    let path = dir.join(format!("{}.wav", tone.stem));
    let mut writer = hound::WavWriter::create(&path, spec)?;
    for s in samples {
        writer.write_sample(s)?;
    }
    writer.finalize()?;
    Ok(path)
}

fn main() {
    // Write next to the crate root: `app/src-tauri/sounds/`.
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sounds");
    std::fs::create_dir_all(&dir).expect("create sounds/ dir");

    for tone in TONES {
        match write_tone(tone, &dir) {
            Ok(path) => println!("wrote {}", path.display()),
            Err(e) => {
                eprintln!("failed to write {}: {e}", tone.stem);
                std::process::exit(1);
            }
        }
    }
    println!("done: {} built-in tones", TONES.len());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_sample_count_matches_duration() {
        let mut out = Vec::new();
        render_segment(
            &Segment {
                freq: 440.0,
                ms: 100,
            },
            &mut out,
        );
        // 100 ms at 44_100 Hz = 4410 samples.
        assert_eq!(out.len(), 4_410);
    }

    #[test]
    fn zero_duration_segment_renders_nothing() {
        let mut out = Vec::new();
        render_segment(&Segment { freq: 440.0, ms: 0 }, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn envelope_zeroes_first_and_last_sample() {
        // The fade envelope must drive the boundary samples to (near) zero so
        // playback has no click. First sample is exactly 0 (env_in = 0); the
        // last is the final pre-fade-out sample, which must be small.
        let mut out = Vec::new();
        render_segment(
            &Segment {
                freq: 440.0,
                ms: 100,
            },
            &mut out,
        );
        assert_eq!(out[0], 0, "first sample must be silent");
        let last = *out.last().unwrap();
        // Within one fade step of zero: env_out for the final sample is
        // 1/fade, so amplitude is a tiny fraction of full scale.
        assert!(
            last.abs() < (i16::MAX as f32 * PEAK_AMPLITUDE * 0.02) as i16,
            "last sample must be near-silent, got {last}"
        );
    }

    #[test]
    fn peak_never_exceeds_configured_amplitude() {
        let mut out = Vec::new();
        for tone in TONES {
            out.clear();
            for seg in tone.segments {
                render_segment(seg, &mut out);
            }
            let peak = out.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
            let ceiling = (i16::MAX as f32 * PEAK_AMPLITUDE) as u16 + 1;
            assert!(
                peak <= ceiling,
                "tone {} peak {peak} exceeds ceiling {ceiling}",
                tone.stem
            );
        }
    }

    #[test]
    fn every_builtin_tone_has_a_unique_stem() {
        let mut stems: Vec<&str> = TONES.iter().map(|t| t.stem).collect();
        stems.sort_unstable();
        let before = stems.len();
        stems.dedup();
        assert_eq!(before, stems.len(), "built-in tone stems must be unique");
    }
}
