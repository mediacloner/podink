# Changelog

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
