package app.vela.shell

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/** Finding and opening the Meta AI app, plus a tiny remote log to the app server for field bugs. */
object MetaAi {
  /** Package names DAT itself looks for (from the mwdat-core manifest <queries>). */
  val PACKAGES = listOf("com.facebook.stella", "com.facebook.stella_debug")
  /** DAT 1.0.1 needs Meta AI V292 or newer. */
  const val MIN_MAJOR = 292

  data class Info(val pkg: String, val versionName: String?, val versionCode: Long, val launchable: Boolean) {
    val major: Int? get() = versionName?.let { Regex("^\\D*(\\d+)").find(it)?.groupValues?.get(1)?.toIntOrNull() }
    fun json() = JSONObject().put("package", pkg).put("versionName", versionName ?: JSONObject.NULL)
        .put("versionCode", versionCode).put("launchable", launchable)
  }

  fun find(ctx: Context): Info? {
    for (p in PACKAGES) {
      try {
        val pi = ctx.packageManager.getPackageInfo(p, 0)
        val launch = ctx.packageManager.getLaunchIntentForPackage(p) != null
        return Info(p, pi.versionName, pi.longVersionCode, launch)
      } catch (_: Exception) {}
    }
    return null
  }

  fun openApp(a: Activity): Boolean {
    val pkg = find(a)?.pkg ?: return openStore(a)
    val i = a.packageManager.getLaunchIntentForPackage(pkg) ?: return openSettings(a)
    return start(a, i)
  }

  /** Android's app-info page for Meta AI (permissions, battery, "open by default"). */
  fun openSettings(a: Activity): Boolean {
    val pkg = find(a)?.pkg ?: return openStore(a)
    return start(a, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg")))
  }

  fun openStore(a: Activity): Boolean =
      start(a, Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=${PACKAGES[0]}"))) ||
          start(a, Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=${PACKAGES[0]}")))

  private fun start(a: Activity, i: Intent): Boolean = try {
    a.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); true
  } catch (e: Exception) { Log.w("VelaMetaAi", "start $i", e); false }

  fun device(): JSONObject = JSONObject().put("maker", Build.MANUFACTURER).put("model", Build.MODEL)
      .put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT)
      .put("shell", BuildConfig.VERSION_NAME)

  /**
   * POSTs one event to the app's /log endpoint, using the token already present in the app URL (?k=).
   * Never throws; never sends images.
   */
  suspend fun remoteLog(appUrl: String, type: String, data: JSONObject) = withContext(Dispatchers.IO) {
    try {
      val u = Uri.parse(appUrl)
      val token = u.getQueryParameter("k") ?: return@withContext
      val ev = JSONObject(data.toString()).put("type", type).put("t", java.time.Instant.now().toString())
      val body = JSONObject().put("session", "shell").put("device", "glasses-shell").put("events", JSONArray().put(ev))
      val c = URL("${Urls.originOf(appUrl)}/log").openConnection() as HttpURLConnection
      c.requestMethod = "POST"; c.doOutput = true; c.connectTimeout = 5000; c.readTimeout = 5000
      c.setRequestProperty("content-type", "application/json")
      c.setRequestProperty("x-vela-token", token)
      c.outputStream.use { it.write(body.toString().toByteArray()) }
      Log.i("VelaMetaAi", "remote log $type -> ${c.responseCode}")
      c.disconnect()
    } catch (e: Exception) { Log.w("VelaMetaAi", "remote log failed", e) }
  }
}
