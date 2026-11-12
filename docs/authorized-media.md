# Authorized media in Lilin

Lilin is a self-hosted library and playback application for media you own or are authorized to use. No particular content source is bundled.

## Quick setup

1. Install Lilin using the platform guide in `docs/install/`, or run `node setup.js`.
2. Choose a `MEDIA_DIR` containing videos you own or have permission to use. Existing files are scanned into the Library.
3. Optional: connect qBittorrent using `QBIT_URL`, `QBIT_USER`, and `QBIT_PASS`.
4. In the Lilin interface, select **Add authorized download** and paste a magnet link or a public HTTPS link to a `.torrent` file from a source that grants you download rights.
5. Follow its transfer status in Library. When complete, Lilin retains its playback, subtitles, and conversion features.

For example, you can import your own recordings, your own ripped files where permitted, or public-domain and openly licensed video distributed by its rights holder. Verify the license before adding a download.

## What changed

- Built-in searches of third-party public torrent indexes are disabled in the standard distribution, regardless of `TORRENTS` configuration.
- The legacy one-click automatic release search is unavailable.
- Existing media libraries, qBittorrent transfer management, TV playback, ffmpeg conversion, and user accounts remain available.
- Users can still supply authorized torrent links or media files themselves.

## Legal

Lilin does not grant permission to copy, redistribute, or download third-party copyrighted work. Users are responsible for confirming that their sources and uses are authorized. This documentation is not legal advice.
