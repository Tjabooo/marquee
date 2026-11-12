package app.lilin.tv;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;

/**
 * Keeps the app up to date while nobody uses it (Android 12+, see SelfUpdate): every few hours, and a few
 * seconds after the app leaves the screen, so an update found while watching installs once you're done.
 */
public final class UpdateJob extends JobService {
  private static final int PERIODIC = 1, SOON = 2;

  /** Every 6 hours, also after a restart of the TV. */
  static void schedule(Context c) {
    if (Build.VERSION.SDK_INT < 31) return; // older Android always asks: the app offers updates itself
    JobScheduler js = c.getSystemService(JobScheduler.class);
    if (js == null || js.getPendingJob(PERIODIC) != null) return;
    js.schedule(new JobInfo.Builder(PERIODIC, new ComponentName(c, UpdateJob.class))
        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
        .setPeriodic(6 * 60 * 60 * 1000L)
        .setPersisted(true)
        .build());
  }

  /** The app just left the screen: install a waiting update in a moment, unless it comes back first. */
  static void soon(Context c) {
    if (!SelfUpdate.canInstallQuietly(c)) return;
    JobScheduler js = c.getSystemService(JobScheduler.class);
    if (js == null) return;
    js.schedule(new JobInfo.Builder(SOON, new ComponentName(c, UpdateJob.class))
        .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
        .setMinimumLatency(5_000)
        .build());
  }

  @Override public boolean onStartJob(JobParameters params) {
    new Thread(() -> {
      SelfUpdate.run(getApplicationContext());
      jobFinished(params, false); // after an install Android closes the app any moment now: done either way
    }, "lilin-update-job").start();
    return true;
  }

  @Override public boolean onStopJob(JobParameters params) { return false; }
}
