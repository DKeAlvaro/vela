package app.vela.shell

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import org.json.JSONObject

/**
 * The glasses are a normal Bluetooth headset for the phone (DAT docs, "Use device microphones
 * and speakers"): A2DP carries Vela's voice to the glasses' speakers in high quality; HFP/SCO
 * carries the glasses' (beamformed) mic. They are exclusive: while the mic is on HFP, the voice
 * drops to mono call quality. So by default we leave the mic on the phone and only switch to the
 * glasses' mic when the web app asks (e.g. listening for a "yes").
 */
class AudioRouter(context: Context, private val onEvent: (String, JSONObject) -> Unit = { _, _ -> }) {
  private val am = context.getSystemService(AudioManager::class.java)
  var micOnGlasses = false
    private set
  var lastFix: String? = null
    private set

  /**
   * Seen on hardware: a getUserMedia mic with platform AEC puts Android in MODE_IN_COMMUNICATION
   * with no communication device, so the earpiece becomes the route and Vela's voice is lost.
   * Whenever call mode appears and the earpiece (or nothing) is the communication device, pick
   * the glasses' Bluetooth SCO if present, else the loudspeaker. Never leave the earpiece.
   */
  private val main = java.util.concurrent.Executor { r -> android.os.Handler(android.os.Looper.getMainLooper()).post(r) }
  private val modeListener = AudioManager.OnModeChangedListener { guard("mode") }
  private val devListener = AudioManager.OnCommunicationDeviceChangedListener { guard("device") }
  private val outsCallback = object : android.media.AudioDeviceCallback() {
    override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) { guard("added") }
  }

  fun startGuard() {
    am.addOnModeChangedListener(main, modeListener)
    am.addOnCommunicationDeviceChangedListener(main, devListener)
    am.registerAudioDeviceCallback(outsCallback, android.os.Handler(android.os.Looper.getMainLooper()))
    guard("start")
  }

  /** Re-check now (e.g. Vela back in front after Meta AI or a call). */
  fun recheck() = guard("recheck")

  fun stopGuard() {
    runCatching { am.removeOnModeChangedListener(modeListener) }
    runCatching { am.removeOnCommunicationDeviceChangedListener(devListener) }
    runCatching { am.unregisterAudioDeviceCallback(outsCallback) }
  }

  private var weSet = false

  private fun guard(why: String) {
    if (am.mode == AudioManager.MODE_NORMAL) {
      // Call mode is over: undo our choice so it can't stick to the next one.
      if (weSet && !micOnGlasses) { runCatching { am.clearCommunicationDevice() }; weSet = false }
      return
    }
    if (am.mode != AudioManager.MODE_IN_COMMUNICATION && am.mode != AudioManager.MODE_IN_CALL) return
    if (am.mode == AudioManager.MODE_IN_CALL) return // a real phone call: not ours to touch
    val cur = am.communicationDevice
    if (cur != null && cur.type != AudioDeviceInfo.TYPE_BUILTIN_EARPIECE) return
    val avail = am.availableCommunicationDevices
    val pick = avail.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET }
        ?: avail.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
        ?: return
    val ok = runCatching { am.setCommunicationDevice(pick) }.getOrDefault(false)
    weSet = weSet || ok
    lastFix = "${typeName(cur?.type)} -> ${typeName(pick.type)} ($why, ok=$ok)"
    android.util.Log.w("VelaAudio", "call mode on earpiece: $lastFix")
    onEvent("audio.reroute", JSONObject().put("from", typeName(cur?.type)).put("to", typeName(pick.type))
        .put("name", pick.productName?.toString() ?: JSONObject.NULL).put("why", why).put("ok", ok))
  }

  private fun typeName(t: Int?) = when (t) {
    null -> "none"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "glasses_sco"
    AudioDeviceInfo.TYPE_BLE_HEADSET -> "ble_headset"
    else -> "type$t"
  }

  private fun isBt(t: Int) = t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
      t == AudioDeviceInfo.TYPE_BLE_HEADSET || t == AudioDeviceInfo.TYPE_BLE_SPEAKER

  fun describe(): JSONObject {
    val outs = am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
    val ins = am.getDevices(AudioManager.GET_DEVICES_INPUTS)
    val btOut = outs.firstOrNull { isBt(it.type) }
    val sco = am.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
    return JSONObject()
        .put("output", if (btOut != null) "glasses" else "phone")
        .put("outputName", btOut?.productName?.toString() ?: JSONObject.NULL)
        .put("glassesMicAvailable", sco != null || ins.any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO })
        .put("input", if (micOnGlasses) "glasses" else "phone")
        .put("mode", when (am.mode) { AudioManager.MODE_IN_COMMUNICATION -> "communication"; else -> "normal" })
        .put("communicationDevice", typeName(am.communicationDevice?.type))
        .put("lastFix", lastFix ?: JSONObject.NULL)
  }

  /** Route getUserMedia's mic to the glasses (HFP) or back to the phone. Returns the new route. */
  fun setMic(glasses: Boolean): JSONObject {
    if (glasses) {
      val sco = am.availableCommunicationDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
      if (sco != null) {
        am.mode = AudioManager.MODE_IN_COMMUNICATION
        micOnGlasses = am.setCommunicationDevice(sco)
      } else micOnGlasses = false
    } else {
      am.clearCommunicationDevice()
      am.mode = AudioManager.MODE_NORMAL
      micOnGlasses = false
      guard("mic_phone") // if Chromium still holds call mode, keep the earpiece out
    }
    return describe()
  }
}
