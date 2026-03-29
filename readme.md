# Offline Podcast & Transcription App

## 1. Project Overview
A React Native mobile application that allows users to subscribe to RSS podcast feeds, download audio files for offline listening, and generate synchronised text transcripts entirely on-device without relying on cloud APIs.

## 2. Core Features
* **Feed Management:** Parse and subscribe to standard podcast RSS feeds.
* **Local Storage:** Download and manage `.mp3` or `.m4a` audio files directly on the device file system.
* **On-Device Transcription:** Utilise a local machine learning model to generate transcripts from downloaded audio files.
* **Subscribed Timeline:** A feed displaying all newly released episodes from subscribed podcasts, ordered chronologically.
* **Downloaded Timeline:** A separate library view showing only episodes that are downloaded and available for offline playback and transcription.
* **Synchronised Playback:** An audio player with an interactive, scrolling transcript that highlights words in real-time, mirroring the Apple Podcasts experience.

## 3. Recommended Technology Stack
* **Framework:** React Native (Bare Workflow - required for native C++ linking)
* **Local Database:** WatermelonDB or SQLite
* **File Storage:** `react-native-fs`
* **Audio Playback:** `react-native-track-player`
* **Transcription:** `whisper.rn` (Whisper.cpp)

## 4. Application Architecture & Data Flow

### The Download & Transcription Pipeline
1. **Fetch & Parse:** The app polls the RSS feed and updates the database with new episode metadata.
2. **Download:** The user selects an episode. The app streams the audio file to the device's local storage.
3. **Model Verification:** Before transcribing, the app checks if the necessary Whisper ML model (e.g., `ggml-tiny.bin`) is present on the device.
4. **Transcription Execution:** Once downloaded, the user taps 'Transcribe'. The app passes the local audio file path to `whisper.rn`.
5. **Data Output:** The Whisper model outputs an array of text segments paired with start and end timestamps.
6. **Storage:** This timestamped JSON or VTT data is saved to the local database linked to the episode ID.

### The UI/UX Views
* **The Subscribed Timeline:** Pulls directly from the database's `Episodes` table, filtering for the latest release dates across all active subscriptions.
* **The Downloaded Timeline:** Filters the `Episodes` table where the `is_downloaded` flag is true, allowing offline users to immediately see accessible content.
* **The Player & Transcript View:** Uses `react-native-track-player` to get the current playback position in milliseconds. A FlatList or ScrollView listens to this timecode and automatically scrolls to the matching transcript segment, highlighting the active text block.

## 5. Technical Challenges & Considerations
* **App Size & Model Storage:** Offline transcription requires shipping or downloading a machine learning model. The 'Tiny' Whisper model is roughly 75MB. You will need to build a UI to prompt the user to download this model upon first use.
* **Battery & Thermal Throttling:** Running audio processing locally is heavily demanding on the CPU/GPU. You must warn users that transcription will consume significant battery life and may warm up the device.
* **Format Conversion:** Whisper.cpp typically requires a specific audio format (like 16kHz WAV). You may need to use `react-native-ffmpeg` to invisibly convert downloaded mp3s into a compatible format before passing them to the transcription engine.