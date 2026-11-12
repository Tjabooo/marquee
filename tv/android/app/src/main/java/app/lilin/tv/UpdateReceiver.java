package app.lilin.tv;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.util.Log;

/** Android's answer to a quiet install (SelfUpdate). A successful one has replaced this app by now. */
public final class UpdateReceiver extends BroadcastReceiver {
  static final String EXTRA_CODE = "app.lilin.tv.UPDATE_CODE";

  @Override public void onReceive(Context ctx, Intent intent) {
    int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
    int code = intent.getIntExtra(EXTRA_CODE, 0);
    if (status == PackageInstaller.STATUS_SUCCESS) return;
    Log.w("LilinUpdate", "quiet install of " + code + " didn't go through: " + status + " "
        + intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
      // This TV wants a person to confirm: never pop that up by itself. The app offers it at its next start.
      int session = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1);
      if (session >= 0) {
        try { ctx.getPackageManager().getPackageInstaller().abandonSession(session); } catch (Exception ignored) { /* gone */ }
      }
    }
    SelfUpdate.refused(ctx, code);
  }
}
