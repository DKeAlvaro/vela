package app.vela.shell

import org.json.JSONObject

/**
 * Wire format between the page and the shell (JSON strings over a WebMessage channel):
 *   page -> shell  {"id": 7, "op": "captureFrame", "args": {...}}
 *   shell -> page  {"id": 7, "ok": true, "result": ...}  |  {"id": 7, "ok": false, "error": {"code","message"}}
 *   shell -> page  {"event": "state", "status": {...}}     (pushed, no id)
 */
object BridgeProtocol {
  val OPS = setOf(
      "hello", "status", "connect", "disconnect", "captureFrame", "registerGlasses",
      "unregisterGlasses", "setSource", "setCaptureMode", "useMock", "audioRoute", "setMicRoute",
      "openMetaAi", "connectGlasses", "backgroundMode",
  )

  data class Request(val id: Long, val op: String, val args: JSONObject)

  /** Returns null for anything that isn't a well-formed request for a known op. */
  fun parse(raw: String?): Request? {
    if (raw == null || raw.length > 64_000) return null
    val o = try { JSONObject(raw) } catch (_: Exception) { return null }
    val id = o.optLong("id", -1)
    val op = o.optString("op", "")
    if (id < 0 || op !in OPS) return null
    return Request(id, op, o.optJSONObject("args") ?: JSONObject())
  }

  fun ok(id: Long, result: Any?): String =
      JSONObject().put("id", id).put("ok", true).put("result", result ?: JSONObject.NULL).toString()

  fun fail(id: Long, code: String, message: String): String =
      JSONObject().put("id", id).put("ok", false)
          .put("error", JSONObject().put("code", code).put("message", message)).toString()

  fun event(name: String, payload: JSONObject): String =
      JSONObject().put("event", name).put("status", payload).toString()
}
