package com.blutheist.music;

import android.Manifest;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Runtime permissions the web layer can't ask for by itself:
 *  - reading the music on the phone (READ_MEDIA_AUDIO on Android 13+, READ_EXTERNAL_STORAGE before)
 *  - showing the playback notification (POST_NOTIFICATIONS on Android 13+)
 */
@CapacitorPlugin(
    name = "BlutheistNative",
    permissions = {
        @Permission(alias = "audio33", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "audioLegacy", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class BlutheistNative extends Plugin {

    private String audioAlias() {
        return Build.VERSION.SDK_INT >= 33 ? "audio33" : "audioLegacy";
    }

    private void respond(PluginCall call, boolean granted) {
        JSObject ret = new JSObject();
        ret.put("granted", granted);
        call.resolve(ret);
    }

    @PluginMethod
    public void audioPermission(PluginCall call) {
        respond(call, getPermissionState(audioAlias()) == PermissionState.GRANTED);
    }

    @PluginMethod
    public void requestAudioPermission(PluginCall call) {
        if (getPermissionState(audioAlias()) == PermissionState.GRANTED) {
            respond(call, true);
            return;
        }
        requestPermissionForAlias(audioAlias(), call, "audioPermsCallback");
    }

    @PermissionCallback
    private void audioPermsCallback(PluginCall call) {
        respond(call, getPermissionState(audioAlias()) == PermissionState.GRANTED);
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {
            respond(call, true);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationsCallback");
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        respond(call, getPermissionState("notifications") == PermissionState.GRANTED);
    }
}
