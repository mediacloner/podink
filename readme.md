# Podink

A React Native podcast app with on-device AI transcription, word-by-word transcript highlighting, and offline playback.

## Features

### Core Podcast
- Subscribe via RSS URL or Apple Podcasts link
- Browse episodes from all subscribed feeds
- Stream episodes or download for offline listening
- Resume playback from where you left off (position saved every 5s)
- Background audio with lock screen / notification controls

### Playback
- Full-screen player with artwork, episode info, and transcript
- Mini player floating above tab bar — quick controls without leaving the current screen
- Skip ±10 seconds, seek slider, time display
- Dynamic header color extracted from podcast artwork

### On-Device Transcription (Whisper)
- Fully offline — no audio ever leaves the device
- 5 model options: Tiny, Base, Base Q8, Small, Small Q8
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
| Transcription | whisper.rn | 0.5.5 |
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
│   ├── MiniPlayer.js             # Floating compact player above tab bar
│   ├── PlayerControls.js         # Full-screen playback controls (slider, skip, play/pause)
│   └── TranscriptHighlighter.js  # Word-synced transcript with auto-scroll & translation
├── database/
│   ├── db.js                     # SQLite schema initialization
│   └── queries.js                # All DB read/write operations
├── screens/
│   ├── SubscribedTimeline.js     # "Discover" tab — browse & add podcast feeds
│   ├── DownloadedTimeline.js     # "Library" tab — manage downloads & transcription queue
│   ├── PodcastsScreen.js         # "My Podcasts" tab — subscriptions list
│   ├── PlayerScreen.js           # Full-screen player modal
│   └── SettingsScreen.js         # Whisper model management
└── services/
    ├── trackPlayer.js            # react-native-track-player wrapper
    ├── playbackService.js        # Background playback event handler
    ├── whisperService.js         # Whisper transcription queue & model management
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

- **Whisper models** are downloaded on-demand from Settings. Android avoids quantized (Q8) models by default due to compatibility issues.
- **MiniPlayer** is only mounted after the first play event to avoid Android elevation/visibility bugs.
- **Transcript auto-scroll** detects manual user scrolling and pauses; it resumes after a short idle timeout.
- **Spotify links** are not supported — Spotify does not expose RSS feeds.
- The release signing config currently uses the debug keystore. For production distribution, replace with a proper release keystore.
