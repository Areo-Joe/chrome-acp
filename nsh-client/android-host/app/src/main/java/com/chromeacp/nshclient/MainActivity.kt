package com.chromeacp.nshclient

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.longbridge.nsh.NshView

class MainActivity : ComponentActivity() {
    private var nsh: NshView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            BackHandler {
                if (nsh?.handleBack() != true) finish()
            }
            AndroidView(
                modifier = Modifier.fillMaxSize().safeDrawingPadding(),
                factory = { context ->
                    NshView(context).also { view ->
                        nsh = view
                        view.setErrorListener { Log.e("nsh-client", it) }
                        val devServer = if (BuildConfig.DEBUG) intent.getStringExtra("dev_server") else null
                        if (devServer != null) {
                            check(view.connectDevServer(devServer)) { "Cannot connect to the NSH dev server" }
                        } else {
                            check(view.loadAssetBundle("nsh")) { "Cannot load the bundled TSX" }
                        }
                    }
                },
                onRelease = { view ->
                    view.destroy()
                    if (nsh === view) nsh = null
                },
            )
        }
    }
}
