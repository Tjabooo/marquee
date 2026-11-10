#!/usr/bin/env bash
# Builds Marquee's Android TV app. See docs/android-tv.md.
#
#   MARQUEE_URL=http://192.168.1.10:8080 tv/android/build.sh     # tv/android/dist/Marquee.apk + Marquee.json
#   tv/android/build.sh --publish                                # …and copy both to PUBLISH_TO (the server's tv/android/dist)
#   TV=192.168.1.30 tv/android/build.sh --install                # …and install + start it on that TV over adb
#   tv/android/build.sh --debug                                  # a debuggable build (chrome://inspect sees the page)
#
# The server offers tv/android/dist/Marquee.apk at /android (the steps) and /android.apk (the file).
# Built where Marquee runs, it's there already; elsewhere, --publish copies it over (scp).
#
# Settings (environment, or tv/android/.env):
#   MARQUEE_URL        where the TV reaches Marquee, e.g. http://192.168.1.10:8080. Empty: the app asks on its first start.
#   PUBLISH_TO         scp target for --publish, e.g. server:/opt/marquee/tv/android/dist/
#   TV                 the TV's address for --install (adb; port 5555 is added when missing)
#   ANDROID_HOME       the Android SDK (platform 36, build-tools); JAVA_HOME a JDK 17–21
#   ANDROID_KEYSTORE   the signing key (default ~/.config/marquee-tv/android.jks; made on the first build)
#   ANDROID_KEYSTORE_PASSWORD_FILE  its password (default ~/.config/marquee-tv/android-keystore-password)
# Keep the key safe: an update signed with another key won't install over the app.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
# .env fills in what the environment doesn't already set (MARQUEE_URL= on the command line wins).
if [ -f "$here/.env" ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    value="${value%\"}"; value="${value#\"}"
    [ -z "${!key+set}" ] && export "$key=$value"
  done < "$here/.env"
fi

publish=0; install=0; variant=release
for arg in "$@"; do
  case "$arg" in
    --publish) publish=1 ;;
    --install) install=1 ;;
    --debug) variant=debug ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

server="${MARQUEE_URL:-}"; server="${server%/}"
case "$server" in ""|http://*|https://*) ;; *) echo "MARQUEE_URL must start with http:// or https://" >&2; exit 2 ;; esac
: "${ANDROID_HOME:?Set ANDROID_HOME to the Android SDK}"
export ANDROID_HOME
[ -n "${JAVA_HOME:-}" ] && export JAVA_HOME && PATH="$JAVA_HOME/bin:$PATH"

# The signing key: made once, then reused for every build so updates install over the app.
keystore="${ANDROID_KEYSTORE:-$HOME/.config/marquee-tv/android.jks}"
passfile="${ANDROID_KEYSTORE_PASSWORD_FILE:-$HOME/.config/marquee-tv/android-keystore-password}"
keytool="${JAVA_HOME:+$JAVA_HOME/bin/}keytool"
if [ ! -f "$keystore" ]; then
  mkdir -p "$(dirname "$keystore")" "$(dirname "$passfile")"
  [ -f "$passfile" ] || (umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$passfile")
  "$keytool" -genkeypair -keystore "$keystore" -storetype PKCS12 -alias marquee -keyalg RSA -keysize 3072 -validity 10000 \
    -dname "CN=Marquee TV" -storepass "$(cat "$passfile")" -keypass "$(cat "$passfile")" >/dev/null 2>&1
  chmod 600 "$keystore"
  echo "Made a signing key: $keystore (password in $passfile). Back both up: updates need the same key."
fi
export MARQUEE_ANDROID_KEYSTORE="$keystore"
MARQUEE_ANDROID_KEYSTORE_PASSWORD="$(cat "$passfile")"; export MARQUEE_ANDROID_KEYSTORE_PASSWORD

cd "$here"
task=assembleRelease; [ "$variant" = debug ] && task=assembleDebug
./gradlew -q "$task" -PmarqueeUrl="$server" --console=plain 2>&1 | grep -v '^$' || true
apk="$here/app/build/outputs/apk/$variant/app-$variant.apk"
[ -f "$apk" ] || { echo "The build failed (no $apk)." >&2; exit 1; }
# assembleDebug signs with the SDK's debug key; re-sign so a debug build can replace the real one and back.
if [ "$variant" = debug ]; then
  apksigner="$(ls -d "$ANDROID_HOME"/build-tools/*/ | sort -V | tail -1)apksigner"
  "$apksigner" sign --ks "$keystore" --ks-pass "file:$passfile" --ks-key-alias marquee "$apk"
fi

mkdir -p dist
cp "$apk" dist/Marquee.apk
code="$(sed -n 's/^code=//p' version.properties)"; name="$(sed -n 's/^name=//p' version.properties)"
sha="$(sha256sum dist/Marquee.apk | cut -d' ' -f1)"
printf '{"versionCode":%s,"versionName":"%s","size":%s,"sha256":"%s","debug":%s}\n' \
  "$code" "$name" "$(stat -c %s dist/Marquee.apk)" "$sha" "$([ "$variant" = debug ] && echo true || echo false)" > dist/Marquee.json
echo "Built dist/Marquee.apk (version $name, $(( $(stat -c %s dist/Marquee.apk) / 1024 )) KB) for ${server:-an address asked on first start}"

if [ "$publish" = 1 ]; then
  : "${PUBLISH_TO:?Set PUBLISH_TO to where the server keeps tv/android/dist, e.g. server:/opt/marquee/tv/android/dist/}"
  scp -q dist/Marquee.apk dist/Marquee.json "$PUBLISH_TO"
  echo "Published to $PUBLISH_TO"
fi

if [ "$install" = 1 ]; then
  : "${TV:?Set TV to the address of the TV to install}"
  target="$TV"; case "$target" in *:*) ;; *) target="$target:5555" ;; esac
  adb="$ANDROID_HOME/platform-tools/adb"
  "$adb" connect "$target" >/dev/null
  "$adb" -s "$target" install -r dist/Marquee.apk | tail -1
  "$adb" -s "$target" shell am start -n app.marquee.tv/.MainActivity >/dev/null && echo "Started Marquee on $target"
fi
