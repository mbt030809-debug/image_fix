#!/usr/bin/env bash
# AiClient / KeyVault JVM 테스트 (모의 HTTP 서버). 실기기와 같은 소스를 android.jar 로 컴파일해 JVM 에서 실행한다.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TOOLS="${IMAGEFIX_TOOLS:-/opt/imagefix-tools}"
OUT="${TMPDIR:-/tmp}/imagefix-jvm-test"
rm -rf "$OUT"; mkdir -p "$OUT"
javac -Xlint:-options -encoding UTF-8 -cp "$TOOLS/android.jar" -d "$OUT" \
  "$ROOT/app/src/main/java/app/imagefix/editor/AiClient.java" \
  "$ROOT/app/src/main/java/app/imagefix/editor/KeyVault.java" \
  "$ROOT/tests/jvm/app/imagefix/editor/AiClientTest.java" \
  "$ROOT/tests/jvm/app/imagefix/editor/KeyVaultTest.java" 2>&1 | grep -v 'Picked up' || true
rc=0
java -cp "$OUT:$TOOLS/android.jar" app.imagefix.editor.AiClientTest 2>&1 | grep -v 'Picked up'
[ "${PIPESTATUS[0]}" = 0 ] || rc=1
java -cp "$OUT:$TOOLS/android.jar" app.imagefix.editor.KeyVaultTest 2>&1 | grep -v 'Picked up'
[ "${PIPESTATUS[0]}" = 0 ] || rc=1
exit $rc
