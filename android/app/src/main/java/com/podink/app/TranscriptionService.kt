package com.podink.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

class TranscriptionService : Service() {

    companion object {
        const val CHANNEL_ID      = "transcription_channel"
        const val NOTIFICATION_ID = 1001
        const val ACTION_START    = "START"
        const val ACTION_STOP     = "STOP"
        const val EXTRA_TITLE     = "title"
        const val EXTRA_MESSAGE   = "message"
        const val WAKE_LOCK_TAG   = "podink:transcription"
        const val WAKE_LOCK_TIMEOUT_MS = 60L * 60 * 1000 // 60 min max
    }

    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    private fun releaseWakeLock() {
        if (wakeLock?.isHeld == true) {
            wakeLock?.release()
        }
        wakeLock = null
    }

    private fun acquireWakeLock() {
        releaseWakeLock()
        val pm = getSystemService(PowerManager::class.java)
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).apply {
            acquire(WAKE_LOCK_TIMEOUT_MS)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            releaseWakeLock()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }

        // Guard: if Android restarted the service with a null intent (after being
        // killed) we stop immediately. The JS layer manages persistence via
        // AsyncStorage and will re-start the service when it's ready.
        if (intent == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        ensureNotificationChannel()

        val title   = intent.getStringExtra(EXTRA_TITLE)   ?: "Transcribing podcasts"
        val message = intent.getStringExtra(EXTRA_MESSAGE) ?: "Processing audio in background…"

        val openApp = Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
        }
        val pendingIntent = PendingIntent.getActivity(
            this, 0, openApp,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(message)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setSilent(true)
            .build()

        startForeground(NOTIFICATION_ID, notification)
        acquireWakeLock()

        // START_NOT_STICKY: if the system kills this service it will NOT be
        // restarted automatically. The JS layer handles re-queuing via
        // AsyncStorage on the next app launch, which is safer than letting
        // Android restart the service with a null intent while a stale native
        // Whisper context might still be alive in the process.
        return START_NOT_STICKY
    }

    /**
     * Called when the user swipes the app away from the recents screen.
     * We stop the foreground service so the persistent notification disappears
     * and the process can be cleaned up by the OS.
     * The JS queue is already persisted in AsyncStorage, so transcription will
     * resume from the beginning of the interrupted item on next launch.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Transcription",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Background podcast transcription"
                setShowBadge(false)
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }
}
