package app.vela.shell

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Size
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

/**
 * The phone's rear camera as a fallback frame source, so the shell works with no glasses at all.
 * Bound only while it is actually needed (the camera LED tells Carmen when it is on).
 */
class PhoneCameraSource(
    private val context: Context,
    private val lifecycleOwner: LifecycleOwner,
) : FrameSource {
  override val origin = FrameOrigin.PHONE
  private val _status = MutableStateFlow(SourceStatus())
  override val status: StateFlow<SourceStatus> = _status
  private var provider: ProcessCameraProvider? = null
  private var imageCapture: ImageCapture? = null

  fun permitted() = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
      PackageManager.PERMISSION_GRANTED

  override suspend fun start() = withContext(Dispatchers.Main) {
    if (imageCapture != null) return@withContext
    if (!permitted()) {
      _status.value = SourceStatus(LinkState.ERROR, "camera_permission", "Camera permission is off.")
      throw CaptureException("camera_permission", "Camera permission is off.")
    }
    _status.value = SourceStatus(LinkState.CONNECTING)
    try {
      val p = provider ?: suspendCancellableCoroutine { cont ->
        val f = ProcessCameraProvider.getInstance(context)
        f.addListener({
          try { cont.resume(f.get()) } catch (e: Exception) { cont.resumeWithException(e) }
        }, ContextCompat.getMainExecutor(context))
      }.also { provider = it }
      val ic = ImageCapture.Builder()
          .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
          .setResolutionSelector(
              ResolutionSelector.Builder()
                  .setResolutionStrategy(ResolutionStrategy(Size(1280, 960),
                      ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
                  .build())
          .build()
      p.unbindAll()
      p.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, ic)
      imageCapture = ic
      _status.value = SourceStatus(LinkState.READY)
    } catch (e: Exception) {
      imageCapture = null
      val busy = e.message?.contains("in use", true) == true
      _status.value = SourceStatus(LinkState.ERROR, if (busy) "busy" else "camera_error",
          if (busy) "The camera is busy in another app." else "The phone camera could not start.")
      throw CaptureException(_status.value.code!!, _status.value.message!!)
    }
  }

  override suspend fun stop() = withContext(Dispatchers.Main) {
    provider?.unbindAll()
    imageCapture = null
    _status.value = SourceStatus(LinkState.IDLE)
  }

  override suspend fun capture(maxEdge: Int): Frame {
    if (imageCapture == null) start()
    val ic = imageCapture ?: throw CaptureException("not_ready", "The phone camera is not ready.")
    val t0 = System.currentTimeMillis()
    val image: ImageProxy = withTimeout(8_000) {
      suspendCancellableCoroutine { cont ->
        ic.takePicture(ContextCompat.getMainExecutor(context), object : ImageCapture.OnImageCapturedCallback() {
          override fun onCaptureSuccess(image: ImageProxy) { cont.resume(image) }
          override fun onError(exception: ImageCaptureException) {
            cont.resumeWithException(CaptureException("capture_failed", "The phone camera missed a photo."))
          }
        })
      }
    }
    return withContext(Dispatchers.Default) {
      image.use { img ->
        val rotation = img.imageInfo.rotationDegrees
        val buf = img.planes[0].buffer
        val bytes = ByteArray(buf.remaining()).also { buf.get(it) }
        val (jpeg, w, h) = JpegFrames.fromEncoded(bytes, maxEdge, extraRotation = rotation)
        Frame(jpeg, w, h, origin, t0, System.currentTimeMillis() - t0)
      }
    }
  }
}
