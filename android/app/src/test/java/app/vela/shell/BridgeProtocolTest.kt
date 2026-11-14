package app.vela.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeProtocolTest {
  @Test fun parsesKnownOps() {
    val r = BridgeProtocol.parse("""{"id":3,"op":"captureFrame","args":{"maxEdge":640}}""")
    assertNotNull(r); assertEquals(3L, r!!.id); assertEquals(640, r.args.getInt("maxEdge"))
  }

  @Test fun rejectsGarbageAndUnknownOps() {
    assertNull(BridgeProtocol.parse(null))
    assertNull(BridgeProtocol.parse("not json"))
    assertNull(BridgeProtocol.parse("""{"id":1,"op":"rm -rf"}"""))
    assertNull(BridgeProtocol.parse("""{"op":"status"}"""))
    assertNull(BridgeProtocol.parse("x".repeat(70_000)))
  }

  @Test fun missingArgsBecomeEmpty() {
    assertEquals(0, BridgeProtocol.parse("""{"id":1,"op":"status"}""")!!.args.length())
  }

  @Test fun repliesAreWellFormed() {
    val ok = JSONObject(BridgeProtocol.ok(5, JSONObject().put("state", "ready")))
    assertTrue(ok.getBoolean("ok")); assertEquals("ready", ok.getJSONObject("result").getString("state"))
    val bad = JSONObject(BridgeProtocol.fail(6, "glasses_timeout", "slow"))
    assertFalse(bad.getBoolean("ok")); assertEquals("glasses_timeout", bad.getJSONObject("error").getString("code"))
    val ev = JSONObject(BridgeProtocol.event("state", JSONObject().put("state", "disconnected")))
    assertEquals("state", ev.getString("event")); assertFalse(ev.has("id"))
  }
}
