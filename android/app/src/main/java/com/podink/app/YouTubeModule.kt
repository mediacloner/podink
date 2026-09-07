package com.podink.app

import android.net.Uri
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.schabi.newpipe.extractor.Image
import org.schabi.newpipe.extractor.NewPipe
import org.schabi.newpipe.extractor.ServiceList
import org.schabi.newpipe.extractor.downloader.Downloader
import org.schabi.newpipe.extractor.downloader.Request
import org.schabi.newpipe.extractor.downloader.Response
import org.schabi.newpipe.extractor.exceptions.ReCaptchaException
import org.schabi.newpipe.extractor.localization.ContentCountry
import org.schabi.newpipe.extractor.localization.Localization
import org.schabi.newpipe.extractor.stream.AudioStream
import org.schabi.newpipe.extractor.stream.StreamInfo
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.GZIPInputStream

/**
 * YouTube import (4.1.0). Two jobs, both off the JS thread:
 *
 *  resolve(url)   — NewPipe Extractor reads the video page the way the NewPipe
 *                   app does (ANDROID / IOS player clients, the player JS run
 *                   through Rhino for the throttling parameter) and returns the
 *                   video's metadata plus its audio-only streams, best first:
 *                   the original-language track, M4A (AAC) before WebM (Opus),
 *                   higher bitrate before lower. Nothing is written.
 *  download(opts) — pulls one of those stream URLs into a file in 8 MB Range
 *                   chunks (googlevideo throttles a single long request to
 *                   about real time and refuses very large ones), retrying a
 *                   dropped chunk from its offset, `.part` until complete.
 *                   Progress is broadcast as YouTubeDownloadProgress
 *                   { jobId, downloaded, total }; cancel(jobId) aborts.
 *
 * The extractor gets a plain HttpURLConnection-backed Downloader (no OkHttp
 * dependency of our own): headers as requested, POST bodies, gzip bodies
 * inflated, HTTP 429 surfaced as the reCAPTCHA exception it expects.
 */
class YouTubeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    companion object {
        const val EVENT_PROGRESS = "YouTubeDownloadProgress"
        const val CHUNK_BYTES = 8L * 1024 * 1024
        const val MAX_RETRIES = 4
        // A current desktop browser: what the NewPipe app sends where the
        // extractor does not set a client-specific agent, and for the media
        // download itself.
        const val USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0"

        private val initialized = AtomicBoolean(false)
        fun ensureInit() {
            if (initialized.compareAndSet(false, true)) {
                NewPipe.init(UrlConnectionDownloader(), Localization.DEFAULT, ContentCountry.DEFAULT)
            }
        }
    }

    private val resolver = Executors.newSingleThreadExecutor()
    private val downloader = Executors.newSingleThreadExecutor()
    private val jobs = ConcurrentHashMap<String, DownloadJob>()

    override fun getName() = "YouTube"

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

    // ─── resolve ────────────────────────────────────────────────────────────

    @ReactMethod
    fun resolve(url: String, promise: Promise) {
        resolver.execute {
            try {
                ensureInit()
                val info = StreamInfo.getInfo(ServiceList.YouTube, url)
                val type = info.streamType?.name ?: ""
                if (type == "LIVE_STREAM" || type == "AUDIO_LIVE_STREAM") {
                    promise.reject("LIVE", "This is a live stream; only finished videos can be imported.")
                    return@execute
                }
                promise.resolve(describe(info, type))
            } catch (e: Exception) {
                promise.reject(codeFor(e), messageFor(e), e)
            }
        }
    }

    private fun describe(info: StreamInfo, type: String): WritableMap {
        val map = Arguments.createMap()
        map.putString("id", info.id ?: "")
        map.putString("url", info.url ?: "")
        map.putString("title", info.name ?: "")
        val desc = info.description
        map.putString("description", desc?.content ?: "")
        map.putInt("descriptionType", desc?.type ?: 3)
        map.putString("uploaderName", info.uploaderName ?: "")
        map.putString("uploaderUrl", info.uploaderUrl ?: "")
        map.putString("uploaderAvatar", largest(info.uploaderAvatars, Int.MAX_VALUE))
        map.putString("thumbnail", largest(info.thumbnails, 1280))
        map.putDouble("durationSec", info.duration.toDouble())
        map.putString("uploadDate", try { info.uploadDate?.offsetDateTime()?.toString() ?: "" } catch (_: Exception) { "" })
        map.putString("textualUploadDate", info.textualUploadDate ?: "")
        map.putDouble("viewCount", info.viewCount.toDouble())
        map.putString("streamType", type)
        map.putArray("audio", audioStreams(info.audioStreams ?: emptyList()))
        return map
    }

    /** The largest picture no taller than `maxHeight` (unknown heights count
     *  as 0); the first one when none qualifies; "" without any. */
    private fun largest(images: List<Image>?, maxHeight: Int): String {
        if (images.isNullOrEmpty()) return ""
        val fitting = images.filter { it.height <= maxHeight || it.height <= 0 }
        val pool = if (fitting.isEmpty()) images else fitting
        return pool.maxByOrNull { if (it.height > 0) it.height else 0 }?.url ?: ""
    }

    private fun trackRank(s: AudioStream): Int = when (s.audioTrackType?.name) {
        null, "ORIGINAL" -> 0
        "SECONDARY" -> 1
        "DUBBED" -> 2
        else -> 3 // DESCRIPTIVE
    }

    private fun formatRank(s: AudioStream): Int = when (s.format?.suffix?.lowercase()) {
        "m4a", "mp3" -> 0
        "webm", "opus" -> 1
        else -> 2
    }

    private fun bitrateOf(s: AudioStream): Int = if (s.averageBitrate > 0) s.averageBitrate else s.bitrate

    private fun audioStreams(streams: List<AudioStream>): WritableArray {
        val usable = streams.filter {
            it.isUrl && it.deliveryMethod?.name == "PROGRESSIVE_HTTP" && !it.content.isNullOrBlank()
        }
        val sorted = usable.sortedWith(compareBy<AudioStream>({ trackRank(it) }, { formatRank(it) }, { -bitrateOf(it) }))
        val arr = Arguments.createArray()
        for (s in sorted) {
            val m = Arguments.createMap()
            m.putString("url", s.content)
            m.putString("format", s.format?.suffix ?: "")
            m.putString("mimeType", s.format?.mimeType ?: "")
            m.putInt("bitrate", bitrateOf(s))
            m.putString("codec", s.codec ?: "")
            m.putDouble("contentLength", (try { s.itagItem?.contentLength ?: -1L } catch (_: Exception) { -1L }).toDouble())
            m.putInt("itag", try { s.itag } catch (_: Exception) { -1 })
            m.putString("trackType", s.audioTrackType?.name ?: "")
            m.putString("trackName", s.audioTrackName ?: "")
            arr.pushMap(m)
        }
        return arr
    }

    private fun codeFor(e: Exception): String = when (e.javaClass.simpleName) {
        "ReCaptchaException" -> "RECAPTCHA"
        "AgeRestrictedContentException" -> "AGE_RESTRICTED"
        "PrivateContentException" -> "PRIVATE"
        "PaidContentException" -> "PAID"
        "GeographicRestrictionException" -> "GEO_BLOCKED"
        "ContentNotAvailableException" -> "NOT_AVAILABLE"
        "ContentNotSupportedException" -> "NOT_SUPPORTED"
        "ParsingException" -> "PARSE"
        "UnknownHostException", "SocketTimeoutException", "ConnectException", "SSLException" -> "NETWORK"
        else -> if (e is IOException) "NETWORK" else "EXTRACT"
    }

    private fun messageFor(e: Exception): String {
        val own = e.message?.trim().orEmpty()
        val cause = e.cause?.message?.trim().orEmpty()
        return when {
            own.isNotEmpty() && cause.isNotEmpty() && !own.contains(cause) -> "$own ($cause)"
            own.isNotEmpty() -> own
            cause.isNotEmpty() -> cause
            else -> e.javaClass.simpleName
        }
    }

    // ─── download ───────────────────────────────────────────────────────────

    /** options: { jobId, url, dest (file:// or path), contentLength? } */
    @ReactMethod
    fun download(options: ReadableMap, promise: Promise) {
        val jobId = options.getString("jobId")
        val url = options.getString("url")
        val destArg = options.getString("dest")
        if (jobId == null || url == null || destArg == null) {
            promise.reject("BAD_ARGS", "jobId, url and dest are required")
            return
        }
        val total = if (options.hasKey("contentLength") && !options.isNull("contentLength")) options.getDouble("contentLength").toLong() else -1L
        val dest = File(Uri.decode(destArg.removePrefix("file://")))
        val job = DownloadJob(jobId, url, dest, total) { downloaded, size ->
            val map = Arguments.createMap()
            map.putString("jobId", jobId)
            map.putDouble("downloaded", downloaded.toDouble())
            map.putDouble("total", size.toDouble())
            emit(EVENT_PROGRESS, map)
        }
        jobs[jobId] = job
        downloader.execute {
            try {
                val size = job.run()
                val map = Arguments.createMap()
                map.putString("path", dest.absolutePath)
                map.putDouble("size", size.toDouble())
                promise.resolve(map)
            } catch (e: CancelledException) {
                promise.reject("CANCELLED", "Cancelled", e)
            } catch (e: HttpStatusException) {
                promise.reject("HTTP_${e.code}", e.message ?: "HTTP ${e.code}", e)
            } catch (e: Exception) {
                promise.reject("DOWNLOAD_FAILED", e.message ?: "Download failed", e)
            } finally {
                jobs.remove(jobId)
            }
        }
    }

    @ReactMethod
    fun cancel(jobId: String) {
        jobs[jobId]?.cancel()
    }

    private class CancelledException : Exception("Cancelled")
    private class HttpStatusException(val code: Int) : IOException("HTTP $code from the media server")

    private class DownloadJob(
        val jobId: String,
        private val url: String,
        private val dest: File,
        private val totalHint: Long,
        private val onProgress: (Long, Long) -> Unit,
    ) {
        private val cancelled = AtomicBoolean(false)
        @Volatile private var activeConn: HttpURLConnection? = null
        private var lastEmit = 0L

        fun cancel() {
            cancelled.set(true)
            try { activeConn?.disconnect() } catch (_: Exception) {}
        }

        private fun open(range: String): HttpURLConnection {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 20_000
            conn.readTimeout = 30_000
            conn.instanceFollowRedirects = true
            conn.setRequestProperty("User-Agent", USER_AGENT)
            conn.setRequestProperty("Accept", "*/*")
            conn.setRequestProperty("Range", range)
            return conn
        }

        private fun progress(downloaded: Long, total: Long, force: Boolean = false) {
            val now = System.currentTimeMillis()
            if (force || now - lastEmit > 250) {
                lastEmit = now
                onProgress(downloaded, total)
            }
        }

        /** "bytes a-b/total" → total, or null when the server does not say. */
        private fun totalFromContentRange(header: String?): Long? {
            val h = header ?: return null
            val slash = h.lastIndexOf('/')
            if (slash < 0) return null
            return h.substring(slash + 1).trim().toLongOrNull()?.takeIf { it > 0 }
        }

        /** Copies the body into `out`, advancing and reporting `offset`. Returns
         *  the number of bytes copied. */
        private fun copy(input: InputStream, out: OutputStream, buf: ByteArray, startOffset: Long, total: Long): Long {
            var offset = startOffset
            while (true) {
                if (cancelled.get()) throw CancelledException()
                val n = input.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                offset += n
                progress(offset, total)
            }
            return offset - startOffset
        }

        private fun skipFully(input: InputStream, count: Long) {
            var left = count
            val buf = ByteArray(64 * 1024)
            while (left > 0) {
                val n = input.read(buf, 0, minOf(left, buf.size.toLong()).toInt())
                if (n < 0) throw IOException("Body shorter than the bytes already saved")
                left -= n
            }
        }

        fun run(): Long {
            dest.parentFile?.mkdirs()
            val part = File(dest.absolutePath + ".part")
            if (part.exists()) part.delete()
            var offset = 0L
            var total = totalHint
            var attempts = 0
            val buf = ByteArray(256 * 1024)
            try {
                FileOutputStream(part).use { out ->
                    loop@ while (true) {
                        if (cancelled.get()) throw CancelledException()
                        val end = if (total > 0) minOf(offset + CHUNK_BYTES - 1, total - 1) else offset + CHUNK_BYTES - 1
                        var conn: HttpURLConnection? = null
                        try {
                            conn = open("bytes=$offset-$end")
                            activeConn = conn
                            val code = conn.responseCode
                            when (code) {
                                416 -> {
                                    if (total > 0 && offset >= total) break@loop
                                    throw HttpStatusException(code)
                                }
                                200 -> {
                                    // Range ignored: the whole body in one go.
                                    val len = conn.contentLengthLong
                                    if (len > 0) total = len
                                    conn.inputStream.use { input ->
                                        if (offset > 0) skipFully(input, offset)
                                        offset += copy(input, out, buf, offset, total)
                                    }
                                    break@loop
                                }
                                206 -> {
                                    totalFromContentRange(conn.getHeaderField("Content-Range"))?.let { total = it }
                                    val wanted = end - offset + 1
                                    val n = conn.inputStream.use { input -> copy(input, out, buf, offset, total) }
                                    offset += n
                                    if (n <= 0L) throw IOException("Empty chunk at $offset")
                                    if (total > 0 && offset >= total) break@loop
                                    if (total <= 0 && n < wanted) break@loop // short final chunk, length unknown
                                }
                                else -> throw HttpStatusException(code)
                            }
                            attempts = 0
                        } catch (e: IOException) {
                            if (cancelled.get()) throw CancelledException()
                            if (e is HttpStatusException || ++attempts > MAX_RETRIES) throw e
                            try { Thread.sleep(700L * attempts) } catch (_: InterruptedException) {}
                        } finally {
                            activeConn = null
                            try { conn?.disconnect() } catch (_: Exception) {}
                        }
                    }
                    out.flush()
                }
                if (cancelled.get()) throw CancelledException()
                if (total > 0 && offset < total) throw IOException("Incomplete download ($offset of $total bytes)")
                if (offset <= 0) throw IOException("The media server sent no data")
                if (dest.exists()) dest.delete()
                if (!part.renameTo(dest)) throw IOException("Could not move the file into place")
                progress(offset, if (total > 0) total else offset, force = true)
                return offset
            } catch (e: Exception) {
                try { part.delete() } catch (_: Exception) {}
                throw e
            }
        }
    }

    // ─── NewPipe Downloader on HttpURLConnection ────────────────────────────

    private class UrlConnectionDownloader : Downloader() {
        override fun execute(request: Request): Response {
            val url = request.url()
            var conn: HttpURLConnection? = null
            try {
                conn = URL(url).openConnection() as HttpURLConnection
                conn.requestMethod = request.httpMethod()
                conn.connectTimeout = 30_000
                conn.readTimeout = 30_000
                conn.instanceFollowRedirects = true
                conn.setRequestProperty("User-Agent", USER_AGENT)
                for ((name, values) in request.headers()) {
                    if (name == null || values.isNullOrEmpty()) continue
                    conn.setRequestProperty(name, values[0])
                    for (i in 1 until values.size) conn.addRequestProperty(name, values[i])
                }
                val body = request.dataToSend()
                if (body != null) {
                    conn.doOutput = true
                    conn.setFixedLengthStreamingMode(body.size)
                    conn.outputStream.use { it.write(body) }
                }
                val code = conn.responseCode
                if (code == 429) throw ReCaptchaException("reCaptcha Challenge requested", url)
                val raw: InputStream? = try {
                    if (code >= 400) conn.errorStream else conn.inputStream
                } catch (_: IOException) { conn.errorStream }
                val stream = if (raw != null && conn.contentEncoding?.equals("gzip", ignoreCase = true) == true) GZIPInputStream(raw) else raw
                val text = stream?.use { InputStreamReader(it, Charsets.UTF_8).readText() } ?: ""
                val headers = LinkedHashMap<String, List<String>>()
                for ((k, v) in conn.headerFields) if (k != null && v != null) headers[k] = v
                return Response(code, conn.responseMessage ?: "", headers, text, conn.url.toString())
            } finally {
                try { conn?.disconnect() } catch (_: Exception) {}
            }
        }
    }
}
