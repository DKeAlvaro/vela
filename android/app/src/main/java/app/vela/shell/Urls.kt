package app.vela.shell

import android.net.Uri

object Urls {
  /** `https://host/path?x=1` + device=glasses. Pure, unit-tested. */
  fun withDevice(url: String): String {
    if (Regex("[?&]device=").containsMatchIn(url)) return url
    val (base, frag) = url.split('#', limit = 2).let { it[0] to it.getOrNull(1) }
    val sep = if (base.contains('?')) (if (base.endsWith('?') || base.endsWith('&')) "" else "&") else "?"
    return base + sep + "device=glasses" + (frag?.let { "#$it" } ?: "")
  }

  /** "https://host:port" of a URL, the only origin (with the local assets) the bridge talks to. */
  fun originOf(url: String): String {
    val u = Uri.parse(url)
    val port = if (u.port > 0) ":${u.port}" else ""
    return "${u.scheme}://${u.host}$port"
  }
}
