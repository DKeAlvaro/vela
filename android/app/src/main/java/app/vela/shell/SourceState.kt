package app.vela.shell

/** Where a frame came from. */
enum class FrameOrigin(val wire: String) { GLASSES("glasses"), MOCK("mock"), PHONE("phone") }

/** Connection state of one frame source, as the web app sees it. */
enum class LinkState(val wire: String) {
  IDLE("idle"),
  CONNECTING("connecting"),
  READY("ready"),
  DISCONNECTED("disconnected"),
  ERROR("error"),
}

data class SourceStatus(
    val state: LinkState = LinkState.IDLE,
    /** Short machine code: e.g. "not_registered", "no_device", "camera_permission", "bt_permission". */
    val code: String? = null,
    /** One plain sentence for the status line. */
    val message: String? = null,
)

/** One still photo, already JPEG-encoded and downscaled for the vision call. */
class Frame(
    val jpeg: ByteArray,
    val width: Int,
    val height: Int,
    val origin: FrameOrigin,
    /** Wall clock when the capture was requested. */
    val requestedAt: Long,
    /** Milliseconds from request to JPEG ready (includes Bluetooth transfer for glasses). */
    val captureMs: Long,
    /** Extra fields for the bridge reply (live mode: ageMs, sharpness, mode). */
    val extra: Map<String, Any> = emptyMap(),
)

/** Per-request options from the web app. */
data class CaptureOpts(val maxAgeMs: Long = 700, val latest: Boolean = false)

class CaptureException(val code: String, message: String) : Exception(message)

interface FrameSource {
  val origin: FrameOrigin
  val status: kotlinx.coroutines.flow.StateFlow<SourceStatus>
  suspend fun start()
  suspend fun stop()
  /** One still photo. Throws [CaptureException]. */
  suspend fun capture(maxEdge: Int): Frame
}
