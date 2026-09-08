package com.doublesymmetry.kotlinaudio.players.components

import android.net.Uri
import com.google.android.exoplayer2.C
import com.google.android.exoplayer2.audio.MpegAudioUtil
import com.google.android.exoplayer2.extractor.DefaultExtractorsFactory
import com.google.android.exoplayer2.extractor.Extractor
import com.google.android.exoplayer2.extractor.ExtractorInput
import com.google.android.exoplayer2.extractor.ExtractorOutput
import com.google.android.exoplayer2.extractor.ExtractorsFactory
import com.google.android.exoplayer2.extractor.PositionHolder
import com.google.android.exoplayer2.extractor.SeekMap
import com.google.android.exoplayer2.extractor.TrackOutput
import com.google.android.exoplayer2.extractor.mp3.Mp3Extractor
import java.io.IOException

/**
 * Podink addition: extractors for progressive sources read from local storage.
 *
 * ExoPlayer seeks an MP3 with whatever the file offers — the Xing/Info table of
 * contents (100 entries at 8-bit precision, so up to 1/512 of the file: a few
 * seconds on an hour-long episode) or, failing that, a constant-bitrate guess.
 * Either way it reports the *requested* time afterwards while the audio plays
 * from the byte the table pointed at, so a transcript stays offset by that error
 * until the next seek. Index seeking instead builds an exact byte↔time index as
 * frames are read; a seek past the indexed part scans frame headers forward
 * (I/O only, no decoding) — fine for a file on disk, unusable for a network
 * stream, which is why streams keep the upstream factory.
 *
 * Index seeking only learns the duration from a Xing/Info/VBRI frame or an ID3
 * TLEN. Without those it stays unknown until the whole file has been read and
 * KotlinAudio reports 0 — no seek bar, no completion. [DurationFallbackMp3Extractor]
 * fills that gap with the constant-bitrate estimate ExoPlayer used before; the
 * extractor replaces it with the exact value once it reaches the end of the file.
 */
class LocalFileExtractorsFactory : ExtractorsFactory {
    private val delegate = DefaultExtractorsFactory()
        .setConstantBitrateSeekingEnabled(true)
        .setMp3ExtractorFlags(Mp3Extractor.FLAG_ENABLE_INDEX_SEEKING)

    override fun createExtractors(): Array<Extractor> = wrapMp3(delegate.createExtractors())

    override fun createExtractors(uri: Uri, responseHeaders: Map<String, List<String>>): Array<Extractor> =
        wrapMp3(delegate.createExtractors(uri, responseHeaders))

    // Keep DefaultExtractorsFactory's sniffing order; only the MP3 extractor changes.
    private fun wrapMp3(extractors: Array<Extractor>): Array<Extractor> =
        Array(extractors.size) { i ->
            val extractor = extractors[i]
            if (extractor is Mp3Extractor) DurationFallbackMp3Extractor(extractor) else extractor
        }
}

/** An [Mp3Extractor] whose seek map always carries a duration (see [LocalFileExtractorsFactory]). */
private class DurationFallbackMp3Extractor(private val inner: Mp3Extractor) : Extractor {
    private var input: ExtractorInput? = null

    override fun sniff(input: ExtractorInput): Boolean = inner.sniff(input)

    override fun init(output: ExtractorOutput) {
        inner.init(object : ExtractorOutput {
            override fun track(id: Int, type: Int): TrackOutput = output.track(id, type)
            override fun endTracks() = output.endTracks()
            override fun seekMap(seekMap: SeekMap) = output.seekMap(withDuration(seekMap))
        })
    }

    override fun read(input: ExtractorInput, seekPosition: PositionHolder): Int {
        this.input = input
        return inner.read(input, seekPosition)
    }

    override fun seek(position: Long, timeUs: Long) = inner.seek(position, timeUs)

    override fun release() = inner.release()

    private fun withDuration(seekMap: SeekMap): SeekMap {
        if (seekMap.durationUs != C.TIME_UNSET) return seekMap
        val estimate = estimateDurationUs() ?: return seekMap
        return object : SeekMap {
            override fun isSeekable(): Boolean = seekMap.isSeekable
            override fun getDurationUs(): Long = estimate
            override fun getSeekPoints(timeUs: Long): SeekMap.SeekPoints = seekMap.getSeekPoints(timeUs)
        }
    }

    /**
     * Runs inside [inner].read(), right after Mp3Extractor has computed its seeker:
     * the input sits at the first audio frame (ID3 tag and any Xing/Info frame
     * already consumed), so its header gives the bitrate for the same estimate
     * ConstantBitrateSeeker makes. Mp3Extractor resets the peek position before
     * each read of its own, so peeking here disturbs nothing.
     */
    private fun estimateDurationUs(): Long? {
        val input = input ?: return null
        val length = input.length
        if (length == C.LENGTH_UNSET.toLong()) return null
        val bytes = ByteArray(4)
        try {
            input.resetPeekPosition()
            if (!input.peekFully(bytes, 0, 4, true)) return null
        } catch (e: IOException) {
            return null
        }
        val headerData = ((bytes[0].toInt() and 0xFF) shl 24) or
            ((bytes[1].toInt() and 0xFF) shl 16) or
            ((bytes[2].toInt() and 0xFF) shl 8) or
            (bytes[3].toInt() and 0xFF)
        val header = MpegAudioUtil.Header()
        if (!header.setForHeaderData(headerData) || header.bitrate <= 0) return null
        val dataBytes = (length - input.position).coerceAtLeast(0)
        return dataBytes * C.BITS_PER_BYTE * C.MICROS_PER_SECOND / header.bitrate
    }
}
