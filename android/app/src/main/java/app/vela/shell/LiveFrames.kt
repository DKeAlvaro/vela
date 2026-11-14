package app.vela.shell

import kotlin.math.abs

/**
 * Live mode: the glasses stream decoded YUV 4:2:0 frames (DAT decodes HEVC on the phone). We keep
 * the last few and answer a frame request from memory: no Bluetooth round trip per photo, so
 * enrollment gets a frame at once and watching gets steady, fresh frames. Among recent frames we
 * return the sharpest, which matters for faces (head turns, walking).
 *
 * Pure Kotlin (no Android types) so it is unit-tested.
 */
object LiveFrames {
  class Raw(val nv21: ByteArray, val width: Int, val height: Int, val atMs: Long, val sharpness: Double)

  /**
   * DAT doesn't document the YUV layout (I420 or NV12). In I420 the chroma area holds two smooth
   * planes, so neighbouring bytes are close; in NV12 it's U,V,U,V, so neighbours differ more than
   * bytes two apart. Wrong guesses only tint colours; luma (what face models mostly use) is right.
   */
  fun looksInterleaved(buf: ByteArray, w: Int, h: Int): Boolean {
    val start = w * h
    val n = minOf(w * h / 2, buf.size - start) - 2
    if (n < 64) return false
    var d1 = 0L; var d2 = 0L
    var i = 0
    val step = maxOf(1, n / 20_000)
    while (i < n) {
      val a = buf[start + i].toInt() and 0xff
      d1 += abs(a - (buf[start + i + 1].toInt() and 0xff))
      d2 += abs(a - (buf[start + i + 2].toInt() and 0xff))
      i += step
    }
    return d1 > d2 * 1.3 + 1
  }

  /**
   * Copies a tightly packed I420 or NV12 frame into NV21 (what android.graphics.YuvImage takes).
   * Returns null if the buffer is not a packed 4:2:0 frame of that size.
   */
  fun toNv21(src: ByteArray, w: Int, h: Int, interleaved: Boolean): ByteArray? {
    val ySize = w * h
    val cSize = ySize / 4
    if (w <= 0 || h <= 0 || src.size < ySize + 2 * cSize) return null
    val out = ByteArray(ySize + 2 * cSize)
    System.arraycopy(src, 0, out, 0, ySize)
    if (interleaved) { // NV12: U,V -> V,U
      var i = 0
      while (i < 2 * cSize) { out[ySize + i] = src[ySize + i + 1]; out[ySize + i + 1] = src[ySize + i]; i += 2 }
    } else { // I420: U plane, V plane -> V,U interleaved
      for (i in 0 until cSize) { out[ySize + 2 * i] = src[ySize + cSize + i]; out[ySize + 2 * i + 1] = src[ySize + i] }
    }
    return out
  }

  /** Cheap focus score: mean absolute Laplacian on a subsampled centre crop of the luma plane. */
  fun sharpness(y: ByteArray, w: Int, h: Int): Double {
    val x0 = w / 6; val x1 = w - w / 6; val y0 = h / 6; val y1 = h - h / 6
    val step = 3
    var sum = 0L; var n = 0
    var yy = y0 + step
    while (yy < y1 - step) {
      var xx = x0 + step
      val row = yy * w
      while (xx < x1 - step) {
        val c = (y[row + xx].toInt() and 0xff) * 4
        val l = (y[row + xx - 1].toInt() and 0xff) + (y[row + xx + 1].toInt() and 0xff) +
            (y[row - w + xx].toInt() and 0xff) + (y[row + w + xx].toInt() and 0xff)
        sum += abs(c - l); n++
        xx += step
      }
      yy += step
    }
    return if (n == 0) 0.0 else sum.toDouble() / n
  }

  /** Recent-frame buffer. Thread-safe. */
  class Ring(private val capacity: Int = 5) {
    private val frames = ArrayDeque<Raw>()
    @Volatile var lastAtMs = 0L
      private set
    var received = 0L
      private set

    @Synchronized fun add(f: Raw) {
      frames.addLast(f); received++; lastAtMs = f.atMs
      while (frames.size > capacity) frames.removeFirst()
    }

    @Synchronized fun clear() { frames.clear(); lastAtMs = 0L }

    /**
     * Sharpest frame no older than [maxAgeMs] and newer than [afterMs] (so back-to-back requests,
     * e.g. 3 enrollment photos, never get the same frame); `latest` returns the newest instead.
     */
    @Synchronized fun pick(nowMs: Long, maxAgeMs: Long, latest: Boolean, afterMs: Long = Long.MIN_VALUE): Raw? {
      val fresh = frames.filter { nowMs - it.atMs <= maxAgeMs && it.atMs > afterMs }
      if (fresh.isEmpty()) return null
      return if (latest) fresh.last() else fresh.maxByOrNull { it.sharpness }
    }
  }
}
