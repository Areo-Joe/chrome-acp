package com.chromeacp.nshclient

import com.longbridge.nsh.NshView
import org.json.JSONObject
import java.util.concurrent.Executors

/** The same Rust image preparation used by the macOS host. */
object ImageCodec {
    init { System.loadLibrary("nsh_client_image_codec") }
    private val executor = Executors.newSingleThreadExecutor()
    @JvmStatic external fun normalize(request: String): String

    fun register(view: NshView) {
        view.handle("image.normalize") { data, reply ->
            executor.execute {
                try {
                    val result = JSONObject(normalize(JSONObject(data as Map<*, *>).toString()))
                    if (result.has("supported")) {
                        reply.resolve(mapOf("supported" to result.getBoolean("supported"), "data" to result.optString("data")))
                        return@execute
                    }
                    reply.resolve(mapOf("data" to result.getString("data"), "mimeType" to "image/png",
                        "width" to result.getInt("width"), "height" to result.getInt("height")))
                } catch (error: Exception) { reply.reject(error.message ?: "Failed to convert image") }
            }
        }
    }
}
