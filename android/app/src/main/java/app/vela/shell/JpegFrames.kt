package app.vela.shell

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.exifinterface.media.ExifInterface
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

/** Turns whatever a camera produced (JPEG/HEIC bytes or a Bitmap) into a small upright JPEG. */
object JpegFrames {
  const val QUALITY = 85

  /** Largest power-of-two sample size that keeps the long edge >= maxEdge. Pure, unit-tested. */
  fun sampleSize(width: Int, height: Int, maxEdge: Int): Int {
    var s = 1
    val long = maxOf(width, height)
    while (long / (s * 2) >= maxEdge) s *= 2
    return s
  }

  /** Target size after scaling the long edge down to maxEdge (never up). Pure, unit-tested. */
  fun fit(width: Int, height: Int, maxEdge: Int): Pair<Int, Int> {
    val long = maxOf(width, height)
    if (long <= maxEdge || long == 0) return width to height
    val k = maxEdge.toDouble() / long
    return maxOf(1, Math.round(width * k).toInt()) to maxOf(1, Math.round(height * k).toInt())
  }

  fun exifRotation(bytes: ByteArray): Int = try {
    when (ExifInterface(ByteArrayInputStream(bytes)).getAttributeInt(
        ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
      ExifInterface.ORIENTATION_ROTATE_90 -> 90
      ExifInterface.ORIENTATION_ROTATE_180 -> 180
      ExifInterface.ORIENTATION_ROTATE_270 -> 270
      else -> 0
    }
  } catch (_: Exception) { 0 }

  /** Encoded image bytes (JPEG or HEIC) -> upright JPEG with long edge <= maxEdge. */
  fun fromEncoded(bytes: ByteArray, maxEdge: Int, extraRotation: Int? = null): Triple<ByteArray, Int, Int> {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0) throw CaptureException("decode", "The photo could not be read.")
    val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, maxEdge) }
    val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
        ?: throw CaptureException("decode", "The photo could not be read.")
    return fromBitmap(bmp, maxEdge, extraRotation ?: exifRotation(bytes), recycle = true)
  }

  fun fromBitmap(src: Bitmap, maxEdge: Int, rotation: Int = 0, recycle: Boolean = false): Triple<ByteArray, Int, Int> {
    val (w, h) = fit(src.width, src.height, maxEdge)
    val m = Matrix()
    if (w != src.width || h != src.height) m.postScale(w.toFloat() / src.width, h.toFloat() / src.height)
    if (rotation % 360 != 0) m.postRotate(rotation.toFloat())
    val out = if (m.isIdentity) src else Bitmap.createBitmap(src, 0, 0, src.width, src.height, m, true)
    val bos = ByteArrayOutputStream(64 * 1024)
    out.compress(Bitmap.CompressFormat.JPEG, QUALITY, bos)
    val result = Triple(bos.toByteArray(), out.width, out.height)
    if (out !== src) out.recycle()
    if (recycle) src.recycle()
    return result
  }
}
