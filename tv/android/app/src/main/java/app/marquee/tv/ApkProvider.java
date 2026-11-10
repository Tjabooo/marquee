package app.marquee.tv;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/** Hands the downloaded update to Android's installer (it may not read the app's own files directly). */
public final class ApkProvider extends ContentProvider {
  private static final String AUTHORITY = "app.marquee.tv.update";
  private static final String MIME = "application/vnd.android.package-archive";

  static File file(Context c) { return new File(c.getCacheDir(), "Marquee-update.apk"); }
  static Uri uri() { return Uri.parse("content://" + AUTHORITY + "/Marquee.apk"); }

  @Override public boolean onCreate() { return true; }
  @Override public String getType(Uri uri) { return MIME; }

  @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
    if (!"r".equals(mode)) throw new FileNotFoundException("read only");
    return ParcelFileDescriptor.open(file(getContext()), ParcelFileDescriptor.MODE_READ_ONLY);
  }

  @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) {
    MatrixCursor c = new MatrixCursor(new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE });
    c.addRow(new Object[] { "Marquee.apk", file(getContext()).length() });
    return c;
  }

  @Override public Uri insert(Uri uri, ContentValues values) { return null; }
  @Override public int delete(Uri uri, String selection, String[] args) { return 0; }
  @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { return 0; }
}
