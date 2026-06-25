//! Pure helpers for normalising and evaluating cron expressions. Kept
//! free of any I/O so they can be unit-tested without a database or a
//! real clock (callers pass `now` explicitly).

use std::str::FromStr;

use chrono::{DateTime, Local};
use cron::Schedule;

/// Normalise a user-typed cron expression into the 7-field form the
/// `cron` crate expects (`sec min hour dom month dow year`).
///
/// Accepts:
///   - 5 fields (classic Unix `min hour dom month dow`) → prepend `0`
///     seconds and append `*` year.
///   - 6 fields (`sec min hour dom month dow`) → append `*` year.
///   - 7 fields → used as-is.
///
/// Returns the normalised 7-field string. Errors with a human-readable
/// message when the field count is unsupported. This does NOT validate
/// the field syntax — call [`next_after`] (or `Schedule::from_str` on the
/// result) for that.
pub fn normalize_five_to_seven(expr: &str) -> Result<String, String> {
    let mut fields: Vec<String> = expr.split_whitespace().map(str::to_owned).collect();
    // The day-of-week field index differs by field count:
    //   5 fields: min hour dom month [dow]            -> index 4
    //   6 fields: sec min hour dom month [dow]        -> index 5
    //   7 fields: sec min hour dom month [dow] year   -> index 5
    let dow_index = match fields.len() {
        5 => 4,
        6 | 7 => 5,
        n => {
            return Err(format!(
                "cron expression must have 5, 6, or 7 fields (got {n})"
            ));
        }
    };
    // The `cron` crate (Quartz-style) numbers weekdays 1-7 = Sun-Sat,
    // whereas the user types classic Unix numbering 0-6 = Sun-Sat (with 7
    // also meaning Sunday). Shift the numeric tokens of the dow field at
    // this boundary so a UI-built `... 6` (Saturday) means Saturday, not
    // Friday. Without this every weekday schedule fires one day early.
    if let Some(dow) = fields.get(dow_index) {
        fields[dow_index] = shift_weekday_field(dow);
    }
    match fields.len() {
        5 => Ok(format!("0 {} *", fields.join(" "))),
        6 => Ok(format!("{} *", fields.join(" "))),
        7 => Ok(fields.join(" ")),
        // Unreachable: field count already validated above.
        _ => unreachable!("field count validated above"),
    }
}

/// Map every numeric token in a day-of-week field from Unix numbering
/// (0-6 = Sun-Sat, 7 = Sun) to the `cron` crate's Quartz numbering
/// (1-7 = Sun-Sat). Non-numeric tokens (`*`, `?`, `SUN`..`SAT`, and the
/// `/`, `-`, `,` separators) pass through unchanged. Numeric step
/// divisors (the part after `/`) are NOT day values and are left as-is.
fn shift_weekday_field(field: &str) -> String {
    // Split on commas (lists), preserving each element; within an element
    // handle ranges (`a-b`) and steps (`base/step`). Only the day-value
    // positions (single value, range endpoints, step base) are shifted.
    field
        .split(',')
        .map(shift_weekday_element)
        .collect::<Vec<_>>()
        .join(",")
}

fn shift_weekday_element(element: &str) -> String {
    // Step syntax: `<base>/<divisor>`. Only the base is a day value.
    if let Some((base, step)) = element.split_once('/') {
        return format!("{}/{}", shift_weekday_range(base), step);
    }
    shift_weekday_range(element)
}

fn shift_weekday_range(range: &str) -> String {
    // Range syntax: `<from>-<to>`. Shift both endpoints when numeric.
    if let Some((from, to)) = range.split_once('-') {
        return format!("{}-{}", shift_weekday_value(from), shift_weekday_value(to));
    }
    shift_weekday_value(range)
}

fn shift_weekday_value(value: &str) -> String {
    match value.parse::<u8>() {
        // 7 is Sunday in Unix; Quartz Sunday is 1.
        Ok(7) => "1".to_owned(),
        // 0-6 (Sun-Sat) -> 1-7 (Sun-Sat).
        Ok(n) if n <= 6 => (n + 1).to_string(),
        // Out-of-range numbers or non-numeric tokens (`*`, `?`, names)
        // pass through; the crate validates them downstream.
        _ => value.to_owned(),
    }
}

/// Parse `expr` (any supported field count) and return the next fire time
/// strictly after `after`, in local time. Returns `Ok(None)` when the
/// schedule has no future occurrence (e.g. a one-off year in the past).
/// Returns `Err` when the expression is syntactically invalid.
pub fn next_after(expr: &str, after: &DateTime<Local>) -> Result<Option<DateTime<Local>>, String> {
    let normalized = normalize_five_to_seven(expr)?;
    let schedule =
        Schedule::from_str(&normalized).map_err(|e| format!("invalid cron expression: {e}"))?;
    Ok(schedule.after(after).next())
}

/// Validate that `expr` parses as a cron expression. Returns the
/// normalised 7-field form on success so callers can store / re-use it.
pub fn validate(expr: &str) -> Result<String, String> {
    let normalized = normalize_five_to_seven(expr)?;
    Schedule::from_str(&normalized).map_err(|e| format!("invalid cron expression: {e}"))?;
    Ok(normalized)
}

/// Count occurrences of `expr` strictly after `after` and at or before
/// `now` — i.e. fire times that were MISSED while the app was closed.
/// Capped at `cap` to avoid a thundering herd when a schedule was missed
/// for a very long time. Returns 0 for an invalid expression (the loop
/// will surface the error elsewhere) or when `after >= now`.
pub fn missed_occurrences(
    expr: &str,
    after: &DateTime<Local>,
    now: &DateTime<Local>,
    cap: usize,
) -> usize {
    if after >= now {
        return 0;
    }
    let normalized = match normalize_five_to_seven(expr) {
        Ok(n) => n,
        Err(_) => return 0,
    };
    let schedule = match Schedule::from_str(&normalized) {
        Ok(s) => s,
        Err(_) => return 0,
    };
    let mut count = 0usize;
    for occ in schedule.after(after) {
        if &occ > now {
            break;
        }
        count += 1;
        if count >= cap {
            break;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn five_field_gets_seconds_and_year() {
        assert_eq!(
            normalize_five_to_seven("0 2 * * *").unwrap(),
            "0 0 2 * * * *"
        );
    }

    #[test]
    fn six_field_gets_year_only() {
        assert_eq!(
            normalize_five_to_seven("30 0 2 * * *").unwrap(),
            "30 0 2 * * * *"
        );
    }

    #[test]
    fn seven_field_passes_through() {
        assert_eq!(
            normalize_five_to_seven("0 0 2 * * * *").unwrap(),
            "0 0 2 * * * *"
        );
    }

    #[test]
    fn extra_whitespace_is_collapsed() {
        assert_eq!(
            normalize_five_to_seven("  0   2 *  * *  ").unwrap(),
            "0 0 2 * * * *"
        );
    }

    #[test]
    fn wrong_field_count_errors() {
        assert!(normalize_five_to_seven("* * *").is_err());
        assert!(normalize_five_to_seven("* * * * * * * *").is_err());
        assert!(normalize_five_to_seven("").is_err());
    }

    #[test]
    fn invalid_syntax_errors_in_next_after() {
        let now = Local.with_ymd_and_hms(2026, 6, 3, 10, 0, 0).unwrap();
        // 99 is out of range for the minute field.
        assert!(next_after("99 * * * *", &now).is_err());
    }

    #[test]
    fn five_and_seven_field_are_equivalent() {
        let now = Local.with_ymd_and_hms(2026, 6, 3, 10, 0, 0).unwrap();
        let from_five = next_after("0 2 * * *", &now).unwrap();
        let from_seven = next_after("0 0 2 * * * *", &now).unwrap();
        assert_eq!(from_five, from_seven);
    }

    #[test]
    fn daily_at_two_am_next_is_tomorrow() {
        // 10:00 on the 3rd → next "0 2 * * *" is 02:00 on the 4th.
        let now = Local.with_ymd_and_hms(2026, 6, 3, 10, 0, 0).unwrap();
        let next = next_after("0 2 * * *", &now).unwrap().unwrap();
        assert_eq!(next, Local.with_ymd_and_hms(2026, 6, 4, 2, 0, 0).unwrap());
    }

    #[test]
    fn unix_weekday_is_shifted_to_quartz() {
        // Unix dow 6 = Saturday. The `cron` crate uses 1-7 = Sun-Sat, so
        // the field is shifted 6 -> 7. `* * * * 6` (Saturday) must keep
        // `dom`/`month`/year wildcards and become `... 7`.
        assert_eq!(
            normalize_five_to_seven("0 9 * * 6").unwrap(),
            "0 0 9 * * 7 *"
        );
        // Unix 0 = Sunday -> Quartz 1.
        assert_eq!(
            normalize_five_to_seven("0 9 * * 0").unwrap(),
            "0 0 9 * * 1 *"
        );
        // Unix 7 also = Sunday -> Quartz 1.
        assert_eq!(
            normalize_five_to_seven("0 9 * * 7").unwrap(),
            "0 0 9 * * 1 *"
        );
        // Weekday list 1,3,5 (Mon,Wed,Fri) -> 2,4,6.
        assert_eq!(
            normalize_five_to_seven("0 9 * * 1,3,5").unwrap(),
            "0 0 9 * * 2,4,6 *"
        );
        // Range 1-5 (Mon-Fri) -> 2-6.
        assert_eq!(
            normalize_five_to_seven("0 9 * * 1-5").unwrap(),
            "0 0 9 * * 2-6 *"
        );
        // Wildcard dow is untouched.
        assert_eq!(
            normalize_five_to_seven("0 2 * * *").unwrap(),
            "0 0 2 * * * *"
        );
    }

    #[test]
    fn missed_occurrences_counts_window_and_caps() {
        // Hourly schedule. Anchor 10:00, now 15:30 on the same day → the
        // 11,12,13,14,15:00 fires were missed = 5.
        let anchor = Local.with_ymd_and_hms(2026, 6, 3, 10, 0, 0).unwrap();
        let now = Local.with_ymd_and_hms(2026, 6, 3, 15, 30, 0).unwrap();
        assert_eq!(missed_occurrences("0 * * * *", &anchor, &now, 50), 5);
        // Cap is honoured.
        assert_eq!(missed_occurrences("0 * * * *", &anchor, &now, 3), 3);
        // anchor >= now → nothing missed.
        assert_eq!(missed_occurrences("0 * * * *", &now, &anchor, 50), 0);
    }

    #[test]
    fn saturday_nine_am_resolves_to_saturday() {
        // 2026-06-03 is a Wednesday; the next Saturday is the 6th. With the
        // weekday shift, `0 9 * * 6` (Unix Saturday) must fire on the 6th,
        // NOT the 5th (Friday) as the unshifted crate numbering would.
        let now = Local.with_ymd_and_hms(2026, 6, 3, 10, 0, 0).unwrap();
        let next = next_after("0 9 * * 6", &now).unwrap().unwrap();
        assert_eq!(next, Local.with_ymd_and_hms(2026, 6, 6, 9, 0, 0).unwrap());
    }

    #[test]
    fn every_minute_preset_parses() {
        let now = Local.with_ymd_and_hms(2026, 6, 3, 10, 0, 30).unwrap();
        let next = next_after("* * * * *", &now).unwrap().unwrap();
        assert_eq!(next, Local.with_ymd_and_hms(2026, 6, 3, 10, 1, 0).unwrap());
    }

    #[test]
    fn validate_returns_normalized() {
        assert_eq!(validate("*/5 * * * *").unwrap(), "0 */5 * * * * *");
        assert!(validate("nonsense").is_err());
    }
}
