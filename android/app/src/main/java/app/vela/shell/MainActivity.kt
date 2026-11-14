package app.vela.shell

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.util.Log
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.PermissionStatus
import java.io.File
import kotlin.coroutines.resume
import com.meta.wearable.dat.core.types.RegistrationState
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

/**
 * The Vela shell: the Vela web app in a WebView, plus `window.VelaNative` so the page can ask for
 * one photo from the Ray-Ban Meta glasses (or the phone camera when no glasses are connected).
 */
class MainActivity : AppCompatActivity() {
  companion object {
    private const val TAG = "VelaShell"
    const val ASSET_HOST = "appassets.androidplatform.net"
    const val ASSET_ORIGIN = "https://$ASSET_HOST"
    const val OFFLINE_URL = "$ASSET_ORIGIN/assets/offline.html"
    const val DIAG_URL = "$ASSET_ORIGIN/assets/diag.html"
    private const val PREFS = "vela"
  }

  private lateinit var web: WebView
  private lateinit var hub: FrameHub
  private lateinit var audio: AudioRouter
  private var eventProxy: JavaScriptReplyProxy? = null
  private var showingOffline = false
  private var pendingWebPermission: PermissionRequest? = null
  private val appUrl: String
    get() = getSharedPreferences(PREFS, MODE_PRIVATE).getString("url", null) ?: BuildConfig.VELA_URL
  private val appOrigin get() = Urls.originOf(appUrl)

  // ---- Android runtime permissions (camera for the phone fallback, mic, Bluetooth for DAT)
  private val androidPerms = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { res ->
    Log.i(TAG, "permissions $res")
    if (granted(Manifest.permission.BLUETOOTH_CONNECT)) hub.glasses.initialize()
    hub.refresh()
    pendingWebPermission?.let { answerWebPermission(it) }
    pendingWebPermission = null
  }

  // ---- DAT camera permission (shown by the Meta AI app)
  private var datContinuation: CancellableContinuation<PermissionStatus>? = null
  private val datMutex = Mutex()
  private val datPermission = registerForActivityResult(Wearables.RequestPermissionContract()) { result ->
    datContinuation?.resume(result.getOrDefault(PermissionStatus.Denied))
    datContinuation = null
  }

  private suspend fun requestGlassesCamera(): PermissionStatus = datMutex.withLock {
    suspendCancellableCoroutine { c ->
      datContinuation = c
      c.invokeOnCancellation { datContinuation = null }
      datPermission.launch(com.meta.wearable.dat.core.types.Permission.CAMERA)
    }
  }

  private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) // Vela keeps watch: no sleep.
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

    audio = AudioRouter(this) { type, data ->
      val url = appUrl
      lifecycleScope.launch { MetaAi.remoteLog(url, type, data.put("device", MetaAi.device())) }
    }
    audio.startGuard()
    hub = FrameHub(lifecycleScope, GlassesSource(applicationContext, lifecycleScope), PhoneCameraSource(this, this))
    hub.glasses.onSessionEvent = { kind, data ->
      val type = if (kind in setOf("state", "timeout", "fatal", "error")) "glasses.session" else "glasses.$kind"
      remote(type, data)
    }
    hub.glasses.requestCameraPermission = { requestGlassesCamera() }

    web = WebView(this)
    web.setBackgroundColor(0xFF13110F.toInt()) // Night, no white flash before the page paints
    setContentView(web)
    val assets = WebViewAssetLoader.Builder().setDomain(ASSET_HOST)
        .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this)).build()
    // Keep the renderer at foreground priority even when Vela isn't visible (locked phone).
    web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
    web.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      mediaPlaybackRequiresUserGesture = false // Vela speaks without a tap once started.
      allowFileAccess = false
      allowContentAccess = false
      userAgentString = "$userAgentString VelaShell/${BuildConfig.VERSION_NAME}"
    }
    web.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
          assets.shouldInterceptRequest(request.url)

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val u = request.url
        // tel: (Call Marta), mailto:, other apps: hand to Android.
        if (u.scheme != "https" && u.scheme != "http") {
          try { startActivity(Intent(Intent.ACTION_VIEW, u)) } catch (e: Exception) { Log.w(TAG, "no handler for $u") }
          return true
        }
        return false
      }

      override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
        showingOffline = url.startsWith(OFFLINE_URL)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
          view.evaluateJavascript(bridgeJs, null) // older WebView: best effort
        }
      }

      override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (request.isForMainFrame) showOffline("network", error.description?.toString())
      }

      override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
        if (request.isForMainFrame && response.statusCode >= 500) showOffline("server", "HTTP ${response.statusCode}")
      }
    }
    web.webChromeClient = object : WebChromeClient() {
      override fun onPermissionRequest(request: PermissionRequest) {
        val origin = Urls.originOf(request.origin.toString())
        if (origin != appOrigin && origin != ASSET_ORIGIN) { request.deny(); return }
        val need = androidPermsFor(request)
        if (need.all { granted(it) }) answerWebPermission(request)
        else { pendingWebPermission = request; androidPerms.launch(need.toTypedArray()) }
      }

      override fun onConsoleMessage(m: ConsoleMessage): Boolean {
        Log.d("VelaWeb", "${m.messageLevel()} ${m.message()} (${m.sourceId()?.substringAfterLast('/')}:${m.lineNumber()})")
        return true
      }
    }

    installBridge()

    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        // Back never kills Vela by accident: go back inside the app, else move to background.
        if (web.canGoBack() && !showingOffline) web.goBack() else moveTaskToBack(true)
      }
    })

    getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        runOnUiThread { if (showingOffline) loadApp() }
      }
    })

    lifecycleScope.launch {
      hub.status.collect { s -> eventProxy?.let { postSafe(it, BridgeProtocol.event("state", s)) } }
    }

    androidPerms.launch(arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO, Manifest.permission.BLUETOOTH_CONNECT,
        Manifest.permission.POST_NOTIFICATIONS))
    if (granted(Manifest.permission.BLUETOOTH_CONNECT)) hub.glasses.initialize()

    handleIntent(intent, fresh = true)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    handleIntent(intent, fresh = false)
  }

  private fun handleIntent(intent: Intent?, fresh: Boolean) {
    // Meta AI may start registration from its side (DAT >= 1.0.0).
    try {
      Wearables.handleIntent(intent ?: Intent()) { req -> req.continueRegistration(this) }
    } catch (t: Throwable) { Log.w(TAG, "handleIntent", t) }
    val data = intent?.data
    if (data?.scheme == "velashell") {
      when (data.host) {
        "diag" -> { web.loadUrl(DIAG_URL); return }
        "reload" -> { loadApp(); return }
        "open" -> data.getQueryParameter("url")?.takeIf { it.startsWith("https://") }?.let {
          getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString("url", it).apply()
          recreate(); return
        }
        "reset" -> { getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove("url").apply(); recreate(); return }
      }
    }
    if (fresh) loadApp()
  }

  private fun loadApp() {
    showingOffline = false
    web.loadUrl(Urls.withDevice(appUrl))
  }

  private fun showOffline(reason: String, detail: String?) {
    if (showingOffline) return
    showingOffline = true
    Log.w(TAG, "offline: $reason $detail")
    web.loadUrl("$OFFLINE_URL?reason=${Uri.encode(reason)}&target=${Uri.encode(Urls.withDevice(appUrl))}")
  }

  private fun androidPermsFor(r: PermissionRequest) = r.resources.mapNotNull {
    when (it) {
      PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
      PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
      else -> null
    }
  }

  private fun answerWebPermission(r: PermissionRequest) {
    val ok = r.resources.filter {
      (it == PermissionRequest.RESOURCE_VIDEO_CAPTURE && granted(Manifest.permission.CAMERA)) ||
          (it == PermissionRequest.RESOURCE_AUDIO_CAPTURE && granted(Manifest.permission.RECORD_AUDIO))
    }
    if (ok.isEmpty()) r.deny() else r.grant(ok.toTypedArray())
  }

  // ------------------------------------------------------------------ the bridge

  private val bridgeJs by lazy { assets.open("bridge.js").bufferedReader().readText() }

  private fun installBridge() {
    val origins = setOf(appOrigin, ASSET_ORIGIN)
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
      Log.e(TAG, "WebView too old for WEB_MESSAGE_LISTENER; update Android System WebView")
      return
    }
    WebViewCompat.addWebMessageListener(web, "VelaNativeChannel", origins) { _, message, origin, isMainFrame, reply ->
      if (!isMainFrame) return@addWebMessageListener // no iframes
      val req = BridgeProtocol.parse(message.data) ?: return@addWebMessageListener
      eventProxy = reply
      Log.d(TAG, "bridge ${req.op} from $origin")
      lifecycleScope.launch {
        val out = try {
          BridgeProtocol.ok(req.id, handle(req.op, req.args))
        } catch (e: CaptureException) {
          BridgeProtocol.fail(req.id, e.code, e.message ?: "")
        } catch (e: Exception) {
          Log.e(TAG, "op ${req.op}", e)
          BridgeProtocol.fail(req.id, "native_error", e.message ?: e.javaClass.simpleName)
        }
        postSafe(reply, out)
      }
    }
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      WebViewCompat.addDocumentStartJavaScript(web, bridgeJs, origins)
    }
  }

  private fun postSafe(p: JavaScriptReplyProxy, s: String) {
    try { p.postMessage(s) } catch (e: Exception) { Log.w(TAG, "post failed", e) }
  }

  // ---- Linking with Meta AI. startRegistration() returns nothing: failures arrive on DAT's
  // registrationErrorStream, and success shows as Meta AI coming to the front (we get onPause).
  @Volatile private var pauseCount = 0
  override fun onPause() { super.onPause(); pauseCount++ }

  // ---- Background: keep watching with the phone locked. We never call web.onPause() or
  // pauseTimers(); WatchService keeps the process and CPU alive; a native 1 s tick reaches the page
  // even if Chromium throttles timers in hidden pages.
  @Volatile private var hidden = false
  private var tickJob: kotlinx.coroutines.Job? = null

  private fun background(): JSONObject = JSONObject().put("supported", true).put("active", WatchService.active)
      .put("types", WatchService.types).put("hidden", hidden).put("tick", tickJob?.isActive == true)

  private fun pushBackground() { eventProxy?.let { postSafe(it, BridgeProtocol.event("background", background())) } }

  private fun startWatch() {
    if (!WatchService.active) WatchService.start(this)
    if (tickJob?.isActive != true) tickJob = lifecycleScope.launch {
      var n = 0L
      while (true) {
        delay(1_000); n++
        eventProxy?.let { postSafe(it, BridgeProtocol.event("tick", JSONObject().put("n", n).put("hidden", hidden))) }
        if (n == 2L) pushBackground()
      }
    }
  }

  private fun stopWatch() {
    tickJob?.cancel(); tickJob = null
    WatchService.stop(this)
    pushBackground()
  }

  override fun onStart() {
    super.onStart()
    hidden = false
    if (::web.isInitialized) { web.onResume(); web.resumeTimers() }
    remote("shell.visibility", JSONObject().put("hidden", false).put("watching", WatchService.active))
    pushBackground()
  }

  override fun onStop() {
    super.onStop()
    hidden = true // deliberately no web.onPause()/pauseTimers()
    remote("shell.visibility", JSONObject().put("hidden", true).put("watching", WatchService.active).put("types", WatchService.types))
    pushBackground()
  }

  private fun remote(type: String, data: JSONObject) {
    val url = appUrl
    data.put("hidden", hidden).put("device", MetaAi.device())
    lifecycleScope.launch { MetaAi.remoteLog(url, type, data) }
  }
  override fun onResume() { super.onResume(); if (::audio.isInitialized) audio.recheck() }

  /**
   * The one button the onboarding needs: asks for Bluetooth, links in Meta AI if needed, opens
   * Meta AI for updates, else starts the glasses session. Resolves to the status object plus
   * `step` (what it did) and, when it linked, `register`.
   */
  private suspend fun connectGlasses(): JSONObject {
    fun with(step: String, extra: JSONObject? = null) = JSONObject(hub.status.value.toString()).put("step", step)
        .also { if (extra != null) it.put("register", extra) }
    if (!granted(Manifest.permission.BLUETOOTH_CONNECT)) {
      androidPerms.launch(arrayOf(Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO))
      return with("asked_bluetooth")
    }
    if (!hub.glasses.initialize()) return with("sdk_init_failed")
    val gs = hub.status.value.optJSONObject("glassesStatus")?.optString("status")
    if (gs == "update_required") { MetaAi.openApp(this); return with("opened_meta_ai") }
    val reg = withTimeoutOrNull(4000) { Wearables.registrationState.first { it != RegistrationState.UNAVAILABLE } }
    if (reg != RegistrationState.REGISTERED) {
      val r = registerGlasses()
      return with("register", r)
    }
    hub.connect(); startWatch()
    return with("connect")
  }

  private suspend fun registerGlasses(): JSONObject {
    val out = JSONObject().put("device", MetaAi.device())
    val meta = MetaAi.find(this)
    out.put("metaAi", meta?.json() ?: JSONObject.NULL)
    suspend fun done(result: String, code: String?, message: String): JSONObject {
      out.put("result", result).put("code", code ?: JSONObject.NULL).put("message", message)
      runCatching { out.put("registration", hub.glasses.registrationState.name.lowercase()) }
      Log.i(TAG, "registerGlasses $out")
      val url = appUrl
      lifecycleScope.launch { MetaAi.remoteLog(url, "glasses.register", out) }
      return out
    }
    if (meta == null) return done("error", "meta_ai_missing",
        "Vela can't find the Meta AI app. Install it from the Play Store (button below), then try again.")
    val major = meta.major
    if (major != null && major < MetaAi.MIN_MAJOR) return done("error", "meta_ai_old",
        "Meta AI is version ${meta.versionName}; Vela needs V${MetaAi.MIN_MAJOR} or newer. Update Meta AI in the Play Store, then try again.")
    if (!granted(Manifest.permission.BLUETOOTH_CONNECT)) {
      androidPerms.launch(arrayOf(Manifest.permission.BLUETOOTH_CONNECT))
      return done("error", "bluetooth_permission", "Allow Nearby devices for Vela (Android just asked), then tap again.")
    }
    if (!hub.glasses.initialize()) return done("error", "sdk_init", "The glasses toolkit could not start. Restart Vela and try again.")
    // initialize() returns at once, but DAT connects to Meta AI's registrar asynchronously: wait for it.
    val st = withTimeoutOrNull(4000) {
      Wearables.registrationState.first { it != RegistrationState.UNAVAILABLE }
    }
    out.put("stateBefore", (st ?: hub.glasses.registrationState).name.lowercase())
    if (st == RegistrationState.REGISTERED) return done("ok", "already_registered", "Vela is already connected in Meta AI. Tap Connect.")
    val pausesBefore = pauseCount
    val err = CompletableDeferred<String>()
    val watch = lifecycleScope.launch(start = CoroutineStart.UNDISPATCHED) { err.complete(hub.glasses.registrationErrors.first()) }
    try {
      hub.glasses.register(this)
    } catch (t: Throwable) {
      watch.cancel()
      return done("error", "register_exception", "Meta AI could not be opened (${t.javaClass.simpleName}: ${t.message}). Try Open Meta AI below.")
    }
    var waited = 0
    while (waited < 5000) {
      if (err.isCompleted) break
      if (pauseCount != pausesBefore) { watch.cancel(); return done("ok", "opened", "Meta AI opened: approve Vela there, then come back and tap Connect.") }
      val s = hub.glasses.registrationState
      if (s == RegistrationState.REGISTERED) { watch.cancel(); return done("ok", "registered", "Vela is connected in Meta AI. Tap Connect.") }
      delay(200); waited += 200
    }
    watch.cancel()
    val e = if (err.isCompleted) err.await() else null
    return when (e) {
      null -> done("error", "no_response", "Meta AI did not open. Check Developer Mode is on in Meta AI (Settings → App info → tap the version 5 times), or tap Open Meta AI below and try again.")
      "already_registered" -> done("ok", "already_registered", "Vela is already connected in Meta AI. Tap Connect.")
      "meta_ai_not_installed" -> done("error", e, "The toolkit can't reach the Meta AI app. Update Meta AI in the Play Store, open it once, then try again.")
      "failed_to_register" -> done("error", e, "Meta AI refused the link. Check Developer Mode is on in Meta AI (Settings → App info → tap the version 5 times) and the glasses are paired, then try again.")
      else -> done("error", e, "Linking failed ($e). Open Meta AI, check Developer Mode, then try again.")
    }
  }

  private suspend fun handle(op: String, a: JSONObject): Any? = when (op) {
    "hello", "status" -> hub.status.value
    "connect" -> { hub.connect(); startWatch(); hub.status.value }
    "disconnect" -> { hub.disconnect(); stopWatch(); hub.status.value }
    "backgroundMode" -> background()
    "captureFrame" -> {
      if (!WatchService.active) startWatch()
      hub.capture(a.optInt("maxEdge", 1280).coerceIn(320, 2048),
          CaptureOpts(maxAgeMs = a.optLong("maxAgeMs", 700).coerceIn(0, 10_000), latest = a.optString("pick") == "latest"))
    }
    "registerGlasses" -> JSONObject(hub.status.value.toString()).put("register", registerGlasses())
    "connectGlasses" -> connectGlasses()
    "openMetaAi" -> {
      val ok = when (a.optString("target")) {
        "settings" -> MetaAi.openSettings(this)
        "store" -> MetaAi.openStore(this)
        else -> MetaAi.openApp(this)
      }
      JSONObject().put("opened", ok).put("metaAi", MetaAi.find(this)?.json() ?: JSONObject.NULL)
    }
    "unregisterGlasses" -> { hub.glasses.unregister(this); hub.status.value }
    "setSource" -> {
      hub.setPref(SourcePref.parse(a.optString("source")) ?: throw CaptureException("bad_args", "source must be auto|glasses|phone"))
      hub.status.value
    }
    "setCaptureMode" -> {
      hub.glasses.setCaptureMode(CaptureMode.parse(a.optString("mode")) ?: throw CaptureException("bad_args", "mode must be live|photo|stream"))
      hub.status.value
    }
    "useMock" -> {
      val enable = a.optBoolean("enabled", true)
      val fixture = a.optString("image", "").takeIf { it.isNotEmpty() }?.let { b64 ->
        File(cacheDir, "mock-custom.jpg").apply { writeBytes(Base64.decode(b64.substringAfter("base64,"), Base64.DEFAULT)) }
      } ?: mockFixture()
      if (a.has("power")) hub.glasses.mockPower(a.optBoolean("power"))
      else if (!enable || !hub.glasses.info.value.mock) hub.glasses.useMock(enable, fixture)
      else hub.glasses.setMockPhoto(fixture)
      if (enable && a.optBoolean("connect", true)) hub.connect()
      hub.status.value
    }
    "audioRoute" -> audio.describe()
    "setMicRoute" -> audio.setMic(a.optString("route") == "glasses")
    else -> throw CaptureException("unknown_op", op)
  }

  /** The bundled mock photo (a letter on a table), copied to a real file as DAT's mock requires. */
  private fun mockFixture(): File = File(cacheDir, "mock-letter.jpg").apply {
    if (!exists()) assets.open("mock/letter.jpg").use { i -> outputStream().use { i.copyTo(it) } }
  }

  override fun onDestroy() {
    stopWatch()
    audio.stopGuard()
    // lifecycleScope is already cancelled here; finish the teardown on a short-lived scope.
    kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Main).launch {
      kotlinx.coroutines.withTimeoutOrNull(3_000) { hub.disconnect() }
    }
    audio.setMic(false)
    web.destroy()
    super.onDestroy()
  }
}
