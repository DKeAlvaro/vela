package app.vela.shell

import android.content.Context
import android.net.Uri
import android.util.Log
import com.meta.wearable.dat.camera.Camera
import com.meta.wearable.dat.camera.Stream
import com.meta.wearable.dat.camera.addCamera
import com.meta.wearable.dat.camera.photo.Photo
import com.meta.wearable.dat.camera.photo.types.PhotoQuality
import com.meta.wearable.dat.camera.photo.types.PhotoResolution
import com.meta.wearable.dat.camera.photo.types.PhotoState
import com.meta.wearable.dat.camera.types.PhotoData
import com.meta.wearable.dat.camera.types.StreamConfiguration
import com.meta.wearable.dat.camera.types.StreamState
import com.meta.wearable.dat.camera.types.VideoQuality
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.selectors.AutoDeviceSelector
import com.meta.wearable.dat.core.session.DeviceSession
import com.meta.wearable.dat.core.session.DeviceSessionState
import com.meta.wearable.dat.core.types.DeviceCompatibility
import com.meta.wearable.dat.core.types.DeviceSessionError
import com.meta.wearable.dat.core.types.DonState
import com.meta.wearable.dat.core.types.HingeState
import org.json.JSONObject
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import com.meta.wearable.dat.mockdevice.MockDeviceKit
import com.meta.wearable.dat.mockdevice.api.GlassesModel
import com.meta.wearable.dat.mockdevice.api.MockDeviceKitConfig
import com.meta.wearable.dat.mockdevice.api.MockGlasses
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** How we take a picture with the glasses. */
enum class CaptureMode(val wire: String) {
  /** Default. 720x1280 stream at 7 fps kept open; a request returns the sharpest recent frame from memory. */
  LIVE("live"),
  /** DAT standalone photo capture (beta): one still per request, no video at all. Default. */
  PHOTO("photo"),
  /** 2 fps LOW video stream kept open; we take an in-stream photo per request. Fallback. */
  STREAM("stream");
  companion object { fun parse(s: String?) = entries.firstOrNull { it.wire == s } }
}

/** What we know about the glasses, for the status object the web app reads. */
data class GlassesInfo(
    val initialized: Boolean = false,
    val registration: String = "unknown",
    val deviceName: String? = null,
    val battery: Int? = null,
    val worn: Boolean? = null,
    val link: String? = null,
    val session: String = "none",
    val captureMode: CaptureMode = CaptureMode.LIVE,
    /** Live mode: frames received since the camera opened, and the age of the newest one. */
    val liveFrames: Long = 0,
    val mock: Boolean = false,
    val firmwareUpdateRequired: Boolean = false,
    /** "open" | "closed" (folded) | null */
    val hinge: String? = null,
    val thermal: String? = null,
    /** Last session transitions, newest last: "12:03:04.120 starting (+0.3s)". */
    val sessionLog: List<String> = emptyList(),
)

/**
 * Ray-Ban Meta glasses through Meta's Wearables Device Access Toolkit (DAT 1.0.1).
 * Lifecycle: initialize -> (registered in Meta AI) -> camera permission -> session -> camera -> capture.
 */
class GlassesSource(private val app: Context, private val scope: CoroutineScope) : FrameSource {
  companion object {
    private const val TAG = "VelaGlasses"
    private const val SESSION_TIMEOUT_MS = 30_000L
    /** Errors only the wearer can fix: we stop retrying and keep the reason on screen. */
    val FATAL_CODES = setOf("glasses_app_update", "sdk_update", "firmware_update", "dwa_unavailable", "capability_denied")
    private const val CAMERA_TIMEOUT_MS = 12_000L
    private const val PHOTO_TIMEOUT_MS = 12_000L
    private const val FAILURES_BEFORE_STREAM = 3
    /** Live mode: how long a request waits for a first/fresh frame before an in-stream photo. */
    private const val LIVE_WAIT_MS = 2_500L
  }

  override val origin: FrameOrigin get() = if (_info.value.mock) FrameOrigin.MOCK else FrameOrigin.GLASSES
  private val _status = MutableStateFlow(SourceStatus())
  override val status: StateFlow<SourceStatus> = _status
  private val _info = MutableStateFlow(GlassesInfo())
  val info: StateFlow<GlassesInfo> = _info

  /** Set by the activity: launches the Meta AI permission screen and returns the result. */
  var requestCameraPermission: (suspend () -> PermissionStatus)? = null

  private var wanted = false
  private var session: DeviceSession? = null
  private var camera: Camera? = null
  private var photo: Photo? = null
  private var stream: Stream? = null
  private var sessionJobs = mutableListOf<Job>()
  private var cameraJobs = mutableListOf<Job>()
  private var reconnectJob: Job? = null
  private var reconnectDelay = 2_000L
  private val lifecycle = Mutex()
  private val captureLock = Mutex()
  private val photoResults = Channel<Result<ByteArray>>(Channel.CONFLATED)
  private var consecutiveFailures = 0
  private var mockGlasses: MockGlasses? = null

  private fun set(state: LinkState, code: String? = null, message: String? = null) {
    _status.value = SourceStatus(state, code, message)
    Log.i(TAG, "status $state $code ${message ?: ""}")
  }

  // ---------------------------------------------------------------- init + observation

  /** Call once per process, after BLUETOOTH_CONNECT is granted. Safe to call twice. */
  fun initialize(): Boolean {
    if (_info.value.initialized) return true
    val ok = try {
      Wearables.initialize(app).fold({ true }, { e, _ ->
        // ALREADY_INITIALIZED is fine.
        e.description.contains("ALREADY", true).also { if (!it) Log.w(TAG, "init: ${e.description}") }
      })
    } catch (t: Throwable) { Log.e(TAG, "init failed", t); false }
    if (!ok) {
      set(LinkState.ERROR, "sdk_init", "The glasses toolkit could not start.")
      return false
    }
    _info.update { it.copy(initialized = true) }
    scope.launch {
      Wearables.registrationErrorStream.collect { e ->
        Log.w(TAG, "registration error ${e.name}: ${e.description}")
        registrationErrors.tryEmit(e.name.lowercase())
      }
    }
    scope.launch {
      Wearables.registrationState.collect { r ->
        _info.update { it.copy(registration = r.name.lowercase()) }
        if (r == RegistrationState.REGISTERED && wanted && session == null) scheduleReconnect(0)
        if (r != RegistrationState.REGISTERED && session == null && wanted) {
          set(LinkState.DISCONNECTED, "not_registered", "Connect Vela to the glasses in the Meta AI app.")
        }
      }
    }
    scope.launch {
      var metaJob: Job? = null
      Wearables.devices.collect { ids ->
        metaJob?.cancel()
        val id = ids.firstOrNull()
        if (id == null) {
          _info.update { it.copy(deviceName = null, battery = null, worn = null, link = null) }
          return@collect
        }
        metaJob = scope.launch {
          Wearables.devicesMetadata[id]?.collect { d ->
            _info.update {
              it.copy(
                  deviceName = d.name.ifEmpty { "Ray-Ban Meta" },
                  battery = d.batteryLevel.takeIf { b -> b in 0..100 },
                  worn = when (d.donState) { DonState.DONNED -> true; DonState.DOFFED -> false; else -> null },
                  link = d.linkState.name.lowercase(),
                  firmwareUpdateRequired = d.compatibility == DeviceCompatibility.DEVICE_UPDATE_REQUIRED,
                  hinge = when (d.hingeState) { HingeState.OPEN -> "open"; HingeState.CLOSED -> "closed"; else -> null },
                  thermal = d.thermalLevel.name.lowercase(),
              )
            }
            if (d.compatibility == DeviceCompatibility.DEVICE_UPDATE_REQUIRED) {
              set(LinkState.ERROR, "firmware_update", "The glasses need an update in the Meta AI app.")
            }
          }
        }
      }
    }
    return true
  }

  // ---------------------------------------------------------------- start / stop

  override suspend fun start() {
    wanted = true
    lifecycle.withLock { connect() }
  }

  override suspend fun stop() {
    wanted = false
    reconnectJob?.cancel()
    lifecycle.withLock { teardown() }
    set(LinkState.IDLE)
  }

  private suspend fun connect() {
    if (!_info.value.initialized && !initialize()) return
    // One session at a time: a paused session resumes by itself (DAT), a stopped one is torn down first.
    if (session != null) return
    if (Wearables.registrationState.value != RegistrationState.REGISTERED) {
      set(LinkState.DISCONNECTED, "not_registered", "Connect Vela to the glasses in the Meta AI app.")
      return
    }
    set(LinkState.CONNECTING, null, "Connecting to the glasses…")

    // 1. Camera permission on the glasses (granted in the Meta AI app).
    val perm = Wearables.checkPermissionStatus(Permission.CAMERA).fold({ it }, { e, _ ->
      Log.w(TAG, "permission check: ${e.description}"); null
    })
    if (perm != PermissionStatus.Granted) {
      val asked = requestCameraPermission?.invoke()
      if (asked != PermissionStatus.Granted) {
        set(LinkState.ERROR, "glasses_camera_permission", "Allow camera access for Vela in the Meta AI app.")
        return
      }
    }

    // 2. Device session.
    val s = Wearables.createSession(AutoDeviceSelector()).fold({ it }, { e, _ ->
      val noDevice = e == DeviceSessionError.NO_ELIGIBLE_DEVICE
      set(LinkState.DISCONNECTED, if (noDevice) "no_device" else "session_failed",
          if (noDevice) "The glasses are not nearby or are switched off." else "Could not reach the glasses.")
      null
    }) ?: return scheduleReconnect()
    session = s
    observeSession(s)
    s.start()
    val started = withTimeoutOrNull(SESSION_TIMEOUT_MS) {
      kotlinx.coroutines.flow.combine(s.state, _status) { st, ss -> st to ss.code }
          .first { (st, c) -> st == DeviceSessionState.STARTED || st == DeviceSessionState.STOPPED || c in FATAL_CODES }
          .first
    }
    val fatal = _status.value.takeIf { it.code in FATAL_CODES }
    if (fatal != null && started != DeviceSessionState.STARTED) {
      // e.g. DAT_APP_ON_THE_GLASSES_UPDATE_REQUIRED: needs the user, so keep the real reason and don't retry.
      sessionEvent("fatal", JSONObject().put("code", fatal.code))
      teardown()
      set(LinkState.ERROR, fatal.code, fatal.message)
      return
    }
    if (started != DeviceSessionState.STARTED) {
      val last = s.state.value
      sessionEvent("timeout", JSONObject().put("lastState", last.name.lowercase()).put("afterMs", SESSION_TIMEOUT_MS))
      teardown()
      set(LinkState.DISCONNECTED, "session_timeout",
          "The glasses did not answer (session stayed ${last.name.lowercase()} for ${SESSION_TIMEOUT_MS / 1000} s). " +
              if (last == DeviceSessionState.PAUSED) pauseAdvice() else "Close Meta AI's camera or Live AI, then tap Connect.")
      return scheduleReconnect()
    }
    _info.update { it.copy(session = "started") }

    // 3. Camera capability.
    if (!openCamera(s)) {
      // Startup is the most common failure point (DAT docs): retry once with a fresh camera.
      closeCamera()
      if (!openCamera(s)) {
        if (_info.value.captureMode == CaptureMode.LIVE) {
          Log.w(TAG, "live stream failed twice; trying single photos")
          closeCamera()
          _info.update { it.copy(captureMode = CaptureMode.PHOTO) }
          if (openCamera(s)) return ready()
        }
        if (_info.value.captureMode == CaptureMode.PHOTO) {
          Log.w(TAG, "photo capability failed twice; trying stream mode")
          closeCamera()
          _info.update { it.copy(captureMode = CaptureMode.STREAM) }
          if (openCamera(s)) return ready()
        }
        teardown() // so a later Connect starts clean
        set(LinkState.ERROR, "camera_setup", "The glasses camera did not start. Try switching the glasses off and on.")
        return
      }
    }
    ready()
  }

  /** Hook for the activity: diag + remote log of session transitions. */
  var onSessionEvent: ((String, JSONObject) -> Unit)? = null
  private fun sessionEvent(kind: String, data: JSONObject) {
    Log.i(TAG, "session $kind $data")
    try { onSessionEvent?.invoke(kind, data.put("kind", kind)) } catch (_: Exception) {}
  }

  /** DAT gives no pause reason, so we read it off the device metadata. */
  private fun pauseAdvice(): String {
    val i = _info.value
    return when {
      i.hinge == "closed" -> "The glasses are folded: unfold them and put them on."
      i.worn == false -> "Put the glasses on (they pause when not worn)."
      i.thermal in setOf("severe", "critical", "emergency", "shutdown") -> "The glasses are too warm: let them cool for a few minutes."
      else -> "Put the glasses on and unfold them. If Meta AI is using the camera (Live AI, a photo or video), close it."
    }
  }

  private fun ready() {
    reconnectDelay = 2_000L
    consecutiveFailures = 0
    set(LinkState.READY)
  }

  private fun observeSession(s: DeviceSession) {
    val t0 = android.os.SystemClock.elapsedRealtime()
    sessionJobs += scope.launch {
      s.state.collect { st ->
        val name = st.name.lowercase()
        val i = _info.value
        val line = java.time.LocalTime.now().toString().take(12) + " " + name +
            " (+" + "%.1f".format((android.os.SystemClock.elapsedRealtime() - t0) / 1000.0) + "s)" +
            (if (st == DeviceSessionState.PAUSED) " worn=${i.worn} hinge=${i.hinge} thermal=${i.thermal}" else "")
        _info.update { it.copy(session = name, sessionLog = (it.sessionLog + line).takeLast(12)) }
        sessionEvent("state", JSONObject().put("state", name).put("sinceStartMs", android.os.SystemClock.elapsedRealtime() - t0)
            .put("worn", i.worn ?: JSONObject.NULL).put("hinge", i.hinge ?: JSONObject.NULL)
            .put("thermal", i.thermal ?: JSONObject.NULL).put("battery", i.battery ?: JSONObject.NULL)
            .put("link", i.link ?: JSONObject.NULL))
        when (st) {
          DeviceSessionState.STARTING, DeviceSessionState.IDLE ->
            if (_status.value.state == LinkState.CONNECTING) set(LinkState.CONNECTING, null, "Connecting to the glasses… (session $name)")
          DeviceSessionState.PAUSED ->
            set(LinkState.CONNECTING, "paused", "The glasses paused the session. " + pauseAdvice())
          DeviceSessionState.STARTED ->
            if (_status.value.code == "paused" && camera != null) set(LinkState.READY)
          DeviceSessionState.STOPPED -> if (session === s) {
            lifecycle.withLock { teardown() }
            if (wanted && _status.value.code !in FATAL_CODES) {
              set(LinkState.DISCONNECTED, "disconnected", "The glasses disconnected.")
              scheduleReconnect()
            }
          }
          else -> {}
        }
      }
    }
    sessionJobs += scope.launch {
      s.errors.collect { e ->
        Log.w(TAG, "session error ${e.name}: ${e.description}")
        _info.update { it.copy(sessionLog = (it.sessionLog + (java.time.LocalTime.now().toString().take(12) + " error " + e.name)).takeLast(12)) }
        if (e != DeviceSessionError.DWA_OUT_OF_STU_RANGE) sessionEvent("error", JSONObject().put("error", e.name).put("description", e.description))
        val (code, msg) = when (e) {
          DeviceSessionError.DWA_OUT_OF_STU_RANGE -> { sessionEvent("error", JSONObject().put("error", e.name)); return@collect } // not blocking (DAT docs)
          DeviceSessionError.DEVICE_DISCONNECTED, DeviceSessionError.SESSION_ENDED_BY_DEVICE ->
            "disconnected" to "The glasses disconnected."
          DeviceSessionError.THERMAL_CRITICAL, DeviceSessionError.THERMAL_EMERGENCY ->
            "too_warm" to "The glasses are too warm, so the camera is resting."
          DeviceSessionError.BATTERY_CRITICAL, DeviceSessionError.PEAK_POWER_SHUTDOWN ->
            "battery" to "The glasses battery is very low."
          DeviceSessionError.DAT_APP_ON_THE_GLASSES_UPDATE_REQUIRED ->
            "glasses_app_update" to "The glasses need an update: in Meta AI, update the glasses software, check Developer Mode is still on, then restart the glasses."
          DeviceSessionError.INSUFFICIENT_SDK_VERSION ->
            "sdk_update" to "This Vela app is too old for the glasses. Install the new version."
          DeviceSessionError.CAPABILITY_DENIED ->
            "capability_denied" to "The glasses declined camera access for now."
          DeviceSessionError.DWA_UNAVAILABLE ->
            "dwa_unavailable" to "The glasses are not set up in the Meta AI app yet."
          else -> "session_error" to "The glasses reported a problem."
        }
        set(if (code == "disconnected") LinkState.DISCONNECTED else LinkState.ERROR, code, msg)
      }
    }
  }

  private fun scheduleReconnect(delayMs: Long = reconnectDelay) {
    if (!wanted) return
    reconnectJob?.cancel()
    reconnectJob = scope.launch {
      delay(delayMs)
      reconnectDelay = (reconnectDelay * 2).coerceAtMost(30_000L)
      lifecycle.withLock { if (wanted && session == null) connect() }
    }
  }

  private suspend fun openCamera(s: DeviceSession): Boolean = when (_info.value.captureMode) {
    CaptureMode.LIVE -> openLive(s)
    CaptureMode.PHOTO -> openPhoto(s)
    CaptureMode.STREAM -> openStream(s)
  }

  private val ring = LiveFrames.Ring(5)
  private var lastServedAt = Long.MIN_VALUE
  private var yuvLayout: Boolean? = null // null = not detected yet; true = NV12, false = I420

  private suspend fun openLive(s: DeviceSession): Boolean {
    // HIGH = 720x1280 (DAT may step down on a weak link; we read the size from each frame).
    // 7 fps: fresh enough for watching, light enough for Bluetooth and the phone's decoder.
    val cfg = StreamConfiguration(videoQuality = VideoQuality.HIGH, frameRate = 7)
    val cam = s.addCamera(cfg).fold({ it }, { e, _ -> Log.w(TAG, "addCamera(live): ${e.description}"); null })
        ?: return false
    camera = cam
    val st = cam.stream
    stream = st
    ring.clear(); yuvLayout = null
    cameraJobs += scope.launch(Dispatchers.Default) {
      var n = 0L
      st.videoStream.collect { f ->
        if (f.isCompressed || f.isCodecConfig) return@collect
        try {
          val b = f.buffer.duplicate().apply { rewind() }
          val raw = ByteArray(b.remaining()).also { b.get(it) }
          val w = f.width; val h = f.height
          val layout = yuvLayout ?: LiveFrames.looksInterleaved(raw, w, h).also {
            yuvLayout = it; Log.i(TAG, "live: ${w}x$h, ${raw.size} B, layout ${if (it) "NV12" else "I420"}")
          }
          val nv21 = LiveFrames.toNv21(raw, w, h, layout) ?: return@collect
          ring.add(LiveFrames.Raw(nv21, w, h, android.os.SystemClock.elapsedRealtime(), LiveFrames.sharpness(nv21, w, h)))
          if (++n % 35 == 1L) _info.update { it.copy(liveFrames = n) }
        } catch (t: Throwable) { Log.w(TAG, "live frame", t) }
      }
    }
    cameraJobs += scope.launch {
      st.errorStream.collect { e -> sessionEvent("stream_error", JSONObject().put("error", e.toString())) }
    }
    if (st.start().isFailure) return false
    val outcome = withTimeoutOrNull(CAMERA_TIMEOUT_MS) {
      st.state.first { it == StreamState.STREAMING || it == StreamState.STOPPED || it == StreamState.CLOSED }
    }
    if (outcome == StreamState.STREAMING) {
      // Frames stopped for 6 s while we think we're ready -> reopen the camera once per stall.
      cameraJobs += scope.launch {
        while (true) {
          delay(3_000)
          val last = ring.lastAtMs
          if (last > 0 && android.os.SystemClock.elapsedRealtime() - last > 6_000 && _status.value.state == LinkState.READY) {
            sessionEvent("live_stall", JSONObject().put("silentMs", android.os.SystemClock.elapsedRealtime() - last))
            scope.launch { restartCamera("stall") }
            break
          }
        }
      }
    }
    return outcome == StreamState.STREAMING
  }

  /** Close and reopen the camera in the current mode (keeps the session). */
  suspend fun restartCamera(why: String) = lifecycle.withLock {
    val s = session ?: return@withLock
    sessionEvent("camera_restart", JSONObject().put("why", why).put("mode", _info.value.captureMode.wire))
    closeCamera()
    if (openCamera(s)) ready()
    else set(LinkState.ERROR, "camera_setup", "The glasses camera did not start. Try switching the glasses off and on.")
  }

  private suspend fun captureLive(maxEdge: Int, opts: CaptureOpts): Pair<Triple<ByteArray, Int, Int>, Map<String, Any>> {
    val t0 = android.os.SystemClock.elapsedRealtime()
    var f = ring.pick(t0, opts.maxAgeMs, opts.latest, lastServedAt)
    while (f == null && android.os.SystemClock.elapsedRealtime() - t0 < LIVE_WAIT_MS) {
      delay(40)
      f = ring.pick(android.os.SystemClock.elapsedRealtime(), maxOf(opts.maxAgeMs, 1_000), true, lastServedAt)
    }
    if (f != null) lastServedAt = f.atMs
    if (f == null) {
      // No frames (stream stalled, or Mock Device Kit without video): ask for an in-stream photo.
      Log.w(TAG, "live: no fresh frame in ${LIVE_WAIT_MS} ms; in-stream photo instead")
      return captureFromStream(maxEdge) to mapOf("mode" to "stream_photo")
    }
    val jpeg = withContext(Dispatchers.Default) {
      val out = java.io.ByteArrayOutputStream()
      android.graphics.YuvImage(f.nv21, android.graphics.ImageFormat.NV21, f.width, f.height, null)
          .compressToJpeg(android.graphics.Rect(0, 0, f.width, f.height), 88, out)
      val bytes = out.toByteArray()
      if (maxOf(f.width, f.height) > maxEdge) JpegFrames.fromEncoded(bytes, maxEdge) else Triple(bytes, f.width, f.height)
    }
    val age = android.os.SystemClock.elapsedRealtime() - f.atMs
    return jpeg to mapOf("mode" to "live", "ageMs" to age, "sharpness" to Math.round(f.sharpness * 10) / 10.0)
  }

  private suspend fun openPhoto(s: DeviceSession): Boolean {
    val cam = s.addCamera().fold({ it }, { e, _ -> Log.w(TAG, "addCamera: ${e.description}"); null }) ?: return false
    camera = cam
    // Android activates the photo child on first access; its flows don't replay, so subscribe now.
    val p = cam.photo
    photo = p
    cameraJobs += scope.launch { p.photoStream.collect { photoResults.trySend(Result.success(it.imageData)) } }
    cameraJobs += scope.launch {
      p.errors.collect {
        sessionEvent("photo_error", JSONObject().put("error", it.toString()).put("description", it.description))
        photoResults.trySend(Result.failure(CaptureException("glasses_capture", it.description)))
      }
    }
    var sawStarting = false
    val outcome = withTimeoutOrNull(CAMERA_TIMEOUT_MS) {
      p.state.first { st ->
        when (st) {
          PhotoState.STARTING -> { sawStarting = true; false }
          PhotoState.STARTED -> true
          PhotoState.STOPPED -> sawStarting
          PhotoState.STOPPING -> false
        }
      }
    }
    return outcome == PhotoState.STARTED
  }

  private suspend fun openStream(s: DeviceSession): Boolean {
    // Lowest bandwidth: 360x640 at 2 fps. We never keep or forward the video, only in-stream photos.
    val cfg = StreamConfiguration(videoQuality = VideoQuality.LOW, frameRate = 2)
    val cam = s.addCamera(cfg).fold({ it }, { e, _ -> Log.w(TAG, "addCamera(stream): ${e.description}"); null })
        ?: return false
    camera = cam
    val st = cam.stream
    stream = st
    cameraJobs += scope.launch { st.videoStream.collect { /* frames are dropped on purpose */ } }
    if (st.start().isFailure) return false
    val outcome = withTimeoutOrNull(CAMERA_TIMEOUT_MS) {
      st.state.first { it == StreamState.STREAMING || it == StreamState.STOPPED || it == StreamState.CLOSED }
    }
    return outcome == StreamState.STREAMING
  }

  private fun closeCamera() {
    cameraJobs.forEach { it.cancel() }
    cameraJobs.clear()
    try { camera?.stop() } catch (t: Throwable) { Log.w(TAG, "camera stop", t) }
    camera = null; photo = null; stream = null
    ring.clear()
    while (photoResults.tryReceive().isSuccess) { /* drain */ }
  }

  private fun teardown() {
    closeCamera()
    sessionJobs.forEach { it.cancel() }
    sessionJobs.clear()
    try { session?.stop() } catch (t: Throwable) { Log.w(TAG, "session stop", t) }
    session = null
    _info.update { it.copy(session = "none") }
  }

  // ---------------------------------------------------------------- capture

  override suspend fun capture(maxEdge: Int): Frame = capture(maxEdge, CaptureOpts())

  suspend fun capture(maxEdge: Int, opts: CaptureOpts): Frame = captureLock.withLock {
    if (_status.value.state != LinkState.READY) {
      throw CaptureException(_status.value.code ?: "not_ready", _status.value.message ?: "The glasses are not ready.")
    }
    val t0 = System.currentTimeMillis()
    try {
      val (img, extra) = when (_info.value.captureMode) {
        CaptureMode.LIVE -> captureLive(maxEdge, opts)
        CaptureMode.PHOTO -> try {
          capturePhoto(maxEdge) to mapOf<String, Any>("mode" to "photo")
        } catch (e: CaptureException) {
          // Seen on hardware: DwaCapabilityChannel 0xc001 SERVICE_NOT_FOUND, then 0xc010
          // SERVICE_RESTORED. Give the channel a moment, retry once, then switch to live frames.
          sessionEvent("photo_retry", JSONObject().put("code", e.code).put("message", e.message ?: ""))
          delay(1_500)
          try {
            capturePhoto(maxEdge) to mapOf<String, Any>("mode" to "photo_retry")
          } catch (e2: CaptureException) {
            sessionEvent("photo_fallback_live", JSONObject().put("code", e2.code).put("message", e2.message ?: ""))
            switchModeLocked(CaptureMode.LIVE)
            captureLive(maxEdge, opts).let { (img, ex) -> img to (ex + ("mode" to "live_after_photo_error")) }
          }
        }
        CaptureMode.STREAM -> captureFromStream(maxEdge) to mapOf<String, Any>("mode" to "stream_photo")
      }
      val (jpeg, w, h) = img
      consecutiveFailures = 0
      val ms = System.currentTimeMillis() - t0
      captures++
      if (captures <= 30 || captures % 10 == 0L) {
        sessionEvent("capture", JSONObject().put("n", captures).put("capture_ms", ms).put("w", w).put("h", h)
            .put("bytes", jpeg.size).apply { extra.forEach { (k, v) -> put(k, v) } })
      }
      Frame(jpeg, w, h, origin, t0, ms, extra)
    } catch (e: CaptureException) {
      consecutiveFailures++
      Log.w(TAG, "capture failed ($consecutiveFailures): ${e.message}")
      sessionEvent("capture_error", JSONObject().put("code", e.code).put("message", e.message ?: "")
          .put("mode", _info.value.captureMode.wire).put("ms", System.currentTimeMillis() - t0).put("inARow", consecutiveFailures))
      if (consecutiveFailures >= FAILURES_BEFORE_STREAM) {
        // live -> photo -> stream: step down after 3 misses in a row.
        when (_info.value.captureMode) {
          CaptureMode.LIVE -> scope.launch { consecutiveFailures = 0; restartCamera("3_failures") }
          CaptureMode.PHOTO -> scope.launch { setCaptureMode(CaptureMode.STREAM) }
          CaptureMode.STREAM -> {}
        }
      }
      throw e
    }
  }

  private suspend fun capturePhoto(maxEdge: Int): Triple<ByteArray, Int, Int> {
    val p = photo ?: throw CaptureException("not_ready", "The glasses camera is not ready.")
    while (photoResults.tryReceive().isSuccess) { /* drop stale results (e.g. a late one) */ }
    val res = when {
      maxEdge <= 640 -> PhotoResolution.SMALL
      maxEdge <= 1280 -> PhotoResolution.MEDIUM
      else -> PhotoResolution.LARGE
    }
    p.capturePhoto(res, PhotoQuality.MEDIUM)
    val r = withTimeoutOrNull(PHOTO_TIMEOUT_MS) { photoResults.receive() }
        ?: throw CaptureException("glasses_timeout", "The glasses took too long to send a photo.")
    val bytes = r.getOrElse { throw it }
    return withContext(Dispatchers.Default) { JpegFrames.fromEncoded(bytes, maxEdge) }
  }

  private suspend fun captureFromStream(maxEdge: Int): Triple<ByteArray, Int, Int> {
    val st = stream ?: throw CaptureException("not_ready", "The glasses camera is not ready.")
    val data = withTimeoutOrNull(PHOTO_TIMEOUT_MS) {
      st.capturePhoto().fold({ it }, { e, _ -> throw CaptureException("glasses_capture", e.description) })
    } ?: throw CaptureException("glasses_timeout", "The glasses took too long to send a photo.")
    return withContext(Dispatchers.Default) {
      when (data) {
        is PhotoData.Bitmap -> JpegFrames.fromBitmap(data.bitmap, maxEdge)
        is PhotoData.HEIC -> {
          val b = data.data.duplicate().apply { rewind() }
          JpegFrames.fromEncoded(ByteArray(b.remaining()).also { b.get(it) }, maxEdge)
        }
        else -> throw CaptureException("decode", "Unknown photo format from the glasses.")
      }
    }
  }

  private var captures = 0L

  /** Mode switch from inside a capture (we already hold captureLock, not lifecycle). */
  private suspend fun switchModeLocked(mode: CaptureMode) = lifecycle.withLock {
    val s = session ?: return@withLock
    _info.update { it.copy(captureMode = mode) }
    closeCamera()
    if (openCamera(s)) ready()
  }

  suspend fun setCaptureMode(mode: CaptureMode) = lifecycle.withLock {
    if (_info.value.captureMode == mode) return@withLock
    _info.update { it.copy(captureMode = mode) }
    consecutiveFailures = 0
    val s = session ?: return@withLock
    closeCamera()
    set(LinkState.CONNECTING, null, "Switching the glasses camera…")
    if (openCamera(s)) ready()
    else set(LinkState.ERROR, "camera_setup", "The glasses camera did not start. Try switching the glasses off and on.")
  }

  // ---------------------------------------------------------------- registration

  /** DAT reports registration failures only on this stream (startRegistration returns nothing). */
  val registrationErrors = kotlinx.coroutines.flow.MutableSharedFlow<String>(extraBufferCapacity = 8)
  val registrationState: RegistrationState get() = Wearables.registrationState.value

  fun register(activity: android.app.Activity) = Wearables.startRegistration(activity)
  fun unregister(activity: android.app.Activity) = Wearables.startUnregistration(activity)

  // ---------------------------------------------------------------- Mock Device Kit

  /**
   * Meta's Mock Device Kit: simulated Ray-Ban Meta glasses inside this app, no hardware and no
   * Meta AI app. Captures return [fixture] (a JPEG file). Same code path as real glasses.
   */
  suspend fun useMock(enable: Boolean, fixture: File?) {
    val kit = MockDeviceKit.getInstance(app)
    if (!enable) {
      stop()
      mockGlasses?.let { kit.unpairDevice(it) }
      mockGlasses = null
      kit.disable()
      _info.update { it.copy(mock = false) }
      return
    }
    if (!kit.isEnabled) kit.enable(MockDeviceKitConfig(initiallyRegistered = true, initialPermissionsGranted = true))
    if (!_info.value.initialized) initialize()
    val g = mockGlasses ?: kit.pairGlasses(GlassesModel.RAYBAN_META).fold({ it }, { e, _ ->
      throw CaptureException("mock", "Mock glasses failed: ${e.description}")
    }).also { mockGlasses = it }
    g.powerOn(); g.unfold(); g.don()
    fixture?.let { setMockPhoto(it) }
    _info.update { it.copy(mock = true) }
    start()
  }

  fun setMockPhoto(file: File) {
    val g = mockGlasses ?: return
    val uri = Uri.fromFile(file)
    g.services.cameraCapture.setCapturedPhoto(uri) // standalone photo mode
    g.services.camera.setCapturedImage(uri)        // in-stream photo mode
  }

  /** Simulate the glasses going away / coming back (for the device-state demo). */
  fun mockPower(on: Boolean) {
    val g = mockGlasses ?: return
    if (on) { g.powerOn(); g.unfold(); g.don() } else g.powerOff()
  }
}
