package app.vela.shell

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * Keeps Vela alive with the phone locked or another app in front: an ongoing notification
 * ("Vela is watching"), foreground-service types connectedDevice (the glasses over Bluetooth),
 * camera and microphone, plus a partial wake lock so the CPU keeps running for the DAT session,
 * the WebView's JS (face matching) and audio. Started from the activity while it is visible
 * (Android 14 only lets camera/mic foreground services start from the foreground).
 */
class WatchService : Service() {
  companion object {
    private const val TAG = "VelaWatch"
    private const val CHANNEL = "watch"
    private const val ID = 7
    @Volatile var active = false
      private set
    @Volatile var types = ""
      private set

    fun start(ctx: Context): Boolean = try {
      ContextCompat.startForegroundService(ctx, Intent(ctx, WatchService::class.java)); true
    } catch (e: Exception) { Log.w(TAG, "start", e); false }

    fun stop(ctx: Context) { ctx.stopService(Intent(ctx, WatchService::class.java)) }
  }

  private var wake: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(NotificationChannel(CHANNEL, "Vela watching", NotificationManager.IMPORTANCE_LOW).apply {
      description = "Shown while Vela keeps watch with the glasses"; setShowBadge(false)
    })
    val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
    val n: Notification = Notification.Builder(this, CHANNEL)
        .setSmallIcon(R.drawable.ic_stat)
        .setContentTitle("Vela is watching")
        .setContentText("Vela recognises the people you've introduced to her.")
        .setOngoing(true)
        .setContentIntent(open)
        .setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        .build()
    fun ok(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
    var t = 0; val names = mutableListOf<String>()
    if (ok(Manifest.permission.BLUETOOTH_CONNECT)) { t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE; names += "connectedDevice" }
    if (ok(Manifest.permission.CAMERA)) { t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA; names += "camera" }
    if (ok(Manifest.permission.RECORD_AUDIO)) { t = t or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE; names += "microphone" }
    try {
      startForeground(ID, n, t)
    } catch (e: Exception) {
      // Camera/mic types refused (e.g. started while not visible): keep at least the Bluetooth type.
      Log.w(TAG, "startForeground($names) refused; connectedDevice only", e)
      try { startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE); names.retainAll(listOf("connectedDevice")) }
      catch (e2: Exception) { Log.e(TAG, "startForeground failed", e2); stopSelf(); return START_NOT_STICKY }
    }
    types = names.joinToString("|")
    if (wake == null) {
      wake = getSystemService(PowerManager::class.java)
          .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Vela:watch").apply { acquire(12 * 60 * 60 * 1000L) }
    }
    active = true
    Log.i(TAG, "foreground: $types")
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    active = false; types = ""
    wake?.let { if (it.isHeld) it.release() }
    wake = null
    super.onDestroy()
  }
}
