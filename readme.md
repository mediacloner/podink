# Podink

A podcast and audiobook player for learning English by listening. Every episode gets an on-device transcript that follows the audio word by word; any sentence can be translated, any word looked up in offline dictionaries, and an optional OpenAI assistant writes summaries, chapters and cards for the people, books, films and idioms an episode mentions.

Android · React Native 0.83 · Expo 55 · current version **5.8.0** (versionCode 33). See [CHANGELOG.md](CHANGELOG.md) for the full history.

---

## Features

### Podcasts
- **Subscribe** by RSS URL, Apple Podcasts link or search (Spotify has no RSS feed, so its links can't be used).
- **Feed** tab: new episodes from every subscription. Refreshing shows a thin loading line under the title and never blocks the tabs. New episodes have a red dot and a **Check** pill that clears it; the header's double check clears them all.
- **My Podcasts** tab: subscriptions with unseen-episode badges, with podcasts that have new episodes listed first. A podcast unfolds to its latest five episodes, and **More episodes** opens its whole back catalogue, newest first, loaded a hundred items at a time.
- **Show notes** are shown as formatted text (paragraphs, lists, links) rather than raw feed HTML. An unfolded row shows the episode's full title.
- **Episode rows** show the length, a "23 min left" tag and progress bar for started episodes, and a *Played* check for finished ones.
- **Swipe actions on every list:** remove the transcript, delete the download, mark Done / Unplayed.
- **Stream or download.** A download queues its transcription as soon as the file arrives. Downloads that come back as an error page, aren't audio, or are under 16 KB are refused.
- Notifications for new episodes, plus a red dot on the tab.

### Library and Listening
- **Library** tab: downloads grouped into one folder per podcast, each with a count badge. Episodes you've finished leave the Library.
- **Listening** tab: *Downloaded* (not started yet), *In progress* (most recently heard first) and *Finished*.
- **Storage housekeeping:** when a downloaded episode ends, the app offers to delete its audio and transcript. Finished downloads that go a week without a replay are removed automatically; the episode itself stays. Both can be switched off in Settings → Storage.

### Playback
- A full-screen Player with the transcript, and a mini player above the tab bar.
- Skip ±10 s, a seek slider, and the saved speed. Playback resumes where you left off, and background audio works with lock-screen and notification controls.
- The Player header is tinted from the artwork, toned down so bright covers don't overwhelm the screen.
- Seeking is frame-accurate: a vendored KotlinAudio with index seeking for local files keeps the transcript in step after a seek.
- **Skip ad:** the assistant finds sponsor reads, inserted commercials and trailers for other shows. A *Skip ad* button appears while one plays, and ads are marked in the transcript.

### On-device transcription
- Transcription runs fully offline with sherpa-onnx and NVIDIA Parakeet: **Parakeet 110M** (default, fast, 99 MB) or **Parakeet TDT 0.6B v2** (more accurate, 460 MB download / ~630 MB installed). Both add punctuation and capitals.
- Episodes are transcribed one at a time in a queue in a foreground service, with progress per episode. Jobs can be cancelled, and a watchdog stops hung jobs. The model is unloaded from memory when nothing is transcribing.
- Free space is checked before a model download.
- **Enriching…:** after the transcript, the episode shows *Enriching…* while punctuation repair, the summary, names, books and tags finish.

### Reading along
- Each word is highlighted as it's spoken, and the view auto-scrolls (pausing while you scroll by hand).
- Long sentences are split into paragraphs of up to about 50 words when the transcript is displayed, so no re-transcription is needed.
- Transcript gestures:
  - **Tap** a sentence to seek to it.
  - **Double-tap**, or **slide left**, to seek and play.
  - **Slide right** to translate.
- Dividers in the text are the episode's chapters when it has them, or a marker every 10 minutes when it doesn't.
- **Share the transcript** as timestamped text (`[12:34] …`).
- **Themes:** *Dark* or *Paper* (cream stock, ink text, fountain-pen accent), set in Settings → Appearance.

### Translation and dictionaries
- **Translation card:** translates a sentence into your language with Google Translate, sending the two paragraphs before it as context. The card names the engine that produced the translation. Pull the card up to show the preceding lines and their translations. When a long sentence was cut into paragraphs, Google receives the whole sentence.
- **Word card:** every word in the translation card can be tapped to open the word card on top of it.
- **Offline MDict dictionaries:** 19 dictionaries from the penReader set, including Oxford EN–ES/ES–EN, Oxford Advanced, New Oxford American, Collins COBUILD, Longman, MW Collegiate, Vocabulary.com, Oxford Idioms and Oxford Word Origins. They download from a private GitHub repo using a personal access token (Settings → Dictionaries).
- **Pen-style lookup:** exact match first, then inflections and redirects. A selector picks which installed dictionary to read, and entries use a themed native renderer.
- **Phrasal verbs** are detected around the tapped word ("gave it up", "look forward to") and underlined in the text whenever the dictionary defines them.
- **Wikipedia summaries** for names and places that no dictionary carries.
- **Idiom card:** what the idiom means, why the words mean that, and what the speaker means by it here. The whole card can be translated.
- **Pause while looking up** (optional): playback pauses while a card is open.
- Copy or share any text. **Ask Luna** answers a question about a sentence in the card, and passes it to **Sol** when Luna isn't sure. Without an OpenAI key, the question goes to the share sheet for another app.
- **Vocabulary** saves words. **Notebook** saves sentences with your notes (use the pencil in the translation card). Both are under Settings → Learning.

### Episode assistant (OpenAI, with your own key)
- **Summary and chapters:** a summary of three or four sentences, plus titled chapters you can jump to.
- **Transcript corrections:** fixes for misheard names, titles and homophones. A correction is kept only if its original text is found verbatim in the transcript.
- **Punctuation repair** runs first, restoring full stops and capitals where the recogniser ran sentences together.
- **What this episode names:** a tag in the Player header lists the episode's podcasts, books, idioms, phrasal verbs, films, TV programmes, records, organisations, guests, the presenter, people and places. They're bold in the text (a **B** switch turns the bold off), and each one opens a card with its picture, facts and links. Details come from Goodreads/Open Library, TMDB, iTunes and Wikipedia:
  - Podcast cards show the show's description and a *Subscribe* button.
  - Film and TV cards have a *Trailer* button.
  - Acronyms such as *CNN*, *MIT* and *BBC* are marked when the transcript writes them in capitals.
  - Tap a picture to see it uncropped.
- **Auto-tag:** a switch that tags every episode as soon as its transcript is done. *Look again* reruns the tagging.
- **Models:** GPT-6 **Luna** (cheap) and **Sol** (flagship). All passes share one cached transcript prefix, so the hour is paid for once rather than once per pass.

### Names and books without the cloud
- **Names pass:** spells people's names the way the episode's title and notes do, using phonetic matching. Corrections are applied when the transcript is read; the stored text is not changed.
- **Books in the transcript:** book titles are found by their shape and cue phrases ("your new book, …"), plus the author's other works, and checked against Open Library and Goodreads. Titles appear in bold and open a book card.

### Cloud transcription (optional)
- Sends an episode to **MAI-Transcribe-2** through OpenRouter when the phone's transcript isn't good enough, such as a noisy recording or unfamiliar names.
- Compare the two transcripts with their chapters and summaries written the same way, then choose **Use this text** to make the cloud version the episode's transcript.

### Live Radio
- **19 English-language talk stations:**
  - BBC Radio 4, 4 Extra, World Service, Scotland, Ulster, 5 Live, Wales and London
  - Vaughan Radio, RTÉ Radio 1, LBC, CBC Radio One
  - NPR, WNYC, KQED
  - ABC Radio National, ABC NewsRadio, ABC Radio Sydney, RNZ National
- Each station shows its logo, its local clock ("23:32 in Sydney · already Tuesday") and the programme on air from its guide, with *Coming up* under it. Stations are sorted by how close their time zone is to yours.
- Tap to play the stream at once. **Transcription** switches to a recorded buffer with a live transcript, and the stream keeps playing while it switches.
- A session paused for 30 minutes stops by itself. The stop button is a red disc.

### Imports
- **Local audio and audiobooks** can be imported from files or a folder as collections. The app reads tags, duration and the embedded cover, plus `.nfo` sidecars. A single `.m4b` is split into its chapters without re-encoding.
- **Audiobook + EPUB:** the book's own text is shown instead of a transcript, timed to the narrator's pauses. **Match the text to the voice** aligns it to recognised speech. A chapter whose text can't match its audio says so.
- **YouTube:** paste or share a link (videos, Shorts, live replays) to import it as an episode with a transcript. Uses NewPipe Extractor.
- **Share target:** Podink appears in Android's share sheet for links.

### Statistics
- A **listening meter** counts time actually listened: a skip adds nothing and a replay counts again, and radio is counted per station. Days before measurement began are estimated and labelled as estimates.
- An **API spend ledger** records every OpenAI and OpenRouter call, priced at the model's own rate, including models that have since been retired.

### Settings
Sections: Appearance · Learning · Dictionaries · Episode assistant · Storage · Transcription model · Cloud transcription test · Films and television (TMDB key) · Troubleshooting (reset the transcription queue) · Debug log.

---

## Tech stack

| Area | Library |
|---|---|
| Framework | React Native 0.83.4, Expo ~55 |
| Navigation | React Navigation 6 (bottom tabs + native stack) |
| Audio | react-native-track-player 4.1.2 with vendored KotlinAudio (`android/kotlinaudio`) |
| Speech recognition | @siteed/sherpa-onnx.rn 1.1.2 (patched, see `patches/`) |
| Database | expo-sqlite (schema v17) |
| Gestures / animation | react-native-gesture-handler, reanimated 4 |
| Storage / files | AsyncStorage, expo-file-system |
| Native modules (Kotlin) | `AudioImportModule`, `LiveRadioModule`, `YouTubeModule`, `ShareIntentModule`, `TranscriptionService` |

## Project layout

```
src/
├── api/          RSS, Apple/iTunes search, OpenAI, Open Library, Goodreads, TMDB, Wikipedia
├── components/   lists, mini player, controls, swipe rows
│   └── transcript/  transcript cards: translation, word, book, entity, idiom, chapters, cloud transcript
├── database/     db.js (schema + migrations), queries.js
├── hooks/        transcription queue, screen-awake, book sync, clock
├── screens/      Feed, My Podcasts, Library, Live Radio, Listening, Player, Settings,
│                 Vocabulary, Notebook, Stats, Collections, YouTube import, Debug log
└── services/     playback, downloads, transcription (whisperService), AI passes, names/books/entities,
                  dictionaries (mdx.js), radio, imports, EPUB alignment, statistics
android/app/src/main/java/…   native Kotlin modules
assets/brand, scripts/        icon sources + generate-icons.sh
```

## Building

Prerequisites: Node 18+, Yarn, Android Studio with NDK `27.1.12297006`, Java 17+.

```bash
yarn install          # also applies patch-package patches
yarn android          # dev build + Metro
yarn build:apk        # release APK → android/app/build/outputs/apk/release/app-release.apk
```

Use Yarn, not npm (the project has a `yarn.lock`).

### Optional keys (entered in Settings, stored only on the device)
- **OpenAI**: episode assistant, tags, Ask Luna/Sol
- **OpenRouter**: cloud transcription
- **GitHub PAT** with read access to the dictionary repo: offline dictionaries
- **TMDB**: film and TV cards and trailers

## Notes
- Releases are cut as `release/X.Y.Z` branches from `main`, with the version bumped in `build.gradle`, `app.json`, `package.json` and the changelog.
- Release signing still uses the debug keystore. Replace it before public distribution.
