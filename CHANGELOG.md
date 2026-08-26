# Changelog

## [2.2.1] - 2026-08-26

### Added
- **Episode length in every list** — rows in My Podcasts, Feed and Library show the total time next to the date ("1h 23m", "45 min"). Feeds that ship no `<itunes:duration>` get the length stored the first time the episode plays, so it appears from then on.
- **Started episodes are marked** — an episode you have begun but not finished shows a blue "23 min left" tag (or "In progress" when the length is unknown) and a thin progress bar under the title. Finished episodes keep the green "Played" check.

### Changed
- **Translation and word cards open and close like a sheet** — the dim backdrop fades in place while the card slides up from the bottom (it used to slide up together with the card, reading like a scroll). Closing plays the reverse; the card keeps its content while it leaves.
- **Swipe down to close, from anywhere on the card** — the drag is now a native gesture (`react-native-gesture-handler`) running alongside the body scroll: with the body at the top, a downward drag moves the card and past ~120 px or a quick fling dismisses it; a long body still scrolls normally, and swiping up never fights the scroll. Replaces the JS `PanResponder` that Android's `ScrollView` beat to the gesture whenever the text overflowed. **Native change — APK rebuild required.**
- Card buttons (Close / Save / Replay) sit clear of the system navigation bar. The modal is edge-to-edge, so the previous margin equalled the bar height exactly and the buttons rested flush on it; the footer now adds 20 px above the inset.

## [2.2.0] - 2026-08-25

### Added
- **Paper theme** — a light theme built from the app icon's sticker: the page is the icon's cream stock (`#F3F0E9`), cards are lighter sheets laid on it, text is warm ink instead of pure black, the accent is fountain-pen blue-black, and the transcript reads like print — unread words are faded, read words are body ink, and the current word sits on a highlighter-yellow band instead of the dark theme's blue glow (a blurred glow on a light page looked like a smudge). Status colours are darkened to AA contrast on cream.
- **Settings › Appearance** — Dark / Paper selector with a miniature of each theme (page, card, text lines, accent dot). The choice is stored under `@theme` and applied instantly, including the navigation headers, tab bar and status-bar icons.

### Changed
- **Runtime theming** — `src/theme.js` now exports a `ThemeProvider`, `useTheme()` and `useStyles(makeStyles)` instead of a static `colors` object; every component builds its StyleSheet per theme (cached once per palette, so no per-instance cost). New tokens: `onAccent` (text on a solid accent/danger fill) and `backdrop` (sheet/alert dim layer).
- Player header text and the artwork-derived accent now pick the side that contrasts with the artwork tint on either theme (dark tints on the paper page get cream text; light tints drop the drop-shadow). Dark theme is visually unchanged.
- Debug log: the recording switch's off-track now uses the same surface as Settings so it stays visible on the light theme.

## [2.1.0] - 2026-08-25

### Changed
- **Two-tier Parakeet lineup** — the transcription model picker is now *Parakeet 110M* (default, fast) and *Parakeet TDT 0.6B v2* (high accuracy). Both are NVIDIA models (CC BY 4.0) from the sherpa-onnx model zoo, both punctuate and capitalize, both emit per-token timestamps for word-by-word highlighting, and neither can fall into Whisper-style repetition loops.
- **Whisper Tiny and SenseVoice Small retired.** Stored selections fall back to Parakeet 110M; their on-disk folders (`sherpa-whisper-tiny-attention-int8`, `sherpa-sensevoice-small-int8`) are removed by the startup cleanup. The Whisper-only hallucination scrubber (`dedupeHallucinations` / `dedupeWordLevel`) is gone with them — legitimate repeated words always survive now.
- Model rows show the **download size** (99 MB / 460 MB); the 0.6B row also states its ~630 MB installed footprint.

### Added
- **Parakeet TDT 0.6B v2 (int8)** — 6.05 % mean WER on the HF Open ASR leaderboard vs ~7.5 % for the 110M; roughly 5× the encoder compute on CPU. Distributed as a 460 MB tarball (`encoder`/`decoder`/`joiner` + `tokens.txt`), extracted natively like the 110M.
- **`nemo_transducer` support in the sherpa-onnx.rn patch** — the wrapper previously routed `nemo_transducer` through the single-file NeMo CTC config; it now builds a proper encoder/decoder/joiner `OfflineTransducerModelConfig` and both long-file gates (`shouldChunkOfflineWhisper`, `isOfflineWhisperModel`) include it, so 0.6B episodes take the same 29 s windowed path (full-attention FastConformer would otherwise OOM on a 90-minute file). **Native change — APK rebuild required.**
- **Free-space guard** before tarball downloads: install needs tarball + extracted tree simultaneously (~1.1 GB for the 0.6B); the download now fails early with the required/available MB instead of dying mid-extract.

## [2.0.5] - 2026-08-24

### Fixed
- **Swipe-down closes the translation and word cards from anywhere on the card** — the drag gesture sat on a `Pressable`, whose own responder handlers silently replaced it, so only a tap outside the card ever closed it. Both cards now share `SheetModal` (drag on a plain `Animated.View`, backdrop as a sibling, body scroll only when content overflows).
- **Word pronunciation actually plays** — the dictionary's recording host answers HTTP 502 for most words, so the speaker button either never appeared or did nothing. Pronunciation now uses on-device text-to-speech (`expo-speech`, en-US), works offline for every word, and falls back to the recording only if TTS errors.
- **Mini player no longer parks over the tab bar** — when it hid while still mounted (episode ended, stopped from the notification, transition back from the Player) it only slid 120 px, leaving its top ~40 px over the tabs. The hidden offset is now computed from its measured height.

### Added
- **Settings › Learning › "Pause while looking up"** (default on) — playback pauses while a word or sentence card is open and resumes when it closes; a podcast that was already paused stays paused.
- **Copy / share the English text** from both cards, plus **"Ask ChatGPT, Gemini…"** when translation fails (shares a ready-made translate-and-explain prompt in your Settings language via the system share sheet); a compact "Ask an assistant" link is available on success too.

## [2.0.2] - 2026-08-19

### Changed
- **Library grouped by podcast** — the Library tab now shows one folder per podcast (artwork, title, newest episode as subtitle), like the My Podcasts tab. Each folder carries a blue circular badge with its downloaded-episode count and expands in place to the podcast's episodes, newest first. Every row keeps the full set of actions inside the folder: open in Player, transcribe/queue/cancel, swipe to delete, swipe to remove transcript.
- Folders and expanded episodes render as a single flattened list, so large podcasts stay virtualized (no jank when opening a folder with many downloads).

### Fixed
- **Live transcription percent survives row remounts** — `whisperService` caches the last emitted percent per episode (`getLastProgress`), so collapsing and re-expanding a transcribing episode's folder no longer resets its pill to "Processing…" until the next ~29s window event.
- Stale expansion state: a folder whose last episode was deleted no longer reappears pre-expanded after a later download.

## [2.0.1] - 2026-08-19

### Added
- **New default transcription model: NVIDIA Parakeet TDT-CTC 110M** (int8, via sherpa-onnx `nemo_ctc`) — roughly 3x lower English word-error rate than Whisper Tiny at the same ~100 MB download, with native punctuation and capitalization. CTC frame timestamps drive the existing word-by-word highlighting (no attention export needed). Non-autoregressive decoding means the Whisper repetition loops on music/silence/ad reads structurally cannot happen. License: CC BY 4.0 (attribution shown in the Settings model picker).
- **Tarball model downloads** — `ensureSherpaModel` now supports models distributed as `.tar.bz2` release assets (the Parakeet int8 export has no per-file HF host): downloads the archive, extracts it with the sherpa-onnx native extractor, flattens the needed files into the model folder, and cleans up. Interruption-safe (rename-on-complete + re-extract without re-download).

### Changed
- **Whisper hallucination filter is now model-aware** — the repetition scrubber only runs for Whisper-type models; CTC engines (Parakeet, SenseVoice) cannot loop, so their transcripts pass through unfiltered and legitimate repeated words survive.
- **Wrapper patch extended** — `@siteed/sherpa-onnx.rn` patch now routes `nemo_ctc` through the windowed long-file path (`shouldChunkOfflineWhisper` + `isOfflineWhisperModel`); without this, a 90-minute episode would take the full-buffer path and OOM.
- Whisper Tiny remains available in Settings (smaller download); users who explicitly selected a model keep their choice.

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
