package app.marquee.tv;

import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import android.os.Build;

import java.util.Locale;

/** What this TV's hardware can decode, which picks the video Marquee sends (/api/play-link). */
final class Codecs {
  private Codecs() {}

  /**
   * "browser-hevc": the same file the Samsung app plays (HEVC, often 10-bit and 4K) when a hardware
   * decoder handles HEVC Main 10 at 4K. Otherwise "browser&quality=auto": Marquee sends an H.264 copy,
   * or a live 1080p stream when the file is too heavy for that.
   */
  static String playVariant() {
    return hevc10At4k() ? "browser-hevc" : "browser&quality=auto";
  }

  static boolean hevc10At4k() {
    try {
      for (MediaCodecInfo info : new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos()) {
        if (info.isEncoder() || !hardware(info)) continue;
        for (String type : info.getSupportedTypes()) {
          if (!MediaFormat.MIMETYPE_VIDEO_HEVC.equalsIgnoreCase(type)) continue;
          MediaCodecInfo.CodecCapabilities caps = info.getCapabilitiesForType(type);
          boolean main10 = false;
          for (MediaCodecInfo.CodecProfileLevel pl : caps.profileLevels) {
            if (pl.profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10
                || pl.profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10HDR10) main10 = true;
          }
          MediaCodecInfo.VideoCapabilities video = caps.getVideoCapabilities();
          if (main10 && video != null && video.isSizeSupported(3840, 2160)) return true;
        }
      }
    } catch (RuntimeException e) {
      // a broken codec list: play it safe
    }
    return false;
  }

  private static boolean hardware(MediaCodecInfo info) {
    if (Build.VERSION.SDK_INT >= 29) return info.isHardwareAccelerated() && !info.isSoftwareOnly();
    String n = info.getName().toLowerCase(Locale.ROOT);
    return !(n.startsWith("omx.google.") || n.startsWith("c2.android.") || n.contains(".sw."));
  }
}
