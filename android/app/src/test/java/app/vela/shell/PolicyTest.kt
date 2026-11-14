package app.vela.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PolicyTest {
  private val ready = SourceStatus(LinkState.READY)
  private val gone = SourceStatus(LinkState.DISCONNECTED, "disconnected", "The glasses disconnected.")
  private val phoneIdle = SourceStatus()

  @Test fun autoPrefersGlasses() {
    assertEquals(SourcePolicy.Choice.GLASSES, SourcePolicy.choose(SourcePref.AUTO, LinkState.READY, true))
  }

  @Test fun autoFallsBackToPhone() {
    assertEquals(SourcePolicy.Choice.PHONE, SourcePolicy.choose(SourcePref.AUTO, LinkState.DISCONNECTED, true))
    val s = SourcePolicy.overall(SourcePref.AUTO, gone, phoneIdle, true)
    assertEquals(LinkState.READY, s.state)
    assertEquals("disconnected", s.code) // the page can still say "glasses disconnected, using the phone"
  }

  @Test fun glassesOnlyReportsDisconnected() {
    assertEquals(SourcePolicy.Choice.NONE, SourcePolicy.choose(SourcePref.GLASSES, LinkState.DISCONNECTED, true))
    assertEquals(LinkState.DISCONNECTED, SourcePolicy.overall(SourcePref.GLASSES, gone, phoneIdle, true).state)
  }

  @Test fun glassesConnectingWithoutPhone() {
    val s = SourcePolicy.overall(SourcePref.AUTO, SourceStatus(LinkState.CONNECTING), phoneIdle, false)
    assertEquals(LinkState.CONNECTING, s.state)
  }

  @Test fun phoneErrorSurfaces() {
    val busy = SourceStatus(LinkState.ERROR, "busy", "The camera is busy in another app.")
    assertEquals("busy", SourcePolicy.overall(SourcePref.PHONE, gone, busy, true).code)
  }

  @Test fun noCameraAtAll() {
    val s = SourcePolicy.overall(SourcePref.PHONE, gone, phoneIdle, false)
    assertEquals(LinkState.ERROR, s.state)
    assertEquals("camera_permission", s.code)
  }

  @Test fun glassesReadyIsCleanReady() {
    val s = SourcePolicy.overall(SourcePref.AUTO, ready, phoneIdle, true)
    assertEquals(LinkState.READY, s.state); assertNull(s.code)
  }

  @Test fun prefParsing() {
    assertEquals(SourcePref.PHONE, SourcePref.parse("phone")); assertNull(SourcePref.parse("x"))
    assertEquals(CaptureMode.STREAM, CaptureMode.parse("stream")); assertNull(CaptureMode.parse(null))
  }

  @Test fun jpegSizing() {
    assertEquals(1280 to 960, JpegFrames.fit(4032, 3024, 1280))
    assertEquals(640 to 480, JpegFrames.fit(640, 480, 1280)) // never upscale
    assertEquals(720 to 1280, JpegFrames.fit(720, 1280, 1280))
    assertEquals(2, JpegFrames.sampleSize(4032, 3024, 1280))
    assertEquals(1, JpegFrames.sampleSize(1280, 960, 1280))
    assertTrue(JpegFrames.sampleSize(8000, 6000, 1000) >= 4)
  }

  @Test fun urlHelpers() {
    assertEquals("https://v.example/?k=1&device=glasses", Urls.withDevice("https://v.example/?k=1"))
    assertEquals("https://v.example/?device=glasses", Urls.withDevice("https://v.example/"))
    assertEquals("https://v.example/?k=1&device=glasses#x", Urls.withDevice("https://v.example/?k=1#x"))
    assertEquals("https://v.example/?device=phone", Urls.withDevice("https://v.example/?device=phone"))
  }
}
