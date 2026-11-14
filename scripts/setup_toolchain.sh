#!/usr/bin/env bash
# Android SDK 없이 APK를 빌드하기 위한 최소 툴체인 설치.
#  - aapt / apksigner / zipalign : apt (Ubuntu universe)
#  - android.jar (API 34)        : Maven Central  org.robolectric:android-all (프레임워크 클래스+리소스)
#  - d8                          : r8lib.jar (storage.googleapis.com/r8-releases)
set -euo pipefail
TOOLS="${IMAGEFIX_TOOLS:-/opt/imagefix-tools}"
ANDROID_ALL_VER="${ANDROID_ALL_VER:-14-robolectric-10818077}"   # = Android 14 / API 34
R8_VER="${R8_VER:-8.7.18}"
mkdir -p "$TOOLS"

if ! command -v aapt >/dev/null || ! command -v apksigner >/dev/null || ! command -v zipalign >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends aapt apksigner zipalign
fi

fetch() { # url out
  if [ -s "$2" ]; then return 0; fi
  curl -fsSL --retry 5 --retry-delay 3 -C - -o "$2.part" "$1"
  mv "$2.part" "$2"
}
fetch "https://repo1.maven.org/maven2/org/robolectric/android-all/${ANDROID_ALL_VER}/android-all-${ANDROID_ALL_VER}.jar" "$TOOLS/android.jar"
fetch "https://storage.googleapis.com/r8-releases/raw/${R8_VER}/r8lib.jar" "$TOOLS/r8lib.jar"
echo "toolchain ready: $TOOLS"
ls -la "$TOOLS"
