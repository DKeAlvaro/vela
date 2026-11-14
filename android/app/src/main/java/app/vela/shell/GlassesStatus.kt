package app.vela.shell

import org.json.JSONObject

/**
 * One plain answer to "are the glasses usable, and if not, what does the wearer do?" for the app's
 * onboarding step ("Your glasses"). Derived from the detailed glasses status; see BRIDGE.md.
 */
object GlassesStatus {
  data class View(val status: String, val action: String, val message: String) {
    fun json(): JSONObject = JSONObject().put("status", status).put("action", action).put("message", message)
  }

  private val UPDATE = setOf("glasses_app_update", "firmware_update", "sdk_update")
  private val NOT_NEARBY = setOf("no_device", "disconnected", "session_timeout", "session_failed")

  fun classify(state: LinkState, code: String?, message: String?, registration: String, initialized: Boolean): View {
    fun v(s: String, a: String, fallback: String) = View(s, a, message?.takeIf { it.isNotBlank() } ?: fallback)
    return when {
      state == LinkState.READY -> View("ready", "none", "The glasses are connected.")
      code == "sdk_init" || (!initialized && state != LinkState.IDLE) ->
        v("bluetooth_permission", "connect", "Allow Nearby devices for Vela so it can reach the glasses.")
      code == "not_registered" || code == "dwa_unavailable" || (initialized && registration != "registered" && registration != "unknown") ->
        View("not_registered", "connect", "Connect Vela to your glasses in the Meta AI app.")
      code in UPDATE -> v("update_required", "open_meta_ai",
          "The glasses need an update in the Meta AI app. Then restart the glasses.")
      code == "glasses_camera_permission" || code == "capability_denied" ->
        v("camera_permission", "connect", "Allow camera access for Vela in the Meta AI app.")
      code == "paused" -> v("paused", "none", "Put the glasses on and unfold them.")
      code in NOT_NEARBY -> v("not_nearby", "connect", "The glasses are not nearby or are switched off.")
      code == "too_warm" || code == "battery" -> v("resting", "none", "The glasses need a rest.")
      state == LinkState.CONNECTING -> v("connecting", "none", "Connecting to the glasses…")
      state == LinkState.IDLE -> View("not_connected", "connect", "Tap Connect to use your glasses.")
      else -> v("error", "connect", "The glasses reported a problem.")
    }
  }
}
