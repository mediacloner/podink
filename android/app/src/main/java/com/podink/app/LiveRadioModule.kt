package com.podink.app

import android.net.Uri
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Live radio recorder (4.0.0). Pulls a station's stream — an Icecast / SHOUTcast
 * progressive stream (MP3 or ADTS AAC, ICY metadata stripped and reported) or an
 * HLS live playlist (MPEG-TS or packed-audio segments) — and rewrites it as a
 * local, growing HLS *event* playlist of packed-audio segments the player can
 * seek through: `<dir>/live.m3u8` + `seg_NNNNNN.aac|mp3`.
 *
 * Every frame is parsed (MP3 / ADTS headers), so each segment's EXTINF is the
 * exact sum of its frames' durations. The same sums are the offsets JS uses for
 * the transcript, and — packed audio has no embedded timestamps — the offsets
 * ExoPlayer assigns each segment, so audio position and transcript time agree.
 *
 * Every `windowSegments` segments are concatenated into `win_NNNNN.<ext>` (a
 * plain frame stream, decodable by MediaExtractor) and announced with its start
 * offset, for on-device transcription.
 *
 * Events (DeviceEventEmitter):
 *   LiveRadioSegment  { sessionId, index, startSec, durationSec, totalSec }
 *   LiveRadioWindow   { sessionId, index, path, startSec, durationSec }
 *   LiveRadioMetadata { sessionId, title }            ICY StreamTitle changes
 *   LiveRadioError    { sessionId, message, fatal }   non-fatal = reconnecting
 *   LiveRadioStopped  { sessionId, totalSec }
 */
class LiveRadioModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val EVENT_SEGMENT = "LiveRadioSegment"
        const val EVENT_WINDOW = "LiveRadioWindow"
        const val EVENT_METADATA = "LiveRadioMetadata"
        const val EVENT_ERROR = "LiveRadioError"
        const val EVENT_STOPPED = "LiveRadioStopped"
        // Segment lengths never exceed this; it is also ExoPlayer's playlist
        // reload period (halved while nothing changes) and, x3, its "playlist
        // stuck" limit. 12 s of source silence before the player complains.
        const val TARGET_DURATION_SEC = 12
    }

    private var recorder: Recorder? = null

    override fun getName() = "LiveRadio"

    // NativeEventEmitter housekeeping (new-architecture interop).
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Double) {}

    private fun emit(name: String, map: WritableMap) {
        val ctx = reactApplicationContext
        if (!ctx.hasActiveReactInstance()) return
        try {
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit(name, map)
        } catch (_: Exception) {}
    }

    /**
     * options: { sessionId, url, kind: 'hls' | 'progressive', dir (file:// or path),
     *            segmentSec = 6, windowSegments = 4, userAgent }
     */
    @ReactMethod
    fun start(options: ReadableMap, promise: Promise) {
        try {
            val sessionId = options.getString("sessionId") ?: throw IllegalArgumentException("sessionId is required")
            val url = options.getString("url") ?: throw IllegalArgumentException("url is required")
            val kind = options.getString("kind") ?: "progressive"
            val dirArg = options.getString("dir") ?: throw IllegalArgumentException("dir is required")
            val dir = File(Uri.decode(dirArg.removePrefix("file://")))
            val segmentSec = if (options.hasKey("segmentSec")) options.getDouble("segmentSec") else 6.0
            val windowSegments = if (options.hasKey("windowSegments")) options.getInt("windowSegments") else 4
            val ua = options.getString("userAgent") ?: "podink"
            if (!dir.exists() && !dir.mkdirs()) throw IOException("Could not create ${dir.absolutePath}")
            synchronized(this) {
                recorder?.requestStop()
                val r = Recorder(sessionId, url, kind, dir, segmentSec, windowSegments.coerceAtLeast(1), ua, ::emit)
                recorder = r
                r.start()
            }
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("START_FAILED", e.message ?: "Could not start the recorder", e)
        }
    }

    /** Stops the recorder of `sessionId` (no-op for any other). Resolves once the
     *  playlist carries its ENDLIST, or after 3 s. */
    @ReactMethod
    fun stop(sessionId: String, promise: Promise) {
        val r = synchronized(this) { recorder }
        if (r != null && r.sessionId == sessionId) {
            r.requestStop()
            try { r.join(3000) } catch (_: InterruptedException) {}
            synchronized(this) { if (recorder === r) recorder = null }
        }
        promise.resolve(null)
    }

    // ─── Recorder thread ────────────────────────────────────────────────────

    private class Recorder(
        val sessionId: String,
        private val url: String,
        private val kind: String,
        private val dir: File,
        segmentSec: Double,
        private val windowSegments: Int,
        private val userAgent: String,
        private val emit: (String, WritableMap) -> Unit,
    ) : Thread("LiveRadio-$sessionId") {

        private val stopped = AtomicBoolean(false)
        @Volatile private var activeConn: HttpURLConnection? = null
        @Volatile private var activeStream: InputStream? = null
        private val segmentUs = (segmentSec * 1_000_000).toLong().coerceIn(1_000_000L, (TARGET_DURATION_SEC - 1) * 1_000_000L)

        private val writer = SegmentWriter()
        private val sink = EsSink { bytes, off, len, durUs -> writer.onFrame(bytes, off, len, durUs) }
        private var lastTitle: String? = null

        fun requestStop() {
            stopped.set(true)
            try { activeStream?.close() } catch (_: Exception) {}
            try { activeConn?.disconnect() } catch (_: Exception) {}
            interrupt()
        }

        override fun run() {
            try {
                writer.writePlaylist(false)
                if (kind == "hls") runHls() else runProgressive()
            } catch (e: Throwable) {
                if (!stopped.get()) emitError(describe(e), true)
            } finally {
                try { writer.finish() } catch (_: Exception) {}
                val map = Arguments.createMap()
                map.putString("sessionId", sessionId)
                map.putDouble("totalSec", writer.totalUs / 1e6)
                emit(EVENT_STOPPED, map)
            }
        }

        private fun describe(e: Throwable) = "${e.javaClass.simpleName}: ${e.message ?: ""}".trim()

        private fun emitError(message: String, fatal: Boolean) {
            val map = Arguments.createMap()
            map.putString("sessionId", sessionId)
            map.putString("message", message)
            map.putBoolean("fatal", fatal)
            emit(EVENT_ERROR, map)
        }

        private fun sleepQuiet(ms: Long) {
            try { sleep(ms) } catch (_: InterruptedException) {}
        }

        // ─── HTTP ───────────────────────────────────────────────────────────

        /** GET with manual redirects (any scheme change allowed, 6 hops). */
        private fun open(urlStr: String, icy: Boolean): HttpURLConnection {
            var current = urlStr
            for (hop in 0 until 6) {
                if (stopped.get()) throw IOException("stopped")
                val conn = URL(current).openConnection() as HttpURLConnection
                conn.instanceFollowRedirects = false
                conn.connectTimeout = 15_000
                conn.readTimeout = 30_000
                conn.setRequestProperty("User-Agent", userAgent)
                conn.setRequestProperty("Accept", "*/*")
                if (icy) conn.setRequestProperty("Icy-MetaData", "1")
                val code = conn.responseCode
                if (code in 300..399) {
                    val loc = conn.getHeaderField("Location") ?: throw IOException("HTTP $code without Location")
                    conn.disconnect()
                    current = URL(URL(current), loc).toString()
                    continue
                }
                if (code < 200 || code >= 300) {
                    conn.disconnect()
                    throw IOException("HTTP $code from ${URL(current).host}")
                }
                return conn
            }
            throw IOException("Too many redirects")
        }

        private fun readAll(conn: HttpURLConnection, max: Int = 8 * 1024 * 1024): ByteArray {
            conn.inputStream.use { input ->
                val out = ByteArrayOutputStream()
                val buf = ByteArray(32 * 1024)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    if (out.size() > max) throw IOException("Response too large")
                }
                return out.toByteArray()
            }
        }

        private fun fetchText(urlStr: String): Pair<String, String> {
            val conn = open(urlStr, false)
            try {
                val text = String(readAll(conn, 2 * 1024 * 1024), Charsets.UTF_8)
                return Pair(conn.url.toString(), text)
            } finally { conn.disconnect() }
        }

        private fun fetchBytes(urlStr: String): ByteArray {
            val conn = open(urlStr, false)
            try { return readAll(conn) } finally { conn.disconnect() }
        }

        // ─── Progressive (Icecast / SHOUTcast) ──────────────────────────────

        private fun runProgressive() {
            var backoffMs = 1000L
            while (!stopped.get()) {
                var conn: HttpURLConnection? = null
                try {
                    conn = open(url, true)
                    val metaint = conn.getHeaderField("icy-metaint")?.trim()?.toIntOrNull() ?: 0
                    sink.hintContentType(conn.contentType ?: "")
                    val input = BufferedInputStream(conn.inputStream, 64 * 1024)
                    activeConn = conn
                    activeStream = input
                    backoffMs = 1000L
                    val buf = ByteArray(16 * 1024)
                    var untilMeta = metaint
                    while (!stopped.get()) {
                        if (metaint > 0) {
                            val want = minOf(buf.size, untilMeta)
                            val n = input.read(buf, 0, want)
                            if (n < 0) break
                            sink.feed(buf, 0, n)
                            untilMeta -= n
                            if (untilMeta == 0) {
                                val lenByte = input.read()
                                if (lenByte < 0) break
                                val mlen = lenByte * 16
                                if (mlen > 0) {
                                    val meta = ByteArray(mlen)
                                    var got = 0
                                    while (got < mlen) {
                                        val n2 = input.read(meta, got, mlen - got)
                                        if (n2 < 0) break
                                        got += n2
                                    }
                                    if (got < mlen) break
                                    handleIcy(String(meta, Charsets.UTF_8))
                                }
                                untilMeta = metaint
                            }
                        } else {
                            val n = input.read(buf)
                            if (n < 0) break
                            sink.feed(buf, 0, n)
                        }
                    }
                    if (!stopped.get()) emitError("The stream ended — reconnecting", false)
                } catch (e: Exception) {
                    if (stopped.get()) break
                    emitError(describe(e), false)
                } finally {
                    activeStream = null
                    activeConn = null
                    try { conn?.disconnect() } catch (_: Exception) {}
                }
                if (stopped.get()) break
                sleepQuiet(backoffMs)
                backoffMs = minOf(backoffMs * 2, 30_000L)
            }
        }

        private fun handleIcy(meta: String) {
            val m = Regex("StreamTitle='(.*?)';").find(meta) ?: return
            val title = m.groupValues[1].trim()
            if (title == lastTitle) return
            lastTitle = title
            val map = Arguments.createMap()
            map.putString("sessionId", sessionId)
            map.putString("title", title)
            emit(EVENT_METADATA, map)
        }

        // ─── HLS (live playlist mirror) ─────────────────────────────────────

        private class MediaPlaylist(
            val seq: Long,
            val targetDurationSec: Double,
            val segments: List<Pair<String, Double>>,
            val endList: Boolean,
        )

        private fun resolve(base: String, ref: String): String =
            try { URL(URL(base), ref).toString() } catch (_: Exception) { ref }

        /** Master playlist: the audio variant with the highest bandwidth ≤ 160 kbps,
         *  else the lowest one — speech, not music, and the segments are kept. */
        private fun pickVariant(text: String, base: String): String {
            var bestUrl: String? = null
            var bestBw = -1L
            var lowestUrl: String? = null
            var lowestBw = Long.MAX_VALUE
            var pendingBw = -1L
            for (raw in text.lines()) {
                val line = raw.trim()
                if (line.startsWith("#EXT-X-STREAM-INF")) {
                    pendingBw = Regex("(?:AVERAGE-)?BANDWIDTH=(\\d+)").find(line)?.groupValues?.get(1)?.toLongOrNull() ?: 0L
                } else if (line.isNotEmpty() && !line.startsWith("#") && pendingBw >= 0) {
                    val u = resolve(base, line)
                    if (pendingBw <= 160_000L && pendingBw > bestBw) { bestBw = pendingBw; bestUrl = u }
                    if (pendingBw < lowestBw) { lowestBw = pendingBw; lowestUrl = u }
                    pendingBw = -1L
                }
            }
            return bestUrl ?: lowestUrl ?: throw IOException("Master playlist has no variants")
        }

        private fun parseMediaPlaylist(text: String, base: String): MediaPlaylist {
            var seq = 0L
            var target = 6.0
            var endList = false
            var pendingDur = -1.0
            val segs = ArrayList<Pair<String, Double>>()
            for (raw in text.lines()) {
                val line = raw.trim()
                when {
                    line.startsWith("#EXT-X-MEDIA-SEQUENCE:") -> seq = line.substringAfter(':').trim().toLongOrNull() ?: 0L
                    line.startsWith("#EXT-X-TARGETDURATION:") -> target = line.substringAfter(':').trim().toDoubleOrNull() ?: 6.0
                    line.startsWith("#EXTINF:") -> pendingDur = line.substringAfter(':').substringBefore(',').trim().toDoubleOrNull() ?: 0.0
                    line == "#EXT-X-ENDLIST" -> endList = true
                    line.isNotEmpty() && !line.startsWith("#") && pendingDur >= 0 -> {
                        segs.add(Pair(resolve(base, line), pendingDur))
                        pendingDur = -1.0
                    }
                }
            }
            return MediaPlaylist(seq, target, segs, endList)
        }

        private val ts = TsDemuxer { bytes, off, len -> sink.feed(bytes, off, len) }

        private fun feedSegment(bytes: ByteArray) {
            if (bytes.size < 4) return
            val isTs = bytes[0] == 0x47.toByte() && (bytes.size < 189 || bytes[188] == 0x47.toByte())
            if (isTs) { ts.feed(bytes); return }
            val tag = if (bytes.size >= 8) String(bytes, 4, 4, Charsets.ISO_8859_1) else ""
            if (tag == "ftyp" || tag == "styp" || tag == "moof" || tag == "moov") {
                throw IOException("This station sends fragmented-MP4 segments, which the recorder cannot rewrite")
            }
            sink.feed(bytes, 0, bytes.size)
        }

        private fun runHls() {
            var mediaUrl = url
            var lastSeq = -1L
            var backoffMs = 1000L
            var idleMs = 3000L
            while (!stopped.get()) {
                try {
                    val (finalUrl, text) = fetchText(mediaUrl)
                    if (!text.startsWith("#EXTM3U")) throw IOException("Not an HLS playlist")
                    if (text.contains("#EXT-X-STREAM-INF")) {
                        mediaUrl = pickVariant(text, finalUrl)
                        continue
                    }
                    val pl = parseMediaPlaylist(text, finalUrl)
                    if (pl.segments.isEmpty()) throw IOException("Empty playlist")
                    idleMs = (pl.targetDurationSec * 500).toLong().coerceIn(1500L, 6000L)
                    // First pass: join near the live edge. Later: only what is new;
                    // a sequence gap (we fell behind the window) skips forward.
                    val startIdx = if (lastSeq < 0) {
                        maxOf(0, pl.segments.size - 3)
                    } else {
                        val i = lastSeq + 1 - pl.seq
                        if (i < 0) 0 else minOf(i, pl.segments.size.toLong()).toInt()
                    }
                    for (i in startIdx until pl.segments.size) {
                        if (stopped.get()) break
                        val (segUrl, _) = pl.segments[i]
                        feedSegment(fetchBytes(segUrl))
                        lastSeq = pl.seq + i
                    }
                    if (pl.endList) {
                        emitError("The stream ended", true)
                        break
                    }
                    backoffMs = 1000L
                    sleepQuiet(idleMs)
                } catch (e: Exception) {
                    if (stopped.get()) break
                    emitError(describe(e), e.message?.contains("fragmented-MP4") == true)
                    if (e.message?.contains("fragmented-MP4") == true) break
                    sleepQuiet(backoffMs)
                    backoffMs = minOf(backoffMs * 2, 30_000L)
                }
            }
        }

        // ─── Segment / window / playlist writer ─────────────────────────────

        private inner class SegmentWriter {
            private var segIndex = 0
            private val segBuf = ByteArrayOutputStream(256 * 1024)
            private var segUs = 0L
            var totalUs = 0L
                private set
            private val entries = StringBuilder()
            private val windowFiles = ArrayList<File>()
            private var windowStartUs = 0L
            private var windowUs = 0L
            private var windowIndex = 0
            private var finished = false

            private val ext: String get() = if (sink.codec == EsSink.Codec.MP3) "mp3" else "aac"

            fun onFrame(bytes: ByteArray, off: Int, len: Int, durUs: Long) {
                if (finished) return
                segBuf.write(bytes, off, len)
                segUs += durUs
                if (segUs >= segmentUs) flushSegment()
            }

            private fun flushSegment() {
                if (segUs <= 0L || segBuf.size() == 0) return
                val f = File(dir, String.format(Locale.US, "seg_%06d.%s", segIndex, ext))
                FileOutputStream(f).use { segBuf.writeTo(it) }
                entries.append(String.format(Locale.US, "#EXTINF:%.6f,\n%s\n", segUs / 1e6, f.name))
                writePlaylist(false)

                val startUs = totalUs
                totalUs += segUs
                val map = Arguments.createMap()
                map.putString("sessionId", sessionId)
                map.putInt("index", segIndex)
                map.putDouble("startSec", startUs / 1e6)
                map.putDouble("durationSec", segUs / 1e6)
                map.putDouble("totalSec", totalUs / 1e6)
                emit(EVENT_SEGMENT, map)

                windowFiles.add(f)
                windowUs += segUs
                segIndex += 1
                segBuf.reset()
                segUs = 0L
                if (windowFiles.size >= windowSegments) flushWindow()
            }

            private fun flushWindow() {
                if (windowFiles.isEmpty()) return
                val w = File(dir, String.format(Locale.US, "win_%05d.%s", windowIndex, ext))
                FileOutputStream(w).use { out ->
                    for (f in windowFiles) f.inputStream().use { it.copyTo(out, 64 * 1024) }
                }
                val map = Arguments.createMap()
                map.putString("sessionId", sessionId)
                map.putInt("index", windowIndex)
                map.putString("path", w.absolutePath)
                map.putDouble("startSec", windowStartUs / 1e6)
                map.putDouble("durationSec", windowUs / 1e6)
                emit(EVENT_WINDOW, map)
                windowIndex += 1
                windowStartUs += windowUs
                windowUs = 0L
                windowFiles.clear()
            }

            /** Whole playlist rewritten into a temp file, then renamed over the
             *  live one: a reader never sees a half-written list. */
            fun writePlaylist(ended: Boolean) {
                val sb = StringBuilder(entries.length + 160)
                sb.append("#EXTM3U\n#EXT-X-VERSION:3\n")
                sb.append("#EXT-X-TARGETDURATION:").append(TARGET_DURATION_SEC).append('\n')
                sb.append("#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:EVENT\n")
                sb.append(entries)
                if (ended) sb.append("#EXT-X-ENDLIST\n")
                val tmp = File(dir, "live.m3u8.tmp")
                tmp.writeText(sb.toString(), Charsets.UTF_8)
                val live = File(dir, "live.m3u8")
                if (!tmp.renameTo(live)) {
                    live.writeText(sb.toString(), Charsets.UTF_8)
                    tmp.delete()
                }
            }

            /** Last partial segment (≥ 1 s) and window go out, then ENDLIST. */
            fun finish() {
                if (finished) return
                if (segUs >= 1_000_000L) flushSegment()
                flushWindow()
                finished = true
                writePlaylist(true)
            }
        }
    }

    // ─── Elementary-stream frame parser (MP3 / ADTS) ─────────────────────────

    /**
     * Finds MP3 or ADTS frames in an arbitrary byte stream (resyncing on
     * garbage, skipping ID3v2 tags) and hands each whole frame out with its
     * exact duration. The codec is decided by the first pair of consecutive
     * valid headers.
     */
    private class EsSink(private val onFrame: (ByteArray, Int, Int, Long) -> Unit) {
        enum class Codec { MP3, ADTS }

        var codec: Codec? = null
            private set
        private var hinted: Codec? = null
        private var buf = ByteArray(64 * 1024)
        private var len = 0

        fun hintContentType(type: String) {
            val t = type.lowercase(Locale.US)
            hinted = when {
                t.contains("aac") -> Codec.ADTS
                t.contains("mpeg") || t.contains("mp3") -> Codec.MP3
                else -> null
            }
        }

        fun feed(data: ByteArray, off: Int, n: Int) {
            if (n <= 0) return
            if (len + n > buf.size) {
                var cap = buf.size
                while (cap < len + n) cap *= 2
                buf = buf.copyOf(cap)
            }
            System.arraycopy(data, off, buf, len, n)
            len += n
            parse()
        }

        private class Frame(val length: Int, val durationUs: Long)

        private fun parse() {
            var pos = 0
            while (len - pos >= 10) {
                // ID3v2 tag (stream start, or between tracks on some servers)
                if (buf[pos] == 'I'.code.toByte() && buf[pos + 1] == 'D'.code.toByte() && buf[pos + 2] == '3'.code.toByte()
                    && (buf[pos + 3].toInt() and 0xFF) < 0xFF && (buf[pos + 4].toInt() and 0xFF) < 0xFF) {
                    val size = 10 + syncsafe(pos + 6) + (if ((buf[pos + 5].toInt() and 0x10) != 0) 10 else 0)
                    if (len - pos < size) break
                    pos += size
                    continue
                }
                // Once the codec is known, only its headers count — an MP3 data
                // byte pair can look like an ADTS sync and vice versa.
                val locked = codec
                val frame = if (locked != null) frameAt(pos, locked) else (frameAt(pos, hinted) ?: frameAt(pos, null))
                if (frame == null) { pos++; continue }
                // Whole frame plus the next header must be present to confirm sync.
                if (len - pos < frame.length + 4) break
                val next = frameAt(pos + frame.length, frame.codec)
                val nextIsId3 = buf[pos + frame.length] == 'I'.code.toByte() &&
                    buf[pos + frame.length + 1] == 'D'.code.toByte() && buf[pos + frame.length + 2] == '3'.code.toByte()
                if (next == null && !nextIsId3) { pos++; continue }
                if (codec == null) codec = frame.codec
                onFrame(buf, pos, frame.length, frame.durationUs)
                pos += frame.length
            }
            if (pos > 0) {
                System.arraycopy(buf, pos, buf, 0, len - pos)
                len -= pos
            }
            // Runaway garbage (no sync in 1 MB): drop it rather than grow forever.
            if (len > 1024 * 1024) len = 0
        }

        private fun syncsafe(at: Int): Int =
            ((buf[at].toInt() and 0x7F) shl 21) or ((buf[at + 1].toInt() and 0x7F) shl 14) or
                ((buf[at + 2].toInt() and 0x7F) shl 7) or (buf[at + 3].toInt() and 0x7F)

        private class TypedFrame(val codec: Codec, val length: Int, val durationUs: Long)

        private fun frameAt(pos: Int, want: Codec?): TypedFrame? {
            if (len - pos < 7) return null
            val b0 = buf[pos].toInt() and 0xFF
            val b1 = buf[pos + 1].toInt() and 0xFF
            if (b0 != 0xFF) return null
            if (want != Codec.MP3 && (b1 and 0xF6) == 0xF0) {
                adtsAt(pos)?.let { return TypedFrame(Codec.ADTS, it.length, it.durationUs) }
            }
            if (want != Codec.ADTS && (b1 and 0xE0) == 0xE0) {
                mp3At(pos)?.let { return TypedFrame(Codec.MP3, it.length, it.durationUs) }
            }
            return null
        }

        private val ADTS_RATES = intArrayOf(96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350)

        private fun adtsAt(pos: Int): Frame? {
            val b1 = buf[pos + 1].toInt() and 0xFF
            val b2 = buf[pos + 2].toInt() and 0xFF
            val b3 = buf[pos + 3].toInt() and 0xFF
            val b4 = buf[pos + 4].toInt() and 0xFF
            val b5 = buf[pos + 5].toInt() and 0xFF
            val b6 = buf[pos + 6].toInt() and 0xFF
            val sfi = (b2 shr 2) and 0x0F
            if (sfi >= ADTS_RATES.size) return null
            val protectionAbsent = (b1 and 0x01) != 0
            val frameLen = ((b3 and 0x03) shl 11) or (b4 shl 3) or (b5 shr 5)
            val minLen = if (protectionAbsent) 7 else 9
            if (frameLen < minLen || frameLen > 8192) return null
            val blocks = (b6 and 0x03) + 1
            val durUs = 1024L * blocks * 1_000_000L / ADTS_RATES[sfi]
            return Frame(frameLen, durUs)
        }

        private val MP3_BITRATES = arrayOf(
            // MPEG-1: L1, L2, L3
            intArrayOf(0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448),
            intArrayOf(0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384),
            intArrayOf(0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320),
            // MPEG-2 / 2.5: L1, L2+L3
            intArrayOf(0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256),
            intArrayOf(0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160),
        )
        private val MP3_RATES = arrayOf(
            intArrayOf(44100, 48000, 32000), // MPEG-1
            intArrayOf(22050, 24000, 16000), // MPEG-2
            intArrayOf(11025, 12000, 8000),  // MPEG-2.5
        )

        private fun mp3At(pos: Int): Frame? {
            val b1 = buf[pos + 1].toInt() and 0xFF
            val b2 = buf[pos + 2].toInt() and 0xFF
            val versionBits = (b1 shr 3) and 0x03   // 00 = 2.5, 01 = reserved, 10 = 2, 11 = 1
            val layerBits = (b1 shr 1) and 0x03     // 01 = III, 10 = II, 11 = I
            if (versionBits == 1 || layerBits == 0) return null
            val bitrateIdx = (b2 shr 4) and 0x0F
            val rateIdx = (b2 shr 2) and 0x03
            val padding = (b2 shr 1) and 0x01
            if (bitrateIdx == 0 || bitrateIdx == 15 || rateIdx == 3) return null
            val mpeg1 = versionBits == 3
            val rate = when (versionBits) { 3 -> MP3_RATES[0][rateIdx]; 2 -> MP3_RATES[1][rateIdx]; else -> MP3_RATES[2][rateIdx] }
            val layer = 4 - layerBits // 1, 2, 3
            val table = if (mpeg1) MP3_BITRATES[layer - 1] else if (layer == 1) MP3_BITRATES[3] else MP3_BITRATES[4]
            val kbps = table[bitrateIdx]
            if (kbps == 0) return null
            val samples = when (layer) { 1 -> 384; 2 -> 1152; else -> if (mpeg1) 1152 else 576 }
            val length = if (layer == 1) (12 * kbps * 1000 / rate + padding) * 4
                         else samples / 8 * kbps * 1000 / rate + padding
            if (length < 24) return null
            return Frame(length, samples * 1_000_000L / rate)
        }
    }

    // ─── MPEG-TS demuxer (audio PID → elementary stream) ─────────────────────

    /** Just enough of ISO 13818-1 to pull the audio PES payloads out of an
     *  audio-only transport stream: PAT → PMT → the first AAC (0x0F) or MPEG
     *  audio (0x03/0x04) PID; PES headers dropped; ADTS/MP3 bytes come out as
     *  a continuous stream. State (PIDs) persists across segments. */
    private class TsDemuxer(private val out: (ByteArray, Int, Int) -> Unit) {
        private var pmtPid = -1
        private var audioPid = -1

        fun feed(data: ByteArray) {
            var p = 0
            val n = data.size
            while (p + 188 <= n) {
                if (data[p] != 0x47.toByte()) { p++; continue }
                val b1 = data[p + 1].toInt() and 0xFF
                val b2 = data[p + 2].toInt() and 0xFF
                val b3 = data[p + 3].toInt() and 0xFF
                val pusi = (b1 and 0x40) != 0
                val pid = ((b1 and 0x1F) shl 8) or b2
                val afc = (b3 shr 4) and 0x03
                var off = p + 4
                val end = p + 188
                if ((afc and 2) != 0) {
                    val al = data[off].toInt() and 0xFF
                    off += 1 + al
                }
                if ((afc and 1) != 0 && off < end) {
                    when (pid) {
                        0 -> if (pusi) parsePat(data, off, end)
                        pmtPid -> if (pusi) parsePmt(data, off, end)
                        audioPid -> {
                            var s = off
                            if (pusi && end - s >= 9 &&
                                data[s] == 0.toByte() && data[s + 1] == 0.toByte() && data[s + 2] == 1.toByte()) {
                                val hdrLen = data[s + 8].toInt() and 0xFF
                                s += 9 + hdrLen
                            }
                            if (s < end) out(data, s, end - s)
                        }
                    }
                }
                p += 188
            }
        }

        private fun parsePat(d: ByteArray, start: Int, end: Int) {
            var s = start + 1 + (d[start].toInt() and 0xFF) // pointer_field
            if (s + 8 > end || d[s] != 0.toByte()) return
            val sectionLen = ((d[s + 1].toInt() and 0x0F) shl 8) or (d[s + 2].toInt() and 0xFF)
            val sectionEnd = minOf(end, s + 3 + sectionLen - 4) // minus CRC
            s += 8
            while (s + 4 <= sectionEnd) {
                val program = ((d[s].toInt() and 0xFF) shl 8) or (d[s + 1].toInt() and 0xFF)
                val pid = ((d[s + 2].toInt() and 0x1F) shl 8) or (d[s + 3].toInt() and 0xFF)
                if (program != 0) { pmtPid = pid; return }
                s += 4
            }
        }

        private fun parsePmt(d: ByteArray, start: Int, end: Int) {
            var s = start + 1 + (d[start].toInt() and 0xFF)
            if (s + 12 > end || d[s] != 2.toByte()) return
            val sectionLen = ((d[s + 1].toInt() and 0x0F) shl 8) or (d[s + 2].toInt() and 0xFF)
            val sectionEnd = minOf(end, s + 3 + sectionLen - 4)
            val infoLen = ((d[s + 10].toInt() and 0x0F) shl 8) or (d[s + 11].toInt() and 0xFF)
            s += 12 + infoLen
            var mpegAudio = -1
            while (s + 5 <= sectionEnd) {
                val type = d[s].toInt() and 0xFF
                val pid = ((d[s + 1].toInt() and 0x1F) shl 8) or (d[s + 2].toInt() and 0xFF)
                val esLen = ((d[s + 3].toInt() and 0x0F) shl 8) or (d[s + 4].toInt() and 0xFF)
                if (type == 0x0F) { audioPid = pid; return }
                if ((type == 0x03 || type == 0x04) && mpegAudio < 0) mpegAudio = pid
                s += 5 + esLen
            }
            if (mpegAudio >= 0) audioPid = mpegAudio
        }
    }
}
