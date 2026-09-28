package com.podink.app

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.view.WindowManager
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.UiThreadUtil

/**
 * Keeps the display on while a screen that is read rather than watched is up
 * (the Player's transcript). Replaces expo-keep-awake, whose manager lost the
 * screen for good (user, 2026-09-28, off USB — on USB the phone's "stay awake
 * while charging" hid it):
 *
 *   - deactivate() looks up the current activity *before* dropping the tag, so
 *     a release with no activity (the Player unmounting in the background)
 *     throws and strands the tag; from then on activate() sees a tag held and
 *     never adds the window flag again;
 *   - the flag lives on one Activity's window, and nothing puts it on the
 *     window of an activity recreated under a surviving JS instance.
 *
 * Here the wanted state is process-wide (the set of holders) and is applied
 * to every activity as it resumes, plus at once to the current one. Holding
 * and releasing only edit the set, so they cannot fail or leak.
 */
class ScreenAwakeModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

    companion object {
        private val holders = HashSet<String>()
        private var callbacksRegistered = false

        private fun apply(activity: Activity?) {
            activity ?: return
            val on = synchronized(holders) { holders.isNotEmpty() }
            UiThreadUtil.runOnUiThread {
                if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
                if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }

        private fun register(app: Application) {
            if (callbacksRegistered) return
            callbacksRegistered = true
            app.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
                override fun onActivityResumed(activity: Activity) = apply(activity)
                override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
                override fun onActivityStarted(activity: Activity) {}
                override fun onActivityPaused(activity: Activity) {}
                override fun onActivityStopped(activity: Activity) {}
                override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
                override fun onActivityDestroyed(activity: Activity) {}
            })
        }
    }

    init {
        (reactContext.applicationContext as? Application)?.let { register(it) }
    }

    override fun getName() = "ScreenAwake"

    @ReactMethod
    fun hold(tag: String) {
        synchronized(holders) { holders.add(tag) }
        apply(reactApplicationContext.currentActivity)
    }

    @ReactMethod
    fun release(tag: String) {
        synchronized(holders) { holders.remove(tag) }
        apply(reactApplicationContext.currentActivity)
    }
}
