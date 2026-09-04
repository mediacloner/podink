package com.podink.app

import android.app.Activity
import android.content.ContentResolver
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Local-audio import: system pickers (files, folder, image), audio tags through
 * MediaMetadataRetriever, embedded cover extraction and a progress-reporting copy
 * from any content:// or file:// URI into the app's own storage.
 *
 * Everything the JS side needs to turn a chosen audiobook into a local collection
 * lives here, so no extra Expo packages are required.
 */
class AudioImportModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener {

    companion object {
        private const val REQ_PICK_AUDIO = 41001
        private const val REQ_PICK_FOLDER = 41002
        private const val REQ_PICK_IMAGE = 41003
        private const val MAX_DEPTH = 8
        private const val EVENT_PROGRESS = "AudioImportProgress"

        private val AUDIO_EXT = setOf(
            "mp3", "m4a", "m4b", "aac", "ogg", "oga", "opus", "flac", "wav", "wma",
            "mp4", "3gp", "amr", "aiff", "aif", "mka", "webm", "mpga", "mp2", "ac3"
        )
        private val IMAGE_EXT = setOf("jpg", "jpeg", "png", "webp", "gif", "bmp")
        private val TEXT_EXT = setOf("nfo", "txt", "md", "cue", "json", "opf")
        // Chapters plus the sidecars an audiobook folder usually carries (cover art, .nfo notes).
        private val PICKER_MIME = arrayOf(
            "audio/*", "application/ogg", "application/x-ogg", "video/mp4", "application/octet-stream",
            "image/*", "text/*"
        )
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
                REQ_PICK_IMAGE -> {
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

    /** "audio" | "image" | "text" | "other" — extension wins over a provider's vague MIME type. */
    private fun kindOf(name: String, mime: String): String {
        val ext = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        if (ext.isNotEmpty()) {
            if (AUDIO_EXT.contains(ext)) return "audio"
            if (IMAGE_EXT.contains(ext)) return "image"
            if (TEXT_EXT.contains(ext)) return "text"
        }
        if (mime.startsWith("audio/")) return "audio"
        if (mime.startsWith("image/")) return "image"
        if (mime.startsWith("text/")) return "text"
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

    private fun emitProgress(jobId: String, copied: Long, total: Long) {
        val ctx = reactApplicationContext
        if (!ctx.hasActiveReactInstance()) return
        val map = Arguments.createMap()
        map.putString("jobId", jobId)
        map.putDouble("copied", copied.toDouble())
        map.putDouble("total", total.toDouble())
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT_PROGRESS, map)
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
