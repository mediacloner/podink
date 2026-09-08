# KotlinAudio (vendored)

Source of [doublesymmetry/KotlinAudio](https://github.com/doublesymmetry/KotlinAudio) at tag
`v2.1.0` (commit bf71120), the library react-native-track-player 4.1.2 drives ExoPlayer 2.19.0
through. RNTP declares it as a prebuilt AAR from JitPack; `android/build.gradle` substitutes this
module for that artifact so the change below can be made. Everything not listed here is upstream
code, unmodified.

## Podink changes

- `players/components/LocalFileExtractorsFactory.kt` (new): ExoPlayer index seeking for MP3s read
  from local storage, plus a constant-bitrate duration fallback for files without a Xing/Info/VBRI
  header. ExoPlayer's default seek trusts the Xing/Info table of contents, which is only precise to
  1/512 of the file (a few seconds on a long episode) and afterwards reports the *requested* time
  rather than where the audio actually landed, so the transcript highlight stayed offset until the
  next seek to zero. Index seeking is sample-exact.
- `players/BaseAudioPlayer.kt`, `createProgressiveSource`: uses that factory for local URIs;
  network streams keep the upstream `DefaultExtractorsFactory().setConstantBitrateSeekingEnabled(true)`
  (index seeking would download everything between the playhead and a far seek target).
- `build.gradle`: rewritten for this project's toolchain (AGP/Kotlin from React Native, no publishing
  or test plugins). Runtime dependencies match the published AAR.

## Updating

If RNTP moves to a newer KotlinAudio, re-vendor that tag here and re-apply the two changes above, or
drop this module once its ExoPlayer/media3 seeks MP3 files exactly on its own.
