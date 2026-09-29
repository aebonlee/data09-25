# Supabase DB 스크립트

이 폴더에는 이 도구의 저장 데이터를 PostgreSQL(Supabase)로 옮길 때 쓰는 스키마가 들어 있습니다.
지금 도구는 **계정 없이 브라우저 저장소(localStorage)** 만 씁니다. DB 에 연결하는 코드는 2단계에서 붙입니다.

## 왜 DB 가 필요한가

- **몇 달 치가 쌓이면 브라우저 한 칸으로는 부족합니다.** 주간표 한 주가 60~80행이라 1년이면 4,000행 가까이 됩니다. 브라우저 저장소는 PC·브라우저마다 따로이고, 정리하면 사라집니다.
- **팀이 같은 실적을 봐야 합니다.** 생산관리·현장·품질이 같은 결산과 이상 목록을 보려면 한곳에 모아야 합니다(기획서 8장 2단계).
- **같은 행을 두 번 넣지 않게** — 일자 + 호기 + 품번 + 주조일자(`rec_key`)가 같은 행은 DB 에서도 한 번만 들어갑니다. 총 수량 = 양품 + 폐기, 비가동 코드 한 글자 같은 규칙도 DB 가 한 번 더 지켜 줍니다.

작업자 이름은 분석에 쓰지 않으므로 DB 로 옮기지 않습니다.

## 테이블

| 테이블 | 용도 | localStorage 대응 |
|---|---|---|
| `production_record` | 주간표 한 줄(계획·실적) — 일자·호기·품번·품명·계획수량·근무(HR)·작업(HR)·주조일자·주조호기·가동시간·총 수량·양품·폐기·비가동내용·중량 | `records[]` |
| `downtime` | 한 줄의 코드별 비가동(분) — A~J | `records[].down` |
| `downtime_code` | 비가동 코드 이름·정의·계획정지 여부 | `legend` |
| `weekly_report` | 주마다 보고서 글·AI 의견·그때 쓴 탐지 기준 | `aiNotes` |

주간 결산·품목 추이·이상 탐지 결과는 행에서 다시 계산되므로 저장하지 않습니다.

### 권한

- 모든 표에 RLS(행 수준 보안)를 켰고, 모든 행은 만든 사람만 보고 고칠 수 있습니다(`owner_id = auth.uid()`, 자동으로 채워짐).
- `downtime` 은 `(owner_id, rec_key)` 로 생산 행을 가리킵니다. 남의 `rec_key` 를 알아내도 거기에 비가동을 붙일 수 없고, 생산 행을 지우면 비가동도 함께 지워집니다.
- 로그인하지 않은 사용자(anon)는 어떤 표도 읽거나 쓸 수 없습니다(정책 + 표 권한 회수, 두 겹).
- 앱에서 upsert 할 때 `onConflict` 는 `owner_id,rec_key` · `owner_id,rec_key,code` · `owner_id,code` · `owner_id,week_start` 입니다.

## 적용 방법

1. <https://supabase.com> 에 가입하고 이 도구 전용으로 새 프로젝트를 만듭니다(그래서 표 이름에 접두사가 없습니다).
2. 왼쪽 메뉴 **SQL Editor** 에 `supabase/schema.sql` 내용을 전부 붙여넣고 **Run** 을 누릅니다.

여러 번 실행해도 안전합니다. 이미 있는 표는 건너뛰고 정책·트리거는 지우고 다시 만듭니다.

## 확인 방법

1. **Table Editor** 에 위 4개 표가 있고, 표마다 RLS 가 켜져 있는지 봅니다.
2. **Authentication → Policies** 에서 표마다 SELECT·INSERT·UPDATE·DELETE 정책 4개(모두 16개)가 있는지 봅니다.
3. SQL Editor 에서 함수 권한에 `anon` 이 없는지 봅니다.

```sql
select proname, proacl from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public';
```

## 로컬 검증 방법

운영에서 처음 실행하지 않도록, 임시 로컬 PostgreSQL 에 실제로 적용해 검사하는 도구를 함께 두었습니다.

```sh
./scripts/sqltest/run.sh
```

PostgreSQL 16 이상이 필요합니다(macOS: `brew install postgresql@17`). 임시 DB 를 만들어 쓰고 끝나면 지웁니다.

- 스키마를 두 번 적용해도 오류가 없는가
- 사용자 A 의 행이 사용자 B 에게 보이지 않고, 고치거나 지울 수도 없는가 · 남의 생산 행에 비가동을 붙일 수 없는가
- 로그인하지 않은 사용자는 아무것도 못 하는가
- 총 수량 ≠ 양품 + 폐기, 음수 수량, 24시간 넘는 작업, 빈 품번, 코드 형식, 같은 코드 중복, 월요일이 아닌 보고서 주를 막는가
- 생산 행을 지우면 비가동이 함께 지워지는가 · 함수 실행 권한에 PUBLIC·anon 이 남지 않았는가

검사용 SQL(`scripts/sqltest/*.local.sql`)은 로컬 전용이며, Supabase 운영 DB 에서 실행하면 스스로 멈춥니다.
