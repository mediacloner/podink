# Changelog

## [1.0.4] - 2026-04-02

### Fixed
- **Transcription queue robustness** — complete rewrite of the processing loop:
  - Second and subsequent transcriptions no longer fail: native Whisper context is explicitly released and recreated between jobs.
  - App no longer crashes on re-entry while transcribing: `TranscriptionService` now uses `START_NOT_STICKY` with a null-intent guard, preventing two native Whisper instances from competing for the same resources.
  - After a transcription error the queue no longer gets permanently stuck: broken context is torn down before every retry.
  - Retry logic: each transcription is attempted up to 3 times (with context re-init between retries) before the queue advances.
- **App kill / force-stop recovery** — closing the app abruptly mid-transcription is now safe:
  - `onTaskRemoved` added to `TranscriptionService`: notification disappears when user swipes app from recents, process exits cleanly.
  - Interrupted items remain in AsyncStorage and are automatically re-queued on next launch.
- **Foreground service ANR fix** — next queue item is deferred to a new event-loop turn via `setTimeout`, preventing the Android 8+ ANR from rapid stop/start of the foreground service.
- **Episode list refreshes after restored-queue items complete** — transcript badge now appears without the user navigating away and back.
- **Partial transcript on cancel discarded** — whisper.rn resolves with partial segments when `stop()` is called; these are now detected via `_abortCurrent` flag and discarded so cancelled transcriptions never write incomplete data to SQLite.

### Added
- **Cancel queued/active transcriptions** — the "Queued" badge is now a tappable button (clock + ×) that removes the episode from the queue. The transcribing indicator is now a tappable red "Cancel" button that immediately aborts the running transcription.
- **Transcription timeout watchdog** — 45-minute watchdog that fires `stop()` if a native Whisper transcription hangs and never settles.
- **Reset transcription queue** — new "Troubleshooting" section in Settings with a "Reset transcription queue" button that aborts everything, clears AsyncStorage, releases the native context, and stops the foreground service.

## [1.0.3] - 2026-04-02

### Changed
- Version bump to 1.0.3

## [1.0.2] - 2026-04-02

### Changed
- Version bump to 1.0.2

## [1.0.1] - 2026-04-02

### Added
- Subscription badges on podcast covers showing unplayed episode count
- Episode grouping by podcast in timelines
- Pull-to-refresh on subscribed and downloaded timelines
- Push notifications for new episodes from subscribed podcasts
- Notification service (`notificationService.js`) to schedule and manage alerts
- `yarn build:apk` script for generating Android release APK

### Changed
- Replaced notification popup with a red dot indicator on the My Podcasts tab
- Android adaptive icon now uses `icon.png` as foreground for correct circle fill

### Fixed
- Android launcher icon appearing as a small square inside the circle

## [1.0.0] - Initial release

- Offline podcast player with audio playback and mini player
- Spotify and Apple Podcasts import
- Whisper-based transcription with translation support
- SQLite local database for episode and podcast storage
