package com.podink.app

import android.app.Activity
import android.content.Intent
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Text shared *to* Podink (4.1.0): the manifest lists the app as a target for
 * ACTION_SEND text/plain, so YouTube's Share sheet — and any other app's —
 * can hand it a link. Three arrival paths:
 *
 *   cold start   the launching intent; JS asks with getInitialShare() once
 *                the database is ready
 *   running      onNewIntent (launchMode singleTask) → ShareIntentReceived
 *   activity     the process outlived its activity and a share created a new
 *   recreated    one: onHostResume sees the fresh intent → ShareIntentReceived
 *
 * Every intent is delivered once (identity hash), whichever path sees it
 * first; before JS has asked for the initial share nothing is emitted, so a
 * cold-start share cannot be lost to an event fired before JS listened.
 */
class ShareIntentModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext), ActivityEventListener, LifecycleEventListener {

    companion object {
        const val EVENT = "ShareIntentReceived"
    }

    private val delivered = HashSet<Int>()
    @Volatile private var jsReady = false

    init {
        reactContext.addActivityEventListener(this)
        reactContext.addLifecycleEventListener(this)
    }

    override fun getName() = "ShareIntent"

    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Double) {}

    /** The text the app was launched with, or null. Also arms the event path. */
    @ReactMethod
    fun getInitialShare(promise: Promise) {
        jsReady = true
        promise.resolve(take(reactApplicationContext.currentActivity?.intent))
    }

    override fun onNewIntent(intent: Intent) {
        reactApplicationContext.currentActivity?.intent = intent
        take(intent)?.let { emit(it) }
    }

    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {}

    override fun onHostResume() {
        if (!jsReady) return
        take(reactApplicationContext.currentActivity?.intent)?.let { emit(it) }
    }

    override fun onHostPause() {}
    override fun onHostDestroy() {}

    @Synchronized
    private fun take(intent: Intent?): String? {
        if (intent == null) return null
        val text = sharedText(intent) ?: return null
        val key = System.identityHashCode(intent)
        if (!delivered.add(key)) return null
        return text
    }

    private fun sharedText(intent: Intent): String? {
        if (intent.action != Intent.ACTION_SEND) return null
        if (intent.type?.startsWith("text/") != true) return null
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim()
        return if (text.isNullOrEmpty()) null else text
    }

    private fun emit(text: String) {
        val ctx = reactApplicationContext
        if (!ctx.hasActiveReactInstance()) return
        try {
            val map = Arguments.createMap()
            map.putString("text", text)
            ctx.getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(EVENT, map)
        } catch (_: Exception) {}
    }
}
