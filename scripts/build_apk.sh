#!/usr/bin/env bash
# ImageFix APK 빌드 (Android SDK / Gradle 없이)
#   웹 번들(esbuild) → aapt(리소스) → javac → d8 → zipalign → apksigner
# 결과: release/ImageFix_<YYYY-MM-DD>.apk
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOLS="${IMAGEFIX_TOOLS:-/opt/imagefix-tools}"
DATE="${BUILD_DATE:-$(date +%Y-%m-%d)}"
VERSION_NAME="$(tr -d '[:space:]' < "$ROOT/VERSION")"
VERSION_CODE="${VERSION_CODE:-$(date -u +%y%m%d%H)}"
MIN_SDK=26
TARGET_SDK=34
SRC="$ROOT/app/src/main"
BUILD="$ROOT/build/apk"
OUT="$ROOT/release/ImageFix_${DATE}.apk"
KS="${KEYSTORE:-$ROOT/keystore/imagefix.jks}"
KS_PASS="${KEYSTORE_PASS:-imagefix}"
KS_ALIAS="${KEYSTORE_ALIAS:-imagefix}"

[ -s "$TOOLS/android.jar" ] && [ -s "$TOOLS/r8lib.jar" ] && command -v aapt >/dev/null || "$ROOT/scripts/setup_toolchain.sh"

if [ ! -f "$KS" ]; then
  echo "[keystore] 새 서명 키 생성: $KS"
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -keystore "$KS" -storepass "$KS_PASS" -keypass "$KS_PASS" -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=ImageFix, O=ImageFix, C=KR" 2>/dev/null
fi

rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/dex" "$ROOT/release"

if [ -f "$ROOT/web/build.mjs" ] && [ "${SKIP_WEB:-0}" != "1" ]; then
  echo "[web] 번들 빌드"
  (cd "$ROOT/web" && node build.mjs)
fi

echo "[aapt] 리소스/매니페스트/에셋 패키징"
aapt package -f -M "$SRC/AndroidManifest.xml" -S "$SRC/res" -A "$SRC/assets" -I "$TOOLS/android.jar" \
  --min-sdk-version "$MIN_SDK" --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  -0 arsc -F "$BUILD/base.apk"

echo "[javac] 컴파일"
find "$SRC/java" -name '*.java' > "$BUILD/sources.txt"
javac --release 8 -Xlint:-options -encoding UTF-8 -cp "$TOOLS/android.jar" -d "$BUILD/classes" @"$BUILD/sources.txt" 2>&1 | grep -v 'Picked up JAVA_TOOL_OPTIONS' || true
[ -n "$(find "$BUILD/classes" -name '*.class' -print -quit)" ] || { echo "컴파일 실패"; exit 1; }

echo "[d8] dex 변환"
java -cp "$TOOLS/r8lib.jar" com.android.tools.r8.D8 --release --min-api "$MIN_SDK" \
  --lib "$TOOLS/android.jar" --output "$BUILD/dex" $(find "$BUILD/classes" -name '*.class') 2>&1 | grep -v 'Picked up JAVA_TOOL_OPTIONS' || true
[ -f "$BUILD/dex/classes.dex" ] || { echo "d8 실패"; exit 1; }
(cd "$BUILD/dex" && aapt add "$BUILD/base.apk" classes.dex >/dev/null)

echo "[zipalign/apksigner] 정렬·서명"
zipalign -f -p 4 "$BUILD/base.apk" "$BUILD/aligned.apk"
rm -f "$OUT" "$OUT.idsig"
apksigner sign --ks "$KS" --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" --ks-key-alias "$KS_ALIAS" \
  --min-sdk-version "$MIN_SDK" --out "$OUT" "$BUILD/aligned.apk" 2>&1 | grep -v 'Picked up JAVA_TOOL_OPTIONS' || true
rm -f "$OUT.idsig"
apksigner verify --verbose --print-certs "$OUT" 2>&1 | grep -v 'Picked up JAVA_TOOL_OPTIONS' | head -12

echo "[완료] $OUT ($(du -h "$OUT" | cut -f1))  versionName=$VERSION_NAME versionCode=$VERSION_CODE"
sha256sum "$OUT" | cut -d' ' -f1 | sed 's/^/sha256: /'

# 앱 안 업데이트 확인용 매니페스트(release/latest.json): 앱이 GitHub 의 이 파일을 읽어 새 버전을 알려 준다. APK 와 같이 커밋/푸시해야 한다.
python3 - "$OUT" "$VERSION_CODE" "$VERSION_NAME" "$ROOT/release/NOTES.txt" > "$ROOT/release/latest.json" <<'PY'
import sys, json, hashlib, os
apk, code, name, nf = sys.argv[1:5]
d = open(apk, 'rb').read()
notes = open(nf, encoding='utf-8').read().strip() if os.path.exists(nf) else ''
print(json.dumps({'versionCode': int(code), 'versionName': name, 'apk': 'release/' + os.path.basename(apk), 'sha256': hashlib.sha256(d).hexdigest(), 'size': len(d), 'notes': notes}, ensure_ascii=False, indent=2))
PY
echo "[매니페스트] release/latest.json (apk 와 함께 커밋·푸시)"
