package app.vela.shell

/** Which camera the web app wants. */
enum class SourcePref(val wire: String) {
  AUTO("auto"), GLASSES("glasses"), PHONE("phone");
  companion object {
    fun parse(s: String?): SourcePref? = entries.firstOrNull { it.wire == s }
  }
}

/**
 * Pure decision logic (unit-tested): given what the web app asked for and the state of each
 * source, which one serves the next frame, and what overall state the bridge reports.
 */
object SourcePolicy {
  enum class Choice { GLASSES, PHONE, NONE }

  fun choose(pref: SourcePref, glasses: LinkState, phoneAllowed: Boolean): Choice = when (pref) {
    SourcePref.GLASSES -> if (glasses == LinkState.READY) Choice.GLASSES else Choice.NONE
    SourcePref.PHONE -> if (phoneAllowed) Choice.PHONE else Choice.NONE
    SourcePref.AUTO -> when {
      glasses == LinkState.READY -> Choice.GLASSES
      phoneAllowed -> Choice.PHONE
      else -> Choice.NONE
    }
  }

  /**
   * Overall bridge state. In AUTO the phone camera covers for missing glasses, so the bridge is
   * "ready" (with source = phone). In GLASSES-only mode a lost link is "disconnected".
   */
  fun overall(pref: SourcePref, glasses: SourceStatus, phone: SourceStatus, phoneAllowed: Boolean): SourceStatus {
    return when (choose(pref, glasses.state, phoneAllowed)) {
      Choice.GLASSES -> SourceStatus(LinkState.READY)
      Choice.PHONE -> when (phone.state) {
        LinkState.ERROR -> phone
        else -> SourceStatus(LinkState.READY, glasses.code, glasses.message)
      }
      Choice.NONE -> when {
        glasses.state == LinkState.CONNECTING -> SourceStatus(LinkState.CONNECTING, glasses.code, glasses.message)
        glasses.state == LinkState.ERROR -> glasses
        pref == SourcePref.PHONE -> SourceStatus(LinkState.ERROR, "camera_permission", "Camera permission is off.")
        glasses.state == LinkState.IDLE -> SourceStatus(LinkState.IDLE)
        else -> SourceStatus(LinkState.DISCONNECTED, glasses.code ?: "disconnected", glasses.message ?: "The glasses are not connected.")
      }
    }
  }
}
