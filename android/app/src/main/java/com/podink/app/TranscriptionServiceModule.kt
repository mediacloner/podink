package com.podink.app

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class TranscriptionServiceModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "TranscriptionService"

    @ReactMethod
    fun start(title: String, message: String) {
        val ctx = reactApplicationContext
        val intent = Intent(ctx, TranscriptionService::class.java).apply {
            action = TranscriptionService.ACTION_START
            putExtra(TranscriptionService.EXTRA_TITLE, title)
            putExtra(TranscriptionService.EXTRA_MESSAGE, message)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ctx.startForegroundService(intent)
        } else {
            ctx.startService(intent)
        }
    }

    @ReactMethod
    fun requestBatteryExemption() {
        val ctx = reactApplicationContext
        val pm = ctx.getSystemService(PowerManager::class.java) ?: return
        if (!pm.isIgnoringBatteryOptimizations(ctx.packageName)) {
            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                data = Uri.parse("package:${ctx.packageName}")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            ctx.startActivity(intent)
        }
    }

    @ReactMethod
    fun stop() {
        val ctx = reactApplicationContext
        val intent = Intent(ctx, TranscriptionService::class.java).apply {
            action = TranscriptionService.ACTION_STOP
        }
        ctx.startService(intent)
    }
}
