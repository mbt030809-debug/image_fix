#!/usr/bin/env bash
# 전체 검증: 엔진 단위 테스트 → 웹 번들 → E2E(스모크/도구/브리지/드래프트/콜라주/레이아웃) → 무작위 조작
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
fail=0
run() { echo "== $*"; "$@" || { echo "!! 실패: $*"; fail=1; }; }
run node web/tests/unit.mjs
(cd web && node build.mjs)
cd tests/e2e
run node smoke.cjs
run node tools.cjs
run node bridge.cjs
run node draft.cjs
run node collage.cjs
run node layouts.cjs
run node monkey.cjs 1 100
run node monkey.cjs 2 100 portrait.jpg
echo
if [ "$fail" = 0 ]; then echo "모든 검증 통과"; else echo "실패 항목 있음"; exit 1; fi
