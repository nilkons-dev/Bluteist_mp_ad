package com.blutheist.music;

import android.annotation.TargetApi;
import android.os.Build;
import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        CrashLog.install(getApplicationContext());
        // Local plugins must be registered before super.onCreate().
        registerPlugin(BlutheistNative.class);
        super.onCreate(savedInstanceState);
        CrashLog.recordPreviousExit(getApplicationContext());
        guardRenderer();
    }

    /**
     * Android's WebView runs the page in a separate process. If the system kills it (low memory) or it crashes,
     * an app that doesn't handle onRenderProcessGone is killed with it. Here the page is simply rebuilt, and the
     * event is recorded so the next start can say what happened and fall back to lighter graphics.
     */
    private void guardRenderer() {
        final Bridge bridge = getBridge();
        if (bridge == null) return;
        bridge.setWebViewClient(
            new BridgeWebViewClient(bridge) {
                @Override
                @TargetApi(Build.VERSION_CODES.O)
                public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    CrashLog.note(
                        getApplicationContext(),
                        "WEB ENGINE " + (detail.didCrash() ? "CRASHED" : "WAS KILLED BY THE SYSTEM (low memory)")
                            + " (renderer priority at exit: " + detail.rendererPriorityAtExit() + ")"
                    );
                    if (CrashLog.rendererLoop(getApplicationContext(), 3, 60_000L)) {
                        // It keeps dying: stop here instead of restarting forever.
                        runOnUiThread(MainActivity.this::finish);
                        return true;
                    }
                    runOnUiThread(MainActivity.this::recreate);
                    return true;
                }
            }
        );
    }
}
