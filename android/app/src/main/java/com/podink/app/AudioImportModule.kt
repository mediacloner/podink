package com.podink.app

import android.app.Activity
import android.content.ContentResolver
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Local-audio import: system pickers (files, folder, image), audio tags through
 * MediaMetadataRetriever, embedded cover extraction and a progress-reporting copy
 * from any content:// or file:// URI into the app's own storage.
 *
 * Everything the JS side needs to turn a chosen audiobook into a local collection
 * lives here, so no extra Expo packages are required.
 *
 * 4.8.0 adds the book side of an audiobook: an .epub is a pickable "book" document,
 * the chapter markers inside a single .m4b/.m4a (Nero `chpl` atom or the QuickTime
 * chapter text track) can be read, and such a file can be cut into one file per
 * chapter without re-encoding (MediaExtractor → MediaMuxer). It can also report
 * where the reader pauses (analyzeSilence), which is what pins an imported book's
 * text to its narration without running the speech engine.
 */
class AudioImportModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    companion object {
        private const val REQ_PICK_AUDIO = 41001
        private const val REQ_PICK_FOLDER = 41002
        private const val REQ_PICK_IMAGE = 41003
        private const val REQ_PICK_BOOK = 41004
        private const val MAX_DEPTH = 8
        private const val EVENT_PROGRESS = "AudioImportProgress"

        private val AUDIO_EXT = setOf(
            "mp3", "m4a", "m4b", "aac", "ogg", "oga", "opus", "flac", "wav", "wma",
            "mp4", "3gp", "amr", "aiff", "aif", "mka", "webm", "mpga", "mp2", "ac3"
        )
        private val IMAGE_EXT = setOf("jpg", "jpeg", "png", "webp", "gif", "bmp")
        private val TEXT_EXT = setOf("nfo", "txt", "md", "cue", "json", "opf")
        private val BOOK_EXT = setOf("epub")
        private const val BOOK_MIME = "application/epub+zip"
        // Chapters plus the sidecars an audiobook folder usually carries (cover art, .nfo notes, the EPUB).
        private val PICKER_MIME = arrayOf(
            "audio/*", "application/ogg", "application/x-ogg", "video/mp4", "application/octet-stream",
            "image/*", "text/*", BOOK_MIME
        )
        // Providers often label an .epub application/octet-stream; the extension decides in JS.
        private val BOOK_PICKER_MIME = arrayOf(BOOK_MIME, "application/octet-stream", "application/zip")
        private const val MAX_TOP_BOXES = 64
        // Silence scan: one loudness reading per FRAME_MS of audio.
        private const val FRAME_MS = 10
        private const val DEFAULT_MIN_SILENCE_MS = 220
        // Loudness per frame is judged on this many samples, however many the
        // frame really holds.
        private const val SAMPLES_PER_FRAME = 64
        private const val CODEC_TIMEOUT_US = 10_000L
        private const val EVENT_SILENCE = "AudioSilenceProgress"
        private const val MAX_TEXT_BYTES = 256 * 1024
    }

    private val executor = Executors.newSingleThreadExecutor()
    private var pendingPromise: Promise? = null
    private var pendingRequest = 0

    init {
        reactContext.addActivityEventListener(this)
    }

    override fun getName() = "AudioImport"

    private val resolver: ContentResolver get() = reactApplicationContext.contentResolver

    // ─── Pickers ────────────────────────────────────────────────────────────

    @ReactMethod
    fun pickAudio(multiple: Boolean, promise: Promise) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, PICKER_MIME)
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
        }
        launch(intent, REQ_PICK_AUDIO, promise)
    }

    @ReactMethod
    fun pickFolder(promise: Promise) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
        launch(intent, REQ_PICK_FOLDER, promise)
    }

    @ReactMethod
    fun pickImage(promise: Promise) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "image/*"
        }
        launch(intent, REQ_PICK_IMAGE, promise)
    }

    /** One EPUB, for the book text of a collection (importService / CollectionEditor). */
    @ReactMethod
    fun pickBook(promise: Promise) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, BOOK_PICKER_MIME)
        }
        launch(intent, REQ_PICK_BOOK, promise)
    }

    private fun launch(intent: Intent, code: Int, promise: Promise) {
        val activity = reactApplicationContext.currentActivity
        if (activity == null) {
            promise.reject("NO_ACTIVITY", "No foreground activity to open the picker from")
            return
        }
        pendingPromise?.resolve(null) // a stale picker never came back; release it
        pendingPromise = promise
        pendingRequest = code
        try {
            activity.startActivityForResult(intent, code)
        } catch (e: Exception) {
            pendingPromise = null
            promise.reject("PICKER_FAILED", e.message ?: "Could not open the picker", e)
        }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
        val promise = pendingPromise ?: return
        if (requestCode != pendingRequest) return
        pendingPromise = null
        if (resultCode != Activity.RESULT_OK || data == null) {
            promise.resolve(null)
            return
        }
        try {
            when (requestCode) {
                REQ_PICK_AUDIO -> {
                    val uris = ArrayList<Uri>()
                    data.clipData?.let { clip ->
                        for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(uris::add)
                    }
                    if (uris.isEmpty()) data.data?.let(uris::add)
                    val out = Arguments.createArray()
                    for (u in uris) out.pushMap(describeDocument(u, ""))
                    promise.resolve(out)
                }
                REQ_PICK_FOLDER -> {
                    val tree = data.data
                    if (tree == null) {
                        promise.resolve(null)
                        return
                    }
                    try {
                        resolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    } catch (_: Exception) {
                        // Some providers (Drive) do not hand out persistable grants; listing still works now.
                    }
                    val map = Arguments.createMap()
                    map.putString("uri", tree.toString())
                    map.putString("name", folderName(tree))
                    promise.resolve(map)
                }
                REQ_PICK_IMAGE, REQ_PICK_BOOK -> {
                    val uri = data.data
                    if (uri == null) promise.resolve(null) else promise.resolve(describeDocument(uri, ""))
                }
                else -> promise.resolve(null)
            }
        } catch (e: Exception) {
            promise.reject("PICKER_RESULT_FAILED", e.message ?: "Could not read the picker result", e)
        }
    }

    override fun onNewIntent(intent: Intent) {}

    // ─── Folder listing ─────────────────────────────────────────────────────

    /** Recursively lists the audio files under a tree URI returned by [pickFolder]. */
    @ReactMethod
    fun listFolder(treeUri: String, promise: Promise) {
        executor.execute {
            try {
                val tree = Uri.parse(treeUri)
                val rootId = try {
                    DocumentsContract.getTreeDocumentId(tree)
                } catch (e: Exception) {
                    DocumentsContract.getDocumentId(tree)
                }
                val out = Arguments.createArray()
                walk(tree, rootId, "", out, 0)
                promise.resolve(out)
            } catch (e: Exception) {
                promise.reject("LIST_FAILED", e.message ?: "Could not list the folder", e)
            }
        }
    }

    private fun walk(tree: Uri, docId: String, relative: String, out: WritableArray, depth: Int) {
        if (depth > MAX_DEPTH) return
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
        val projection = arrayOf(
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE
        )
        val cursor = resolver.query(children, projection, null, null, null) ?: return
        cursor.use { c ->
            while (c.moveToNext()) {
                val id = c.getString(0) ?: continue
                val name = c.getString(1) ?: ""
                val mime = c.getString(2) ?: ""
                val size = if (c.isNull(3)) -1L else c.getLong(3)
                if (mime == DocumentsContract.Document.MIME_TYPE_DIR) {
                    walk(tree, id, "$relative$name/", out, depth + 1)
                } else {
                    val kind = kindOf(name, mime)
                    if (kind == "other") continue
                    val uri = DocumentsContract.buildDocumentUriUsingTree(tree, id)
                    val map = Arguments.createMap()
                    map.putString("uri", uri.toString())
                    map.putString("name", name)
                    map.putString("mimeType", mime)
                    map.putDouble("size", size.toDouble())
                    map.putString("relativePath", relative)
                    map.putString("kind", kind)
                    out.pushMap(map)
                }
            }
        }
    }

    /** "audio" | "image" | "text" | "book" | "other" — extension wins over a provider's vague MIME type. */
    private fun kindOf(name: String, mime: String): String {
        val ext = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        if (ext.isNotEmpty()) {
            if (AUDIO_EXT.contains(ext)) return "audio"
            if (IMAGE_EXT.contains(ext)) return "image"
            if (TEXT_EXT.contains(ext)) return "text"
            if (BOOK_EXT.contains(ext)) return "book"
        }
        if (mime.startsWith("audio/")) return "audio"
        if (mime.startsWith("image/")) return "image"
        if (mime.startsWith("text/")) return "text"
        if (mime == BOOK_MIME) return "book"
        return "other"
    }

    // ─── Metadata ───────────────────────────────────────────────────────────

    /** Tags + duration for one audio document. Missing keys come back as null. */
    @ReactMethod
    fun readMetadata(uriString: String, promise: Promise) {
        executor.execute {
            val mmr = MediaMetadataRetriever()
            try {
                setSource(mmr, uriString)
                val map = Arguments.createMap()
                fun put(key: String, code: Int) {
                    val v = try { mmr.extractMetadata(code) } catch (_: Exception) { null }
                    if (v.isNullOrBlank()) map.putNull(key) else map.putString(key, v.trim())
                }
                put("title", MediaMetadataRetriever.METADATA_KEY_TITLE)
                put("artist", MediaMetadataRetriever.METADATA_KEY_ARTIST)
                put("album", MediaMetadataRetriever.METADATA_KEY_ALBUM)
                put("albumArtist", MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST)
                put("author", MediaMetadataRetriever.METADATA_KEY_AUTHOR)
                put("composer", MediaMetadataRetriever.METADATA_KEY_COMPOSER)
                put("writer", MediaMetadataRetriever.METADATA_KEY_WRITER)
                put("genre", MediaMetadataRetriever.METADATA_KEY_GENRE)
                put("year", MediaMetadataRetriever.METADATA_KEY_YEAR)
                put("date", MediaMetadataRetriever.METADATA_KEY_DATE)
                put("track", MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER)
                put("disc", MediaMetadataRetriever.METADATA_KEY_DISC_NUMBER)
                put("mimeType", MediaMetadataRetriever.METADATA_KEY_MIMETYPE)
                val duration = try {
                    mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toDoubleOrNull()
                } catch (_: Exception) { null }
                if (duration == null) map.putNull("durationMs") else map.putDouble("durationMs", duration)
                val hasCover = try { mmr.embeddedPicture != null } catch (_: Exception) { false }
                map.putBoolean("hasCover", hasCover)
                promise.resolve(map)
            } catch (e: Exception) {
                promise.reject("METADATA_FAILED", e.message ?: "Could not read the audio tags", e)
            } finally {
                try { mmr.release() } catch (_: Exception) {}
            }
        }
    }

    /**
     * Writes the picture embedded in the audio file to [destPath] as a JPEG no larger
     * than [maxSize] px on its long edge. Resolves false when the file has no picture.
     */
    @ReactMethod
    fun saveEmbeddedCover(uriString: String, destPath: String, maxSize: Double, promise: Promise) {
        executor.execute {
            val mmr = MediaMetadataRetriever()
            try {
                setSource(mmr, uriString)
                val bytes = mmr.embeddedPicture
                if (bytes == null) {
                    promise.resolve(false)
                    return@execute
                }
                val bitmap = decodeScaled({ bytes.inputStream() }, maxSize.toInt())
                if (bitmap == null) {
                    promise.resolve(false)
                    return@execute
                }
                writeJpeg(bitmap, destPath)
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("COVER_FAILED", e.message ?: "Could not save the embedded cover", e)
            } finally {
                try { mmr.release() } catch (_: Exception) {}
            }
        }
    }

    /** Re-encodes any picked image (content:// or file://) to a bounded JPEG at [destPath]. */
    @ReactMethod
    fun saveImage(uriString: String, destPath: String, maxSize: Double, promise: Promise) {
        executor.execute {
            try {
                val uri = Uri.parse(uriString)
                val bitmap = decodeScaled({ openStream(uri) }, maxSize.toInt())
                if (bitmap == null) {
                    promise.reject("IMAGE_FAILED", "The file is not a readable image")
                    return@execute
                }
                writeJpeg(bitmap, destPath)
                promise.resolve(true)
            } catch (e: Exception) {
                promise.reject("IMAGE_FAILED", e.message ?: "Could not save the image", e)
            }
        }
    }

    // ─── Chapter markers (m4b / m4a) ─────────────────────────────────────────

    /** Random-access bytes of a document: a file through RandomAccessFile, a content:// through its descriptor. */
    private class ByteSource(private val channel: FileChannel, val size: Long, private val owner: Closeable) : Closeable {
        fun read(pos: Long, len: Int): ByteBuffer {
            val buf = ByteBuffer.allocate(len)
            var p = pos
            while (buf.hasRemaining()) {
                val n = channel.read(buf, p)
                if (n <= 0) break
                p += n
            }
            buf.flip()
            return buf
        }
        fun u8(pos: Long): Int = if (pos + 1 > size) 0 else read(pos, 1).get().toInt() and 0xff
        fun u16(pos: Long): Int = if (pos + 2 > size) 0 else read(pos, 2).short.toInt() and 0xffff
        fun u32(pos: Long): Long = if (pos + 4 > size) 0L else read(pos, 4).int.toLong() and 0xffffffffL
        fun u64(pos: Long): Long = if (pos + 8 > size) 0L else read(pos, 8).long
        fun type(pos: Long): String {
            if (pos + 4 > size) return ""
            val b = ByteArray(4)
            read(pos, 4).get(b)
            return String(b, Charsets.ISO_8859_1)
        }
        override fun close() {
            try { channel.close() } catch (_: Exception) {}
            try { owner.close() } catch (_: Exception) {}
        }
    }

    private fun openSource(uri: Uri): ByteSource {
        return when (uri.scheme) {
            null, "file" -> {
                val raf = RandomAccessFile(File(stripFileScheme(uri.toString())), "r")
                ByteSource(raf.channel, raf.length(), raf)
            }
            else -> {
                val pfd = resolver.openFileDescriptor(uri, "r") ?: throw IllegalStateException("Provider returned no descriptor")
                val fis = FileInputStream(pfd.fileDescriptor)
                val size = if (pfd.statSize > 0) pfd.statSize else fis.channel.size()
                ByteSource(fis.channel, size, Closeable { fis.close(); pfd.close() })
            }
        }
    }

    /** An MP4 box: its type and the bounds of its content. */
    private data class Box(val type: String, val start: Long, val end: Long)

    private fun boxes(src: ByteSource, start: Long, end: Long): List<Box> {
        val out = ArrayList<Box>()
        var pos = start
        var seen = 0
        while (pos + 8 <= end && seen < MAX_TOP_BOXES * 16) {
            var size = src.u32(pos)
            val type = src.type(pos + 4)
            var header = 8L
            if (size == 1L) { size = src.u64(pos + 8); header = 16 } else if (size == 0L) size = end - pos
            if (size < header) break
            // A `meta` box carries a version/flags word before its children.
            out.add(Box(type, pos + header + (if (type == "meta") 4 else 0), minOf(pos + size, end)))
            pos += size
            seen++
        }
        return out
    }

    private fun find(src: ByteSource, start: Long, end: Long, path: List<String>): List<Box> {
        val here = boxes(src, start, end).filter { it.type == path[0] }
        if (path.size == 1) return here
        return here.flatMap { find(src, it.start, it.end, path.drop(1)) }
    }

    private data class Chapter(val startMs: Long, val title: String)

    /** Nero chapters: moov/udta/chpl — version, [reserved], count, then (start in 100 ns, length, UTF-8 title). */
    private fun chaptersFromChpl(src: ByteSource, chpl: Box): List<Chapter> {
        val version = src.u8(chpl.start)
        var pos = chpl.start + 4
        if (version == 1) pos += 4
        val count = src.u8(pos)
        pos += 1
        val out = ArrayList<Chapter>()
        for (i in 0 until count) {
            if (pos + 9 > chpl.end) break
            val start100ns = src.u64(pos)
            val len = src.u8(pos + 8)
            val bytes = ByteArray(len)
            src.read(pos + 9, len).get(bytes)
            out.add(Chapter(start100ns / 10_000, String(bytes, Charsets.UTF_8)))
            pos += 9 + len
        }
        return out
    }

    /** QuickTime chapters: a `text` track whose samples are (length, UTF-8 title), timed by its sample tables. */
    private fun chaptersFromTextTrack(src: ByteSource, moov: Box): List<Chapter> {
        for (trak in find(src, moov.start, moov.end, listOf("trak"))) {
            val hdlr = find(src, trak.start, trak.end, listOf("mdia", "hdlr")).firstOrNull() ?: continue
            val handler = src.type(hdlr.start + 8)
            if (handler != "text" && handler != "sbtl") continue
            val mdhd = find(src, trak.start, trak.end, listOf("mdia", "mdhd")).firstOrNull() ?: continue
            val timescale = src.u32(mdhd.start + if (src.u8(mdhd.start) == 1) 20 else 12).toDouble()
            if (timescale <= 0) continue
            val stbl = find(src, trak.start, trak.end, listOf("mdia", "minf", "stbl")).firstOrNull() ?: continue
            fun box(name: String) = find(src, stbl.start, stbl.end, listOf(name)).firstOrNull()
            val stts = box("stts") ?: continue
            val stsz = box("stsz") ?: continue
            val stsc = box("stsc") ?: continue
            val co64 = box("co64")
            val chunkBox = co64 ?: box("stco") ?: continue

            val durations = ArrayList<Long>()
            val nStts = src.u32(stts.start + 4).toInt()
            for (i in 0 until nStts) {
                val c = src.u32(stts.start + 8 + i * 8L).toInt()
                val d = src.u32(stts.start + 12 + i * 8L)
                repeat(minOf(c, 10_000)) { durations.add(d) }
            }
            val sampleSize = src.u32(stsz.start + 4)
            val count = minOf(src.u32(stsz.start + 8).toInt(), 10_000)
            val sizes = if (sampleSize != 0L) List(count) { sampleSize } else List(count) { src.u32(stsz.start + 12 + it * 4L) }
            val nChunks = minOf(src.u32(chunkBox.start + 4).toInt(), 10_000)
            val offsets = List(nChunks) { if (co64 != null) src.u64(chunkBox.start + 8 + it * 8L) else src.u32(chunkBox.start + 8 + it * 4L) }
            val nRuns = minOf(src.u32(stsc.start + 4).toInt(), 10_000)
            val runs = List(nRuns) { Pair(src.u32(stsc.start + 8 + it * 12L).toInt(), src.u32(stsc.start + 12 + it * 12L).toInt()) }

            val out = ArrayList<Chapter>()
            var t = 0L
            var si = 0
            for ((ri, run) in runs.withIndex()) {
                val (firstChunk, perChunk) = run
                val lastChunk = if (ri + 1 < runs.size) runs[ri + 1].first - 1 else nChunks
                for (ci in (firstChunk - 1) until lastChunk) {
                    if (ci < 0 || ci >= offsets.size) break
                    var off = offsets[ci]
                    for (k in 0 until perChunk) {
                        if (si >= count) break
                        val len = src.u16(off)
                        val bytes = ByteArray(len)
                        src.read(off + 2, len).get(bytes)
                        out.add(Chapter((t * 1000.0 / timescale).toLong(), String(bytes, Charsets.UTF_8)))
                        t += if (si < durations.size) durations[si] else 0L
                        off += sizes[si]
                        si++
                    }
                }
            }
            if (out.isNotEmpty()) return out
        }
        return emptyList()
    }

    private fun movieDurationMs(src: ByteSource, moov: Box): Long {
        val mvhd = find(src, moov.start, moov.end, listOf("mvhd")).firstOrNull() ?: return 0
        return if (src.u8(mvhd.start) == 1) {
            val ts = src.u32(mvhd.start + 20)
            val d = src.u64(mvhd.start + 24)
            if (ts > 0) d * 1000 / ts else 0
        } else {
            val ts = src.u32(mvhd.start + 12)
            val d = src.u32(mvhd.start + 16)
            if (ts > 0) d * 1000 / ts else 0
        }
    }

    /**
     * The chapter markers inside an MP4-family audio file (m4b, m4a, mp4):
     * `[{startMs, endMs, title}]`, in order; an empty array when there are none
     * or the file is not MP4. Nero `chpl` first, the QuickTime text track otherwise.
     */
    @ReactMethod
    fun readChapters(uriString: String, promise: Promise) {
        executor.execute {
            var src: ByteSource? = null
            try {
                src = openSource(Uri.parse(uriString))
                val out = Arguments.createArray()
                if (src.type(4) != "ftyp") {
                    promise.resolve(out)
                    return@execute
                }
                val moov = find(src, 0, src.size, listOf("moov")).firstOrNull()
                if (moov == null) {
                    promise.resolve(out)
                    return@execute
                }
                val chpl = find(src, moov.start, moov.end, listOf("udta", "chpl")).firstOrNull()
                var chapters = if (chpl != null) chaptersFromChpl(src, chpl) else emptyList()
                if (chapters.isEmpty()) chapters = chaptersFromTextTrack(src, moov)
                val total = movieDurationMs(src, moov)
                chapters.forEachIndexed { i, ch ->
                    val next = if (i + 1 < chapters.size) chapters[i + 1].startMs else total
                    val map = Arguments.createMap()
                    map.putDouble("startMs", ch.startMs.toDouble())
                    map.putDouble("endMs", maxOf(next, ch.startMs).toDouble())
                    map.putString("title", ch.title.trim())
                    out.pushMap(map)
                }
                promise.resolve(out)
            } catch (e: Exception) {
                promise.reject("CHAPTERS_FAILED", e.message ?: "Could not read the chapter markers", e)
            } finally {
                try { src?.close() } catch (_: Exception) {}
            }
        }
    }

    /**
     * Cuts the audio track of one file into one file per chapter without re-encoding:
     * MediaExtractor hands over the compressed samples, MediaMuxer writes them into a
     * fresh MP4 (.m4a) with times rebased to the chapter's start. `chapters` =
     * [{startMs, endMs, name}] where `name` is the destination file name inside
     * [destDir]. Resolves `[{index, path, durationMs}]`; progress events carry the
     * bytes written against the source's size under [jobId]. A chapter with no
     * samples (a zero-length marker) is skipped.
     */
    @ReactMethod
    fun splitAudio(uriString: String, destDir: String, chapters: ReadableArray, jobId: String, promise: Promise) {
        executor.execute {
            val extractor = MediaExtractor()
            var muxer: MediaMuxer? = null
            var currentPath: String? = null
            try {
                val uri = Uri.parse(uriString)
                when (uri.scheme) {
                    null, "file" -> extractor.setDataSource(stripFileScheme(uriString))
                    else -> extractor.setDataSource(reactApplicationContext, uri, null)
                }
                var audioTrack = -1
                var format: MediaFormat? = null
                for (i in 0 until extractor.trackCount) {
                    val f = extractor.getTrackFormat(i)
                    if ((f.getString(MediaFormat.KEY_MIME) ?: "").startsWith("audio/")) { audioTrack = i; format = f; break }
                }
                if (audioTrack < 0 || format == null) throw IllegalStateException("No audio track in the file")
                val fmt: MediaFormat = format
                extractor.selectTrack(audioTrack)
                val maxInput = if (fmt.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) fmt.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) else 0
                val buffer = ByteBuffer.allocate(maxOf(maxInput, 1 shl 20))
                val info = MediaCodec.BufferInfo()
                val total = documentSize(uri)
                var written = 0L
                var lastEmit = 0L
                val dir = File(stripFileScheme(destDir))
                dir.mkdirs()
                val out = Arguments.createArray()

                for (i in 0 until chapters.size()) {
                    val ch = chapters.getMap(i) ?: continue
                    val startUs = (ch.getDouble("startMs") * 1000).toLong()
                    val endUs = (ch.getDouble("endMs") * 1000).toLong()
                    val name = ch.getString("name") ?: "chapter-${i + 1}.m4a"
                    val dest = File(dir, name)
                    currentPath = dest.absolutePath
                    if (dest.exists()) dest.delete()
                    val mx = MediaMuxer(dest.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                    muxer = mx
                    val track = mx.addTrack(fmt)
                    mx.start()
                    extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
                    var lastPts = -1L
                    while (true) {
                        val pts = extractor.sampleTime
                        if (pts < 0 || pts >= endUs) break
                        val size = extractor.readSampleData(buffer, 0)
                        if (size < 0) break
                        if (pts >= startUs) {
                            var rel = pts - startUs
                            if (rel <= lastPts) rel = lastPts + 1
                            val sync = (extractor.sampleFlags and MediaExtractor.SAMPLE_FLAG_SYNC) != 0
                            info.set(0, size, rel, if (sync) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
                            mx.writeSampleData(track, buffer, info)
                            lastPts = rel
                            written += size
                        }
                        if (!extractor.advance()) break
                        val now = System.currentTimeMillis()
                        if (now - lastEmit > 250) {
                            lastEmit = now
                            emitProgress(jobId, written, total)
                        }
                    }
                    if (lastPts < 0) {
                        try { mx.release() } catch (_: Exception) {}
                        muxer = null
                        dest.delete()
                        currentPath = null
                        continue
                    }
                    mx.stop()
                    mx.release()
                    muxer = null
                    currentPath = null
                    val map = Arguments.createMap()
                    map.putInt("index", i)
                    map.putString("path", dest.absolutePath)
                    map.putDouble("durationMs", ((endUs - startUs) / 1000).toDouble())
                    out.pushMap(map)
                }
                emitProgress(jobId, total, total)
                promise.resolve(out)
            } catch (e: Exception) {
                try { muxer?.release() } catch (_: Exception) {}
                currentPath?.let { try { File(it).delete() } catch (_: Exception) {} }
                promise.reject("SPLIT_FAILED", e.message ?: "Could not split the file", e)
            } finally {
                try { extractor.release() } catch (_: Exception) {}
            }
        }
    }

    /** Five-minute upload pieces for the optional MAI comparison. MP3 frames
     * stay MP3; AAC is remuxed to M4A. No lossy decode/re-encode is needed. */
    @ReactMethod
    fun splitPodcastChunks(uriString: String, destDir: String, fallbackDurationMs: Double, promise: Promise) {
        executor.execute {
            val extractor = MediaExtractor()
            try {
                val uri = Uri.parse(uriString)
                if (uri.scheme == null || uri.scheme == "file") extractor.setDataSource(stripFileScheme(uriString))
                else extractor.setDataSource(reactApplicationContext, uri, null)
                var track = -1
                var format: MediaFormat? = null
                for (i in 0 until extractor.trackCount) {
                    val candidate = extractor.getTrackFormat(i)
                    if ((candidate.getString(MediaFormat.KEY_MIME) ?: "").startsWith("audio/")) {
                        track = i; format = candidate; break
                    }
                }
                if (track < 0 || format == null) throw IllegalStateException("No audio track")
                val fmt = format
                val mime = fmt.getString(MediaFormat.KEY_MIME) ?: ""
                val mp3 = mime == "audio/mpeg"
                if (!mp3 && mime != "audio/mp4a-latm") {
                    throw IllegalStateException("MAI test currently supports MP3 and AAC podcasts; this file uses $mime")
                }
                val durationUs = if (fmt.containsKey(MediaFormat.KEY_DURATION)) fmt.getLong(MediaFormat.KEY_DURATION)
                    else (fallbackDurationMs * 1000).toLong()
                if (durationUs <= 0) throw IllegalStateException("Could not determine audio duration")
                extractor.selectTrack(track)
                val dir = File(stripFileScheme(destDir))
                dir.mkdirs()
                val output = Arguments.createArray()
                val chunkUs = 5L * 60L * 1_000_000L
                val buffer = ByteBuffer.allocate(maxOf(
                    if (fmt.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) fmt.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE) else 0,
                    1 shl 20
                ))
                var startUs = 0L
                var index = 0
                while (startUs < durationUs) {
                    val endUs = minOf(durationUs, startUs + chunkUs)
                    val file = File(dir, "mai-${index}.${if (mp3) "mp3" else "m4a"}")
                    var stream: FileOutputStream? = null
                    var muxer: MediaMuxer? = null
                    try {
                        extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
                        if (mp3) stream = FileOutputStream(file)
                        else {
                            muxer = MediaMuxer(file.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                            muxer.addTrack(fmt)
                            muxer.start()
                        }
                        var firstPts = -1L
                        var lastPts = -1L
                        val info = MediaCodec.BufferInfo()
                        while (true) {
                            val pts = extractor.sampleTime
                            if (pts < 0 || pts >= endUs) break
                            val size = extractor.readSampleData(buffer, 0)
                            if (size < 0) break
                            if (pts >= startUs) {
                                if (firstPts < 0) firstPts = pts
                                if (mp3) {
                                    val bytes = ByteArray(size)
                                    buffer.position(0)
                                    buffer.get(bytes)
                                    stream!!.write(bytes)
                                } else {
                                    val rel = maxOf(lastPts + 1, pts - firstPts)
                                    info.set(0, size, rel, extractor.sampleFlags and MediaCodec.BUFFER_FLAG_KEY_FRAME)
                                    muxer!!.writeSampleData(0, buffer, info)
                                    lastPts = rel
                                }
                            }
                            if (!extractor.advance()) break
                        }
                        stream?.close()
                        if (firstPts >= 0) muxer?.stop()
                        muxer?.release()
                        if (firstPts < 0 || file.length() == 0L) {
                            file.delete()
                        } else {
                            val row = Arguments.createMap()
                            row.putString("path", file.absolutePath)
                            row.putString("format", if (mp3) "mp3" else "m4a")
                            row.putDouble("startMs", firstPts / 1000.0)
                            row.putDouble("endMs", endUs / 1000.0)
                            output.pushMap(row)
                        }
                    } catch (e: Exception) {
                        try { stream?.close() } catch (_: Exception) {}
                        try { muxer?.release() } catch (_: Exception) {}
                        file.delete()
                        throw e
                    }
                    startUs = endUs
                    index++
                }
                if (output.size() == 0) throw IllegalStateException("No audio samples found")
                promise.resolve(output)
            } catch (e: Exception) {
                promise.reject("MAI_SPLIT_FAILED", e.message ?: "Could not prepare podcast audio", e)
            } finally {
                try { extractor.release() } catch (_: Exception) {}
            }
        }
    }

    // ─── Where the reader pauses ─────────────────────────────────────────────

    /**
     * Decodes the audio (no speech model, just PCM) and reports every pause:
     * `{ durationMs, floorDb, speechStartMs, speechEndMs, silences: [{startMs, endMs}] }`.
     *
     * A narrator stops between paragraphs and, more briefly, between sentences,
     * so these pauses are landmarks the book's own paragraph and sentence ends
     * can be pinned to (services/bookSilence.js) — which is what gives an
     * imported audiobook's text the narration's timing at a fraction of the
     * cost of recognising the words. Options: `minSilenceMs` (default 220) and
     * `thresholdDb` above the noise floor (default 9). Progress events named
     * `AudioSilenceProgress` carry `{jobId, copied, total}` in milliseconds of
     * audio decoded.
     */
    @ReactMethod
    fun analyzeSilence(uriString: String, options: ReadableMap?, jobId: String, promise: Promise) {
        executor.execute {
            // A whole book is scanned chapter after chapter in the background
            // while someone listens to one of them; the decoder must give way
            // to playback and to the interface.
            val wasPriority = android.os.Process.getThreadPriority(android.os.Process.myTid())
            try { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND) } catch (_: Exception) {}
            val extractor = MediaExtractor()
            var codec: MediaCodec? = null
            try {
                val uri = Uri.parse(uriString)
                when (uri.scheme) {
                    null, "file" -> extractor.setDataSource(stripFileScheme(uriString))
                    else -> extractor.setDataSource(reactApplicationContext, uri, null)
                }
                var track = -1
                var format: MediaFormat? = null
                for (i in 0 until extractor.trackCount) {
                    val f = extractor.getTrackFormat(i)
                    if ((f.getString(MediaFormat.KEY_MIME) ?: "").startsWith("audio/")) { track = i; format = f; break }
                }
                val fmt = format ?: throw IllegalStateException("No audio track in the file")
                extractor.selectTrack(track)
                val totalUs = if (fmt.containsKey(MediaFormat.KEY_DURATION)) fmt.getLong(MediaFormat.KEY_DURATION) else 0L
                val minSilenceMs = options?.let { if (it.hasKey("minSilenceMs")) it.getDouble("minSilenceMs").toInt() else null } ?: DEFAULT_MIN_SILENCE_MS
                val thresholdDb = options?.let { if (it.hasKey("thresholdDb")) it.getDouble("thresholdDb") else null } ?: 9.0

                codec = MediaCodec.createDecoderByType(fmt.getString(MediaFormat.KEY_MIME)!!)
                codec.configure(fmt, null, null, 0)
                codec.start()

                var sampleRate = if (fmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)) fmt.getInteger(MediaFormat.KEY_SAMPLE_RATE) else 44100
                var channels = if (fmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) fmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else 1
                var pcmFloat = false

                // Mean square per FRAME_MS window, in decode order.
                val frames = ArrayList<Double>(4096)
                // Samples per FRAME_MS, counting every channel as its own.
                var framesPerWindow = maxOf(1, sampleRate * channels * FRAME_MS / 1000)
                var stride = maxOf(1, framesPerWindow / SAMPLES_PER_FRAME)
                var acc = 0.0
                var accCount = 0
                var taken = 0
                var shortScratch = ShortArray(0)
                var floatScratch = FloatArray(0)
                val info = MediaCodec.BufferInfo()
                var inputDone = false
                var lastEmit = 0L
                var decodedUs = 0L

                while (true) {
                    if (!inputDone) {
                        val inIndex = codec.dequeueInputBuffer(CODEC_TIMEOUT_US)
                        if (inIndex >= 0) {
                            val buf = codec.getInputBuffer(inIndex)
                            val size = if (buf == null) -1 else extractor.readSampleData(buf, 0)
                            if (size < 0) {
                                codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                inputDone = true
                            } else {
                                codec.queueInputBuffer(inIndex, 0, size, extractor.sampleTime, 0)
                                extractor.advance()
                            }
                        }
                    }
                    val outIndex = codec.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)
                    if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        val out = codec.outputFormat
                        if (out.containsKey(MediaFormat.KEY_SAMPLE_RATE)) sampleRate = out.getInteger(MediaFormat.KEY_SAMPLE_RATE)
                        if (out.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) channels = out.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
                        pcmFloat = out.containsKey(MediaFormat.KEY_PCM_ENCODING) &&
                            out.getInteger(MediaFormat.KEY_PCM_ENCODING) == android.media.AudioFormat.ENCODING_PCM_FLOAT
                        framesPerWindow = maxOf(1, sampleRate * channels * FRAME_MS / 1000)
                        stride = maxOf(1, framesPerWindow / SAMPLES_PER_FRAME)
                        continue
                    }
                    if (outIndex < 0) {
                        if (inputDone && outIndex == MediaCodec.INFO_TRY_AGAIN_LATER && info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                        if (outIndex == MediaCodec.INFO_TRY_AGAIN_LATER && inputDone && frames.isNotEmpty() && decodedUs > 0 && totalUs > 0 && decodedUs >= totalUs) break
                        continue
                    }
                    val out = codec.getOutputBuffer(outIndex)
                    if (out != null && info.size > 0) {
                        out.position(info.offset)
                        out.limit(info.offset + info.size)
                        // Copied out in bulk and read from a primitive array:
                        // going through the ByteBuffer one sample at a time
                        // dominated the decode. Loudness needs no more than a
                        // sample every so often, so long frames are thinned.
                        if (pcmFloat) {
                            val fb = out.asFloatBuffer()
                            val len = fb.limit()
                            if (floatScratch.size < len) floatScratch = FloatArray(len)
                            fb.get(floatScratch, 0, len)
                            var i = 0
                            while (i < len) {
                                val v = floatScratch[i].toDouble()
                                acc += v * v
                                taken++
                                i += stride
                                accCount += stride
                                if (accCount >= framesPerWindow) {
                                    frames.add(if (taken > 0) acc / taken else 0.0)
                                    acc = 0.0; accCount = 0; taken = 0
                                }
                            }
                        } else {
                            val sb = out.asShortBuffer()
                            val len = sb.limit()
                            if (shortScratch.size < len) shortScratch = ShortArray(len)
                            sb.get(shortScratch, 0, len)
                            var i = 0
                            while (i < len) {
                                val v = shortScratch[i] / 32768.0
                                acc += v * v
                                taken++
                                i += stride
                                accCount += stride
                                if (accCount >= framesPerWindow) {
                                    frames.add(if (taken > 0) acc / taken else 0.0)
                                    acc = 0.0; accCount = 0; taken = 0
                                }
                            }
                        }
                        decodedUs = info.presentationTimeUs
                    }
                    codec.releaseOutputBuffer(outIndex, false)
                    val now = System.currentTimeMillis()
                    if (now - lastEmit > 300) {
                        lastEmit = now
                        emitNamed(EVENT_SILENCE, jobId, decodedUs / 1000, totalUs / 1000)
                    }
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
                }
                if (taken > 0) frames.add(acc / taken)

                // The noise floor is what the quietest tenth of the file sounds
                // like (room tone, not digital silence), so the threshold rides
                // with the recording instead of a fixed number.
                val sorted = frames.toDoubleArray()
                sorted.sort()
                val floor = if (sorted.isEmpty()) 0.0 else sorted[(sorted.size * 0.10).toInt().coerceAtMost(sorted.size - 1)]
                val median = if (sorted.isEmpty()) 0.0 else sorted[sorted.size / 2]
                val floorDb = 10 * Math.log10(maxOf(floor, 1e-12))
                // Quiet means within thresholdDb of the floor, and always well under the median.
                val limit = maxOf(floor * Math.pow(10.0, thresholdDb / 10.0), median * 0.02).coerceAtMost(maxOf(median * 0.25, 1e-12))

                val minFrames = maxOf(1, minSilenceMs / FRAME_MS)
                val silences = Arguments.createArray()
                var run = 0
                var firstLoud = -1
                var lastLoud = -1
                for (i in frames.indices) {
                    val quiet = frames[i] <= limit
                    if (!quiet) {
                        if (firstLoud < 0) firstLoud = i
                        lastLoud = i
                    }
                    if (quiet) {
                        run++
                    } else {
                        if (run >= minFrames) {
                            val map = Arguments.createMap()
                            map.putDouble("startMs", ((i - run) * FRAME_MS).toDouble())
                            map.putDouble("endMs", (i * FRAME_MS).toDouble())
                            silences.pushMap(map)
                        }
                        run = 0
                    }
                }
                if (run >= minFrames) {
                    val map = Arguments.createMap()
                    map.putDouble("startMs", ((frames.size - run) * FRAME_MS).toDouble())
                    map.putDouble("endMs", (frames.size * FRAME_MS).toDouble())
                    silences.pushMap(map)
                }

                emitNamed(EVENT_SILENCE, jobId, (frames.size * FRAME_MS).toLong(), (frames.size * FRAME_MS).toLong())
                val result = Arguments.createMap()
                result.putDouble("durationMs", (frames.size * FRAME_MS).toDouble())
                result.putDouble("floorDb", if (floorDb.isFinite()) floorDb else -120.0)
                result.putDouble("speechStartMs", (maxOf(firstLoud, 0) * FRAME_MS).toDouble())
                result.putDouble("speechEndMs", ((if (lastLoud >= 0) lastLoud + 1 else frames.size) * FRAME_MS).toDouble())
                result.putArray("silences", silences)
                promise.resolve(result)
            } catch (e: Exception) {
                promise.reject("SILENCE_FAILED", e.message ?: "Could not read the audio", e)
            } finally {
                try { codec?.stop() } catch (_: Exception) {}
                try { codec?.release() } catch (_: Exception) {}
                try { extractor.release() } catch (_: Exception) {}
                try { android.os.Process.setThreadPriority(wasPriority) } catch (_: Exception) {}
            }
        }
    }

    // ─── Copy ───────────────────────────────────────────────────────────────

    /**
     * Streams a document into [destPath]. Progress events named `AudioImportProgress`
     * carry `{jobId, copied, total}` (total is -1 when the provider does not know it).
     */
    @ReactMethod
    fun copyToFile(uriString: String, destPath: String, jobId: String, promise: Promise) {
        executor.execute {
            val dest = File(stripFileScheme(destPath))
            try {
                val uri = Uri.parse(uriString)
                val total = documentSize(uri)
                dest.parentFile?.mkdirs()
                val input = openStream(uri)
                var copied = 0L
                var lastEmit = 0L
                input.use { inp ->
                    FileOutputStream(dest).use { out ->
                        val buf = ByteArray(256 * 1024)
                        while (true) {
                            val n = inp.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            copied += n
                            val now = System.currentTimeMillis()
                            if (now - lastEmit > 250) {
                                lastEmit = now
                                emitProgress(jobId, copied, total)
                            }
                        }
                        out.flush()
                    }
                }
                emitProgress(jobId, copied, total)
                val map = Arguments.createMap()
                map.putDouble("size", copied.toDouble())
                map.putString("path", dest.absolutePath)
                promise.resolve(map)
            } catch (e: Exception) {
                try { dest.delete() } catch (_: Exception) {}
                promise.reject("COPY_FAILED", e.message ?: "Could not copy the file", e)
            }
        }
    }

    /** Reads a small text sidecar (.nfo, .txt) as UTF-8; anything past 256 KB is dropped. */
    @ReactMethod
    fun readText(uriString: String, promise: Promise) {
        executor.execute {
            try {
                val uri = Uri.parse(uriString)
                val bytes = openStream(uri).use { it.readNBytesCompat(MAX_TEXT_BYTES) }
                promise.resolve(decodeText(bytes))
            } catch (e: Exception) {
                promise.reject("READ_FAILED", e.message ?: "Could not read the file", e)
            }
        }
    }

    @ReactMethod
    fun addListener(eventName: String) {}

    @ReactMethod
    fun removeListeners(count: Int) {}

    // ─── Helpers ────────────────────────────────────────────────────────────

    private fun emitProgress(jobId: String, copied: Long, total: Long) = emitNamed(EVENT_PROGRESS, jobId, copied, total)

    private fun emitNamed(event: String, jobId: String, copied: Long, total: Long) {
        val ctx = reactApplicationContext
        if (!ctx.hasActiveReactInstance()) return
        val map = Arguments.createMap()
        map.putString("jobId", jobId)
        map.putDouble("copied", copied.toDouble())
        map.putDouble("total", total.toDouble())
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(event, map)
    }

    private fun setSource(mmr: MediaMetadataRetriever, uriString: String) {
        val uri = Uri.parse(uriString)
        when (uri.scheme) {
            null, "file" -> mmr.setDataSource(stripFileScheme(uriString))
            else -> mmr.setDataSource(reactApplicationContext, uri)
        }
    }

    private fun openStream(uri: Uri): InputStream {
        return when (uri.scheme) {
            null, "file" -> File(stripFileScheme(uri.toString())).inputStream()
            else -> resolver.openInputStream(uri) ?: throw IllegalStateException("Provider returned no stream")
        }
    }

    private fun InputStream.readNBytesCompat(limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(16 * 1024)
        var remaining = limit
        while (remaining > 0) {
            val n = read(buf, 0, minOf(buf.size, remaining))
            if (n < 0) break
            out.write(buf, 0, n)
            remaining -= n
        }
        return out.toByteArray()
    }

    /** UTF-8 when it decodes cleanly, otherwise the CP437/Latin-1 that old .nfo files use. */
    private fun decodeText(bytes: ByteArray): String {
        val stripped = if (bytes.size >= 3 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte() && bytes[2] == 0xBF.toByte())
            bytes.copyOfRange(3, bytes.size) else bytes
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
        return try {
            decoder.decode(java.nio.ByteBuffer.wrap(stripped)).toString()
        } catch (_: Exception) {
            val cs = try { java.nio.charset.Charset.forName("IBM437") } catch (_: Exception) { Charsets.ISO_8859_1 }
            String(stripped, cs)
        }
    }

    private fun stripFileScheme(path: String): String {
        if (!path.startsWith("file://")) return path
        return Uri.decode(path.removePrefix("file://"))
    }

    private fun documentSize(uri: Uri): Long {
        if (uri.scheme == null || uri.scheme == "file") {
            val f = File(stripFileScheme(uri.toString()))
            return if (f.exists()) f.length() else -1L
        }
        return try {
            resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else -1L
            } ?: -1L
        } catch (_: Exception) {
            -1L
        }
    }

    private fun describeDocument(uri: Uri, relative: String): WritableMap {
        var name: String? = null
        var size = -1L
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    name = c.getString(0)
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
        } catch (_: Exception) {
        }
        if (name.isNullOrBlank()) name = uri.lastPathSegment?.substringAfterLast('/') ?: "audio"
        val mime = try { resolver.getType(uri) } catch (_: Exception) { null } ?: ""
        val map = Arguments.createMap()
        map.putString("uri", uri.toString())
        map.putString("name", name)
        map.putString("mimeType", mime)
        map.putDouble("size", size.toDouble())
        map.putString("relativePath", relative)
        map.putString("kind", kindOf(name!!, mime))
        return map
    }

    private fun folderName(tree: Uri): String {
        val id = try { DocumentsContract.getTreeDocumentId(tree) } catch (_: Exception) { tree.lastPathSegment ?: "" }
        // Tree ids look like "primary:Audiobooks/Dune"; the last segment is the folder name.
        val tail = id.substringAfterLast(':').trimEnd('/').substringAfterLast('/')
        if (tail.isNotBlank()) return tail
        try {
            val doc = DocumentsContract.buildDocumentUriUsingTree(tree, id)
            resolver.query(doc, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) return c.getString(0) ?: "Folder"
            }
        } catch (_: Exception) {
        }
        return "Folder"
    }

    /** Decodes with inSampleSize so the long edge lands near [maxSize], then scales exactly. */
    private fun decodeScaled(open: () -> InputStream, maxSize: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        open().use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        val longEdge = maxOf(bounds.outWidth, bounds.outHeight)
        while (longEdge / (sample * 2) >= maxSize) sample *= 2
        val opts = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val decoded = open().use { BitmapFactory.decodeStream(it, null, opts) } ?: return null
        val edge = maxOf(decoded.width, decoded.height)
        if (edge <= maxSize) return decoded
        val scale = maxSize.toFloat() / edge
        val w = maxOf(1, Math.round(decoded.width * scale))
        val h = maxOf(1, Math.round(decoded.height * scale))
        val scaled = Bitmap.createScaledBitmap(decoded, w, h, true)
        if (scaled !== decoded) decoded.recycle()
        return scaled
    }

    private fun writeJpeg(bitmap: Bitmap, destPath: String) {
        val dest = File(stripFileScheme(destPath))
        dest.parentFile?.mkdirs()
        FileOutputStream(dest).use { out ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, 88, out)
            out.flush()
        }
        bitmap.recycle()
    }
}
