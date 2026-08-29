# Changelog

## [2.5.0] - 2026-08-29

### Added
- **Offline dictionaries in the word card.** Tapping a word now shows the entry from one of the twelve MDict dictionaries of the penReader set (Oxford EN–ES / ES–EN, New Oxford American, Oxford Advanced 8th, Collins COBUILD Advanced / Intermediate, Collins EN–ES, Merriam-Webster Advanced, MW EN–ES, VOX EN–ES, Roget's, Gran Diccionari) — the same files the scanning pen carries, read straight from the `.mdx` (`services/mdx.js`: header, key blocks and record blocks are inflated on demand; a small per-block index built once at install makes lookups a few milliseconds even in the 1.9 M-key New Oxford American). Entries are rendered natively, not in a WebView: the publisher's HTML is flattened to themed paragraphs (`services/dictionaryHtml.js`, `components/transcript/DictionaryEntry.js`) so every dictionary reads correctly on both the dark and the paper palette — bold, italic examples, small grammar labels, senses indented as in the source, Collins' grammar boxes as tinted cards, colours mapped to the accent. Cross-references (`entry://`) are tappable.
- **Dictionary selector** in the word card's footer, where *Save to vocabulary* used to be (saving moved to a bookmark icon beside Copy / Share). The picker shows which installed dictionaries have the word, remembers the choice (`@dictionary_selected`), and links to Settings.
- **Lookup works like the pen** (penReader scan-bridge): exact key first (case, accents and punctuation ignored, but "look up" is never the noun "look-up"), then inflections — `@@@LINK=` redirect records resolved one by one before any HTML is assembled, with the base spelling shown in a trail ("gave → give"); irregular forms and plurals stemmed for the dictionaries without redirects (Oxford Advanced). A key's real records win over its redirects; a stub such as "ran: past tense of run" offers the base as a *See also* chip.
- **Phrasal verbs, like the pen.** The words around the tap are checked for a phrasal verb ("gave up", "gave it up", "look forward to", or tapping "up" after "gave"). If the dictionary indexes it as a headword (MW EN–ES, Collins) that entry is shown with the trail “gave up” → give up and a *Show ‘gave’ on its own* link; otherwise the base verb's entry opens **scrolled to the phrasal verb's own heading** — the bold run that is the phrase and nothing else, stress marks and object placeholders ignored (`▸ give up`, `• to give up`, `ˌgive ˈup`, `▪ give up`, `give (something) up`) — highlighted, with a chip to jump back to it. "give up on" and "look up to" are other verbs and never count.
- **Settings → Dictionaries.** The dictionaries live in the private GitHub repository `mediacloner/penReader` (`dictionaries/`); a personal access token with read access to its contents, stored only on this device (`@github_token`), lists them and downloads each one (progress, then “Indexing…”), with *Download all* and per-dictionary delete. Nothing is bundled in the APK.
- A third translation endpoint (`/translate_a/t`) for sentence translation, tried when both `/single` client keys are throttled — the "can't access translation" cases were often Google rate-limiting rather than the gesture.

### Changed
- The word card no longer waits for Google: the offline entry shows on its own and a translation failure stays inside the translation block. Online English definitions (dictionaryapi.dev) are only fetched while no dictionary is installed.
- In the word-by-word region of the transcript the sentence wrapper is now a long-press target too, so a long-press that lands between words, at a line end or below the last line opens the translation instead of doing nothing (word taps and long-presses on words are unchanged).
- Word card height raised to 88 % of the screen for long entries; entries beyond ~120 paragraphs render a first slice with a *Show the whole entry* button (the slice always reaches the phrasal-verb heading).

## [2.3.0] - 2026-08-28

### Added
- **Listening tab** — a fourth tab showing the listening pipeline, one segment per stage: *Downloaded* (on the device, not started — newest first), *In progress* (started, most recently heard first) and *Finished* (most recently finished first); episodes that are neither downloaded nor started stay in the Feed. The chosen segment is remembered (`@listening_filter`). Rows resume with a tap; swipe right for **Done** (or **Unplayed** on a finished row); swipe left for **Delete** on downloaded rows — or **Download** on the others (see below). The list stays live while it is on screen (every ~5 s position save).
- **Finished-episode prompt** — when a *downloaded* episode plays to its real end, asks whether to delete the download and transcript to free space (Keep / Delete). Asked on the next launch if the episode ended while the app was gone. Off switch: Settings → **Storage** → "Ask to delete finished episodes" (`@ask_delete_on_finish`).
- **Finished downloads clean themselves up after a week.** A finished episode (played to the end, or swiped *Done*) that goes seven days without a replay has its download and transcript removed automatically; the episode stays in the feed and in Listening → Finished, and can be re-downloaded from there. A replay restarts the clock (it takes the episode back to In progress until it ends again), and so does a re-download — a Finished episode fetched again for a read-along keeps its file for a fresh week however long ago it was heard. The sweep runs after launch and on each return to the foreground (at most hourly), skips the episode loaded in the player, and only ever removes on-device data (`episodeService.sweepStaleFinishedDownloads`). Off switch: Settings → **Storage** → "Delete finished episodes after a week" (`@auto_delete_finished`). "Keep" on the finished-episode prompt keeps the download for now, not forever.
- **Feed loading line** — feed refreshes show as a thin animated line under the Feed title instead of holding the pull-to-refresh spinner open, so the list never jumps and the tabs stay usable.
- **Download & transcribe in the Player** — a streamed episode's "No transcript yet" card now has a *Download & transcribe* button; the card walks through Downloading → Queued → Transcribing → text without leaving the screen.
- Schema **v5**: `Episodes.last_played_at` (epoch ms), stamped on every position save — orders the In progress / Finished segments.
- Schema **v6**: `Episodes.downloaded_at` (epoch ms), stamped by every download and cleared with the file. Existing downloads are stamped with the upgrade moment, so the automatic cleanup gives them a full week rather than sweeping them on the first launch.

### Changed
- **A download now produces a transcript on its own.** Every download — Feed, My Podcasts, the Player card, a Listening swipe — queues the on-device transcription as soon as the file lands; there is no separate "Transcribe" tap any more. The row goes Download → Downloaded → Queued / 42 % → Transcript, and the Feed shows that progress too (it previously only showed "Downloaded"). The *Transcribe* pill remains only as a retry on a downloaded row whose job failed or was cancelled. All of this lives in `services/episodeService.js` (`downloadEpisode`, `transcribeEpisode`), which also documents the listening-state / on-device-state model.
- **Replaying a finished episode makes it In progress again**, and the Feed's Play pill reads *Resume* / *Play again* accordingly. Completion still resets the position to 0 so a replay starts from the top.
- **Swiping *Done* now stamps `last_played_at`**, so a manually finished episode sorts to the top of Listening → Finished ("most recently finished first", as documented) and its cleanup week counts from the swipe rather than from the last time it was heard.
- **Done / Unplayed on the episode that is playing now stop it first.** They used to change the row, and the very next progress save (~5 s) wrote a position back and silently returned it to In progress.
- **Settings moved behind a gear** in every tab header (it is no longer a tab).
- **Player header tint is softened** — the cover's hue is kept but its saturation is capped and its lightness pinned to a band per theme, so a loud cover no longer fills the top of the screen with raw yellow or magenta.
- **Settings alignment** — section labels, row icons and card text share one left edge; hints indent under their title.
- Mini player shadow reduced (it read as floating too high).
- Section titles in the tab headers (and Settings) are ~10 % larger (19 pt); the Settings gear — and the Feed's "+" — sit 3 px lower, level with the title.
- Player header text is a notch larger (podcast label 12 pt, episode title 16 pt, artwork 56 px).
- Tab bar labels (Feed · My Podcasts · Library · Listening) are larger (12 pt) and each icon + label pair is centred in the bar; the v6 default bottom-aligned the pair, leaving a gap above the icon.
- The transcript's first paragraph starts lower (72 px instead of 28) and the top fade is shorter (84 px instead of 110), so the opening line no longer sits under the header's shadow and scrim.

### Fixed
- **Tabs froze while feeds were loading.** Podcast feeds ship their whole back catalogue — The Daily's RSS is ~20 MB and 2,960 items — and the XML parser builds the full document synchronously on the JS thread, so every tap on the tab bar waited for the parse. The feed text is now cut after the first 50 `<item>`s (all that is ever stored) before parsing: 20 MB → 330 KB, same title, image and episodes.
- **Paper theme: the Player header text had a dark smudge under it.** The drop-shadow was meant only for dark header tints, but the Android override that removed it on light tints (`textShadowColor: 'transparent'`) still drew the default dark shadow. The shadow style is now added only on dark tints.
- Listening rows show what is on the device: a swipe-to-download's progress, then the download mark and — once the automatic transcription finishes — a transcript mark.
- **My Podcasts is ordered by each show's newest episode** (was: by subscription date), so a podcast that just published rises to the top.
- **Unfolding a podcast low in My Podcasts (or a folder in the Library) scrolls it to the top**, so its episodes appear on screen instead of opening below the fold.
- **Downloading an episode from the Feed now takes it off the My Podcasts "new" badge** — the count dropped only when you opened and closed the podcast's folder, so a podcast you had already acted on kept its red number.
- **Some podcasts had no cover** (Dwarkesh Podcast, The Waterstones Podcast). Their feeds declare the artwork only as `<itunes:image href>` and ship no RSS `<image>` block, which was the only element read. Both are read now, and a refresh updates a subscription's stored cover when the feed's differs (covers subscribed without one fill in on the next refresh). The 50-item feed cut also keeps channel-level elements that some hosts place *after* the items — the Dwarkesh feed's cover is one.

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
