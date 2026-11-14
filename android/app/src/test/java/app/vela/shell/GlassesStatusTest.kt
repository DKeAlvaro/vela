package app.vela.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class GlassesStatusTest {
  private fun st(state: LinkState, code: String?, reg: String = "registered", init: Boolean = true) =
      GlassesStatus.classify(state, code, null, reg, init)

  @Test fun ready() = assertEquals("ready", st(LinkState.READY, null).status)
  @Test fun notRegistered() {
    assertEquals("not_registered", st(LinkState.DISCONNECTED, "not_registered", "available").status)
    assertEquals("connect", st(LinkState.IDLE, null, "available").action)
  }
  @Test fun updateWinsOverTimeout() {
    val v = st(LinkState.ERROR, "glasses_app_update")
    assertEquals("update_required", v.status); assertEquals("open_meta_ai", v.action)
  }
  @Test fun notNearby() = assertEquals("not_nearby", st(LinkState.DISCONNECTED, "session_timeout").status)
  @Test fun cameraPermission() = assertEquals("camera_permission", st(LinkState.ERROR, "glasses_camera_permission").status)
  @Test fun bluetooth() = assertEquals("bluetooth_permission", st(LinkState.ERROR, "sdk_init", "unknown", false).status)
  @Test fun idle() = assertEquals("not_connected", st(LinkState.IDLE, null).status)
  @Test fun paused() = assertEquals("paused", st(LinkState.CONNECTING, "paused").status)
}
