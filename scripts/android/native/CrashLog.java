package com.blutheist.music;

import android.app.ActivityManager;
import android.app.ApplicationExitInfo;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * A small, dependency-free crash recorder.
 *
 *  - Java exceptions that kill the app are written (with their stack) to files/last-crash.txt before the
 *    process dies.
 *  - Deaths Java never sees (a crash inside the embedded Node.js or Chromium, the system reclaiming memory,
 *    an ANR) are read back on the next launch from Android's own process-exit history (API 30+).
 *  - The page shows the file once, offers to copy/share it, then clears it.
 */
final class CrashLog {
    private static final String FILE = "last-crash.txt";
    private static final String PREFS = "blutheist_crashlog";
    private static final int MAX_BYTES = 48 * 1024;

    private CrashLog() {}

    private static File file(Context c) {
        return new File(c.getFilesDir(), FILE);
    }

    private static String now() {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date());
    }

    /** Appends a timestamped entry; never throws. */
    static synchronized void note(Context c, String text) {
        try {
            File f = file(c);
            String old = "";
            if (f.exists() && f.length() < MAX_BYTES) {
                old = readFully(f);
            }
            String entry = "[" + now() + "] " + text + "\n\n";
            try (FileOutputStream out = new FileOutputStream(f, false)) {
                out.write((old + entry).getBytes(StandardCharsets.UTF_8));
            }
        } catch (Throwable ignored) {
            // The recorder must never be the thing that crashes.
        }
    }

    /** java.nio.file.Files needs API 26; the app's minSdk is 24, so a plain stream it is. */
    private static String readFully(File f) throws java.io.IOException {
        try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    static String read(Context c) {
        try {
            File f = file(c);
            if (!f.exists()) return "";
            return readFully(f);
        } catch (Throwable t) {
            return "";
        }
    }

    static void clear(Context c) {
        try {
            //noinspection ResultOfMethodCallIgnored
            file(c).delete();
        } catch (Throwable ignored) {
        }
    }

    /** Records uncaught Java exceptions, then lets Android's normal handling continue. */
    static void install(final Context c) {
        final Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override
            public void uncaughtException(Thread t, Throwable e) {
                try {
                    StringWriter sw = new StringWriter();
                    e.printStackTrace(new PrintWriter(sw));
                    note(c, "JAVA CRASH (thread " + t.getName() + ")\n" + sw);
                } catch (Throwable ignored) {
                }
                if (previous != null) previous.uncaughtException(t, e);
            }
        });
    }

    private static String reasonName(int r) {
        if (Build.VERSION.SDK_INT < 30) return "UNKNOWN";
        switch (r) {
            case ApplicationExitInfo.REASON_ANR: return "ANR (app not responding)";
            case ApplicationExitInfo.REASON_CRASH: return "CRASH (Java exception)";
            case ApplicationExitInfo.REASON_CRASH_NATIVE: return "CRASH_NATIVE (native code, e.g. the embedded Node.js or the web engine)";
            case ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE: return "EXCESSIVE_RESOURCE_USAGE";
            case ApplicationExitInfo.REASON_EXIT_SELF: return "EXIT_SELF (the app called exit)";
            case ApplicationExitInfo.REASON_INITIALIZATION_FAILURE: return "INITIALIZATION_FAILURE";
            case ApplicationExitInfo.REASON_LOW_MEMORY: return "LOW_MEMORY (killed by the system to free memory)";
            case ApplicationExitInfo.REASON_SIGNALED: return "SIGNALED (killed by a signal)";
            case ApplicationExitInfo.REASON_OTHER: return "OTHER";
            default: return "UNKNOWN(" + r + ")";
        }
    }

    /** On the next launch: asks Android how the previous process ended, and records it if it wasn't a normal exit. */
    static void recordPreviousExit(Context c) {
        if (Build.VERSION.SDK_INT < 30) return;
        try {
            ActivityManager am = (ActivityManager) c.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return;
            List<ApplicationExitInfo> list = am.getHistoricalProcessExitReasons(c.getPackageName(), 0, 6);
            if (list == null || list.isEmpty()) return;
            SharedPreferences sp = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            long seen = sp.getLong("lastExitSeen", 0L);
            long newest = seen;
            for (ApplicationExitInfo i : list) {
                long ts = i.getTimestamp();
                if (ts <= seen) continue;
                if (ts > newest) newest = ts;
                int r = i.getReason();
                // Ordinary ends: the user swiped it away, the system stopped it for a permission/user change.
                if (r == ApplicationExitInfo.REASON_USER_REQUESTED
                        || r == ApplicationExitInfo.REASON_USER_STOPPED
                        || r == ApplicationExitInfo.REASON_PERMISSION_CHANGE
                        || r == ApplicationExitInfo.REASON_DEPENDENCY_DIED
                        || r == ApplicationExitInfo.REASON_FREEZER) continue;
                String proc = i.getProcessName() == null ? "?" : i.getProcessName();
                note(c, "PREVIOUS RUN ENDED: " + reasonName(r)
                        + "\nprocess: " + proc
                        + "\nstatus: " + i.getStatus()
                        + "\ndescription: " + (i.getDescription() == null ? "-" : i.getDescription())
                        + "\nmemory (rss/pss KB): " + i.getRss() / 1024 + " / " + i.getPss() / 1024
                        + "\nat: " + new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date(ts)));
            }
            sp.edit().putLong("lastExitSeen", newest).apply();
        } catch (Throwable ignored) {
        }
    }

    /** True when the WebView renderer has died this many times within the window (guards a restart loop). */
    static boolean rendererLoop(Context c, int limit, long windowMs) {
        SharedPreferences sp = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long now = System.currentTimeMillis();
        long first = sp.getLong("rendererFirst", 0L);
        int count = sp.getInt("rendererCount", 0);
        if (now - first > windowMs) {
            first = now;
            count = 0;
        }
        count++;
        sp.edit().putLong("rendererFirst", first).putInt("rendererCount", count).apply();
        return count > limit;
    }
}
