# Podink

A React Native podcast app with on-device AI transcription, word-by-word transcript highlighting, and offline playback.

## Features

### Core Podcast
- Subscribe via RSS URL or Apple Podcasts link
- Browse episodes from all subscribed feeds
- Stream episodes or download for offline listening
- Resume playback from where you left off (position saved every 5s)
- Listening tab — every episode by state: New · In progress · Finished; swipe right to mark Done (or Unplayed on a finished row), swipe left to delete a download
- Refreshing feeds shows a thin loading line under the Feed title and never blocks the tabs
- When a downloaded episode plays to the end, a prompt offers to delete the download (audio + transcript) to free up space — switchable off in Settings → Storage
- Finished episodes that go a week without a replay have their download and transcript removed automatically (the episode stays, marked as played; re-download it from Listening → Finished) — switchable off in Settings → Storage
- Settings live behind a gear in the header, not a tab
- Background audio with lock screen / notification controls

### Playback
- Full-screen player with artwork, episode info, and transcript
- Mini player floating above tab bar — quick controls without leaving the current screen
- Skip ±10 seconds, seek slider, time display
- Player header tinted from the podcast artwork — softened (capped saturation, theme-banded lightness) so loud covers stay calm

### On-Device Transcription (sherpa-onnx)
- Fully offline — no audio ever leaves the device
- Model options: NVIDIA Parakeet 110M (default — most accurate, punctuation, CC BY 4.0), Whisper Tiny (attention export, smaller), SenseVoice Small (multilingual, experimental)
- FIFO queue — transcribe multiple episodes sequentially
- Real-time progress per episode

### Transcript Features
- Word-by-word highlight synchronized to playback position
- Auto-scroll keeps active text centered (pauses on manual scroll)
- Tap any sentence to jump playback to that timestamp
- 10-minute navigation markers
- Translation modal (long-press a sentence → English + Spanish via Google Translate)

---

## Tech Stack

| Category | Library | Version |
|---|---|---|
| Framework | React Native | 0.83.4 |
| Build system | Expo | ~55.0.9 |
| Navigation | React Navigation (bottom-tabs + native-stack) | 6.x |
| Audio playback | react-native-track-player | 4.1.2 |
| Transcription | @siteed/sherpa-onnx.rn | 1.1.2 |
| Animations | react-native-reanimated | 4.2.1 |
| Database | expo-sqlite | ~55.0.11 |
| File system | expo-file-system | ~55.0.12 |
| Preferences | @react-native-async-storage | 2.2.0 |
| Network info | @react-native-community/netinfo | ^11.3.0 |
| RSS parsing | react-native-rss-parser | ^1.5.1 |
| Image colors | react-native-image-colors | ^2.6.0 |

---

## Project Structure

```
src/
├── api/
│   ├── rssParser.js              # RSS feed parsing & episode normalization
│   └── podcastResolver.js        # Resolves Apple Podcasts URLs → RSS feed URLs
├── components/
│   ├── EpisodeItem.js            # Episode list row with download/transcribe actions
│   ├── FinishedEpisodePrompt.js  # "Delete the download?" alert when a downloaded episode ends
│   ├── SettingsGearButton.js     # Header gear that opens Settings
│   ├── SegmentedControl.js       # Filter switch used by the Listening tab
│   ├── LoadingBar.js             # Thin indeterminate line under a header while feeds load
│   ├── MiniPlayer.js             # Floating compact player above tab bar
│   ├── PlayerControls.js         # Full-screen playback controls (slider, skip, play/pause)
│   └── TranscriptHighlighter.js  # Word-synced transcript with auto-scroll & translation
├── database/
│   ├── db.js                     # SQLite schema initialization
│   └── queries.js                # All DB read/write operations
├── screens/
│   ├── SubscribedTimeline.js     # "Discover" tab — browse & add podcast feeds
│   ├── DownloadedTimeline.js     # "Library" tab — manage downloads & transcription queue
│   ├── ListeningScreen.js        # "Listening" tab — episodes by state (New / In progress / Finished)
│   ├── PodcastsScreen.js         # "My Podcasts" tab — subscriptions list
│   ├── PlayerScreen.js           # Full-screen player modal
│   └── SettingsScreen.js         # Settings (stack screen behind the header gear)
└── services/
    ├── trackPlayer.js            # react-native-track-player wrapper
    ├── playbackService.js        # Background playback event handler
    ├── episodeService.js         # Episode actions shared by every tab: download ⇒ transcribe, remove download, Done / Unplayed, weekly cleanup of finished downloads
    ├── whisperService.js         # Transcription queue & model management
    ├── downloadService.js        # Audio & model downloads with progress
    └── colorExtractor.js         # Dominant color extraction from artwork
```

---

## Database Schema

**Episodes**
| Column | Type | Notes |
|---|---|---|
| id | TEXT | Primary key |
| title | TEXT | |
| description | TEXT | |
| podcast_title | TEXT | |
| podcast_feed_url | TEXT | |
| release_date | TEXT | |
| audio_url | TEXT | Remote URL |
| local_audio_path | TEXT | Set when downloaded |
| is_downloaded | INTEGER | 0 or 1 |
| has_transcript | INTEGER | 0 or 1 |
| play_position | INTEGER | Seconds |
| is_played | INTEGER | 0 or 1 — set when playback reaches the end |
| last_played_at | INTEGER | Epoch ms of the last saved position or manual Done (orders the Listening tab; start of a finished download's cleanup week) |
| downloaded_at | INTEGER | Epoch ms the audio landed on the device; NULL when not downloaded (a re-download gets a fresh cleanup week) |

**Podcasts**
| Column | Type | Notes |
|---|---|---|
| id | INTEGER | Auto-increment |
| title | TEXT | |
| description | TEXT | |
| feed_url | TEXT | Unique |
| image_url | TEXT | |
| subscribed_at | TIMESTAMP | |

**Transcripts**
| Column | Type | Notes |
|---|---|---|
| id | INTEGER | Auto-increment |
| episode_id | TEXT | FK → Episodes.id |
| start_time | INTEGER | Milliseconds |
| end_time | INTEGER | Milliseconds |
| text | TEXT | Segment text |

---

## Building

### Prerequisites
- Node.js 18+
- Android Studio with NDK `27.1.12297006`
- Java 17+

### Install dependencies
```bash
npm install
```

### Run in development
```bash
npm run android
```

### Build release APK
```bash
cd android && ./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`

---

## Versions

| Version | versionCode | Notes |
|---|---|---|
| 1.0.0 | 1 | Initial release |
| 1.1.0 | 2 | Current |

---

## Notes

- **Transcription models** — two NVIDIA Parakeet models (110M default / fast, TDT 0.6B v2 high accuracy) are downloaded on-demand from Settings as tar.bz2 release assets from the sherpa-onnx model zoo and extracted natively.
- **MiniPlayer** is only mounted after the first play event to avoid Android elevation/visibility bugs.
- **Transcript auto-scroll** detects manual user scrolling and pauses; it resumes after a short idle timeout.
- **Spotify links** are not supported — Spotify does not expose RSS feeds.
- The release signing config currently uses the debug keystore. For production distribution, replace with a proper release keystore.
