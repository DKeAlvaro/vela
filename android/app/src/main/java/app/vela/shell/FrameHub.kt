package app.vela.shell

import android.util.Base64
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Owns the frame sources and answers the web app: "give me one photo" from the glasses when
 * they're ready, else (in auto mode) from the phone camera. Reports one status object.
 */
class FrameHub(
    private val scope: CoroutineScope,
    val glasses: GlassesSource,
    val phone: PhoneCameraSource,
) {
  private val _pref = MutableStateFlow(SourcePref.AUTO)
  val pref: StateFlow<SourcePref> = _pref
  private val _status = MutableStateFlow(JSONObject().put("state", "idle"))
  val status: StateFlow<JSONObject> = _status
  private val _running = MutableStateFlow(false)
  private val running get() = _running.value
  private val _tick = MutableStateFlow(0)

  /** Re-publish the status (e.g. after an Android permission changed). */
  fun refresh() { _tick.value++ }
  var lastFrame: JSONObject? = null
    private set
  var frames = 0
    private set

  init {
    scope.launch {
      combine(
          combine(glasses.status, glasses.info, phone.status, _pref) { g, gi, p, pref -> listOf(g, gi, p, pref) },
          _running, _tick,
      ) { l, _, _ -> build(l[0] as SourceStatus, l[1] as GlassesInfo, l[2] as SourceStatus, l[3] as SourcePref) }
          .collect { s ->
            _status.value = s
            // Release the phone camera as soon as the glasses can take over (privacy + battery).
            if (running && s.optString("source") == "glasses" && phone.status.value.state == LinkState.READY) {
              scope.launch { phone.stop() }
            }
          }
    }
  }

  private fun build(g: SourceStatus, gi: GlassesInfo, p: SourceStatus, pref: SourcePref): JSONObject {
    val phoneAllowed = phone.permitted()
    val overall = if (!running) SourceStatus(LinkState.IDLE) else SourcePolicy.overall(pref, g, p, phoneAllowed)
    val choice = SourcePolicy.choose(pref, g.state, phoneAllowed)
    val source = when (choice) {
      SourcePolicy.Choice.GLASSES -> glasses.origin.wire
      SourcePolicy.Choice.PHONE -> "phone"
      SourcePolicy.Choice.NONE -> JSONObject.NULL
    }
    return JSONObject()
        .put("state", overall.state.wire)
        .put("code", overall.code ?: JSONObject.NULL)
        .put("message", overall.message ?: JSONObject.NULL)
        .put("source", if (running) source else JSONObject.NULL)
        .put("pref", pref.wire)
        .put("glassesStatus", GlassesStatus.classify(g.state, g.code, g.message, gi.registration, gi.initialized).json())
        .put("glasses", JSONObject()
            .put("state", g.state.wire)
            .put("code", g.code ?: JSONObject.NULL)
            .put("message", g.message ?: JSONObject.NULL)
            .put("registration", gi.registration)
            .put("device", gi.deviceName ?: JSONObject.NULL)
            .put("battery", gi.battery ?: JSONObject.NULL)
            .put("worn", gi.worn ?: JSONObject.NULL)
            .put("session", gi.session)
            .put("hinge", gi.hinge ?: JSONObject.NULL)
            .put("thermal", gi.thermal ?: JSONObject.NULL)
            .put("sessionLog", org.json.JSONArray(gi.sessionLog))
            .put("captureMode", gi.captureMode.wire)
            .put("liveFrames", gi.liveFrames)
            .put("mock", gi.mock)
            .put("sdk", "mwdat 1.0.1"))
        .put("phone", JSONObject()
            .put("state", p.state.wire)
            .put("cameraPermission", phoneAllowed))
        .put("frames", frames)
  }

  suspend fun connect() {
    _running.value = true
    if (_pref.value != SourcePref.PHONE) {
      try { glasses.start() } catch (e: Exception) { Log.w("VelaHub", "glasses start", e) }
    }
  }

  suspend fun disconnect() {
    _running.value = false
    glasses.stop()
    phone.stop()
  }

  fun setPref(p: SourcePref) { _pref.value = p; if (running && p != SourcePref.PHONE) scope.launch { glasses.start() } }

  /** One frame, as the JSON the bridge returns. */
  suspend fun capture(maxEdge: Int, opts: CaptureOpts = CaptureOpts()): JSONObject {
    if (!running) connect()
    val choice = SourcePolicy.choose(_pref.value, glasses.status.value.state, phone.permitted())
    val frame = when (choice) {
      SourcePolicy.Choice.GLASSES -> try {
        glasses.capture(maxEdge, opts)
      } catch (e: CaptureException) {
        // One missed glasses photo: in auto mode, cover with the phone so the watch keeps going.
        if (_pref.value == SourcePref.AUTO && phone.permitted()) phone.capture(maxEdge) else throw e
      }
      SourcePolicy.Choice.PHONE -> phone.capture(maxEdge)
      SourcePolicy.Choice.NONE -> {
        val s = _status.value
        throw CaptureException(s.optString("code", "not_ready").ifEmpty { "not_ready" },
            s.optString("message", "No camera is ready.").ifEmpty { "No camera is ready." })
      }
    }
    frames++
    val meta = JSONObject()
        .put("source", frame.origin.wire)
        .put("width", frame.width)
        .put("height", frame.height)
        .put("bytes", frame.jpeg.size)
        .put("captureMs", frame.captureMs)
        .put("ts", frame.requestedAt)
    for ((k, v) in frame.extra) meta.put(k, v)
    lastFrame = meta
    return JSONObject(meta.toString())
        .put("mime", "image/jpeg")
        .put("jpeg", Base64.encodeToString(frame.jpeg, Base64.NO_WRAP))
  }
}
