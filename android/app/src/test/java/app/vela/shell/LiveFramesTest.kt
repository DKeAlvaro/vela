package app.vela.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LiveFramesTest {
  private val w = 64; private val h = 48
  private fun frame(interleaved: Boolean): ByteArray {
    val y = ByteArray(w * h) { (it % 200).toByte() }
    val c = w * h / 4
    val chroma = if (interleaved) ByteArray(2 * c) { if (it % 2 == 0) 40 else (-56).toByte() } // U=40, V=200
    else ByteArray(2 * c) { if (it < c) 40 else (-56).toByte() }
    return y + chroma
  }

  @Test fun detectsLayout() {
    assertTrue(LiveFrames.looksInterleaved(frame(true), w, h))
    assertFalse(LiveFrames.looksInterleaved(frame(false), w, h))
  }

  @Test fun nv21IsVuOrder() {
    for (il in listOf(true, false)) {
      val out = LiveFrames.toNv21(frame(il), w, h, il)!!
      assertEquals((-56).toByte(), out[w * h]) // V first
      assertEquals(40.toByte(), out[w * h + 1])
    }
    assertNull(LiveFrames.toNv21(ByteArray(10), w, h, false))
  }

  @Test fun sharpnessPrefersEdges() {
    val flat = ByteArray(w * h) { 100 }
    val edges = ByteArray(w * h) { if ((it % w) % 2 == 0) 0 else -1 }
    assertTrue(LiveFrames.sharpness(edges, w, h) > LiveFrames.sharpness(flat, w, h))
  }

  @Test fun ringPicksSharpestFresh() {
    val r = LiveFrames.Ring(3)
    r.add(LiveFrames.Raw(ByteArray(0), 1, 1, 1000, 9.0))
    r.add(LiveFrames.Raw(ByteArray(0), 1, 1, 1500, 5.0))
    r.add(LiveFrames.Raw(ByteArray(0), 1, 1, 1600, 7.0))
    assertEquals(7.0, r.pick(1700, 300, false)!!.sharpness, 0.0)
    assertEquals(9.0, r.pick(1700, 1000, false)!!.sharpness, 0.0)
    assertEquals(1600L, r.pick(1700, 1000, true)!!.atMs)
    assertNull(r.pick(5000, 300, false))
  }
}

class LiveFramesNoRepeatTest {
  @Test fun neverSameFrameTwice() {
    val r = LiveFrames.Ring(3)
    r.add(LiveFrames.Raw(ByteArray(0), 1, 1, 1000, 9.0))
    r.add(LiveFrames.Raw(ByteArray(0), 1, 1, 1100, 5.0))
    val a = r.pick(1200, 700, false)!!
    assertEquals(1000L, a.atMs)
    assertEquals(1100L, r.pick(1200, 700, false, a.atMs)!!.atMs)
    assertNull(r.pick(1200, 700, false, 1100))
  }
}
