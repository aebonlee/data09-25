#!/usr/bin/env bash
# ============================================================================
# supabase/schema.sql 을 임시 로컬 PostgreSQL 에 실제로 적용해 검증한다.
#
#   ./scripts/sqltest/run.sh
#
# 운영에서 처음 돌리지 않기 위한 장치다. 브라우저도 빌드도 SQL 은 잡아 주지 않는다.
# 임시 클러스터를 만들어 쓰고 끝나면 지우므로 기존 PostgreSQL 설치에 영향이 없다.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-}"
if [ -z "$PGBIN" ]; then
  for c in /usr/local/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@17/bin \
           /usr/local/opt/postgresql@16/bin /opt/homebrew/opt/postgresql@16/bin; do
    [ -x "$c/initdb" ] && PGBIN="$c" && break
  done
fi
# 데비안·우분투(그리고 GitHub Actions 러너) — 여기서는 initdb 가 PATH 에 없다
if [ -z "$PGBIN" ]; then
  for c in $(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V -r); do
    [ -x "$c/initdb" ] && PGBIN="$c" && break
  done
fi
if [ -z "$PGBIN" ] && command -v initdb >/dev/null 2>&1; then
  PGBIN="$(dirname "$(command -v initdb)")"
fi
if [ -z "$PGBIN" ]; then
  echo "PostgreSQL 을 찾지 못했습니다." >&2
  echo "  macOS  : brew install postgresql@17" >&2
  echo "  우분투 : sudo apt-get install -y postgresql" >&2
  exit 1
fi

TMP="$(mktemp -d)"; PGDATA="$TMP/data"; PGSOCK="$TMP/sock"; mkdir -p "$PGSOCK"
cleanup() { "$PGBIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "임시 PostgreSQL 준비 중…"
"$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$PGDATA" -o "-k $PGSOCK -h '' -c listen_addresses=''" -w start >/dev/null
"$PGBIN/createdb" -h "$PGSOCK" -U postgres sqltest

PSQL=("$PGBIN/psql" -h "$PGSOCK" -U postgres -d sqltest -v ON_ERROR_STOP=1 -q)

echo "① Supabase 환경 스텁"
"${PSQL[@]}" -f "$ROOT/scripts/sqltest/00_supabase_stub.local.sql"

echo "② schema.sql 적용"
PGOPTIONS='-c client_min_messages=warning' "${PSQL[@]}" -f "$ROOT/supabase/schema.sql"

echo "③ 재적용 (재실행 안전한가)"
PGOPTIONS='-c client_min_messages=warning' "${PSQL[@]}" -f "$ROOT/supabase/schema.sql"

echo "④ 공통 불변식 검증"
"${PSQL[@]}" -f "$ROOT/scripts/sqltest/10_common.local.sql" 2>&1 | sed 's/^psql:.*NOTICE:  //'

if [ -f "$ROOT/scripts/sqltest/20_project.local.sql" ]; then
  echo "⑤ 프로젝트별 검증"
  "${PSQL[@]}" -f "$ROOT/scripts/sqltest/20_project.local.sql" 2>&1 | sed 's/^psql:.*NOTICE:  //'
fi

echo "⑥ 운영 가드 자가검사 (운영 흔적이 보이면 검증 파일이 스스로 멈추는가)"
guard_check() {
  local label="$1" setup="$2" teardown="$3" f
  "${PSQL[@]}" -c "$setup"
  for f in 00_supabase_stub 10_common 20_project; do
    [ -f "$ROOT/scripts/sqltest/$f.local.sql" ] || continue
    # 다른 이유로 실패한 것을 가드로 오인하지 않도록 가드 문구까지 확인한다
    local out
    out="$("${PSQL[@]}" -f "$ROOT/scripts/sqltest/$f.local.sql" 2>&1 || true)"
    if [[ "$out" == *"로컬 검증 전용"* ]]; then :; else
      echo "  FAIL  $label 가 있는데 $f.local.sql 의 가드가 멈추지 않았습니다" >&2
      "${PSQL[@]}" -c "$teardown"; exit 1
    fi
    echo "  OK   $label → $f.local.sql 실행 거부"
  done
  "${PSQL[@]}" -c "$teardown"
}
guard_check "authenticator 역할"  "create role authenticator nologin"  "drop role authenticator"
guard_check "supabase_admin 역할" "create role supabase_admin nologin" "drop role supabase_admin"
guard_check "graphql 스키마"      "create schema graphql"              "drop schema graphql"

echo ""
echo "SQL 검증 통과."
