-- ============================================================================
-- data09-25 — 주조 생산실적 분석
-- Supabase(PostgreSQL) DB 스키마 + RLS
--
--  실행 위치 : 수강생 본인 Supabase 프로젝트의 SQL Editor 에서 실행
--              (Dashboard → SQL Editor → 이 파일 전체를 붙여넣고 Run)
--  재실행    : 안전합니다 (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS 선행)
--
--  지금 도구는 브라우저 localStorage 의 `data09-25.db` 한 칸에 모든 것을 둡니다.
--    records[] → production_record (행 하나 = 주간표 한 줄) + downtime (행마다 코드별 비가동 분)
--    legend    → downtime_code (A~K 코드 이름·정의·계획정지)
--    aiNotes·보고서 → weekly_report (주마다 보고서 글·AI 의견)
--  주간 결산·이상 탐지 결과는 행에서 다시 계산되는 파생 데이터라 저장하지 않습니다.
--
--  같은 행 = 일자 + 호기 + 품번 + 주조일자 (도구의 recKey). 그래서 rec_key 에 UNIQUE 를 겁니다.
--  작업자 이름은 분석에 쓰지 않으므로 DB 로 옮기지 않습니다(개인정보를 서버에 두지 않기 위해).
--
--  권한 원칙 : 모든 행은 만든 사람(owner_id = auth.uid())만 보고 고칩니다.
--              downtime 은 (owner_id, rec_key) 복합 외래키로 생산 행을 가리켜
--              남의 생산 행에 비가동을 끼워 넣을 수 없게 하고, 생산 행을 지우면 함께 지웁니다.
--  이 스키마는 수강생 본인 프로젝트 전제라 테이블 이름에 접두사를 붙이지 않았습니다.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. 테이블
-- ----------------------------------------------------------------------------

create table if not exists public.production_record (
  id           bigint generated always as identity primary key,
  owner_id     uuid not null default auth.uid(),
  rec_key      text not null,                                     -- 일자|호기|품번|주조일자
  plan_date    date not null,                                     -- 일자(계획일)
  line         text not null default '',                          -- 호기(계획)
  part_no      text not null check (length(trim(part_no)) > 0),   -- 품번
  part_name    text not null default '',                          -- 품명
  plan_qty     numeric check (plan_qty is null or plan_qty >= 0),
  plan_hr      numeric check (plan_hr is null or plan_hr between 0 and 24),     -- 근무(HR) = 계획시간
  work_hr      numeric check (work_hr is null or work_hr between 0 and 24),     -- 작업(HR) = 실투입시간
  cast_date    date,                                              -- 주조일자(실적일). 비면 계획만 있는 행
  cast_line    text not null default '',                          -- 주조호기
  run_min      numeric check (run_min is null or run_min between 0 and 1440),  -- 가동시간(분)
  total_qty    numeric check (total_qty is null or total_qty >= 0),
  good_qty     numeric check (good_qty is null or good_qty >= 0),
  scrap_qty    numeric check (scrap_qty is null or scrap_qty >= 0),
  down_note    text not null default '',                          -- 비가동내용
  erp_kg       numeric check (erp_kg is null or erp_kg >= 0),
  prod_kg      numeric check (prod_kg is null or prod_kg >= 0),
  produced     boolean not null default false,                    -- 실적이 있는 행인가
  source_file  text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- upsert onConflict = 'owner_id,rec_key'
  constraint production_record_uniq unique (owner_id, rec_key),
  -- 총 수량이 있으면 양품 + 폐기와 같아야 한다 (실제 주간표 25행 모두 그랬음)
  constraint production_record_total check (total_qty is null or total_qty = coalesce(good_qty, 0) + coalesce(scrap_qty, 0)),
  -- 실적 행은 주조일자가 있다 (계획만 있는 행은 주조일자가 없다)
  constraint production_record_produced check (not produced or cast_date is not null or good_qty is not null)
);
create index if not exists production_record_part_idx on public.production_record (owner_id, part_no, cast_date);
create index if not exists production_record_date_idx on public.production_record (owner_id, (coalesce(cast_date, plan_date)));

create table if not exists public.downtime (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null default auth.uid(),
  rec_key     text not null,
  code        text not null check (code ~ '^[A-Z]$'),            -- 비가동 코드 A~J (범례에는 K 도 있음)
  minutes     numeric not null check (minutes > 0 and minutes <= 1440),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint downtime_uniq unique (owner_id, rec_key, code),
  constraint downtime_record_fk foreign key (owner_id, rec_key)
    references public.production_record (owner_id, rec_key) on delete cascade on update cascade
);

create table if not exists public.downtime_code (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null default auth.uid(),
  code        text not null check (code ~ '^[A-Z]$'),
  name        text not null default '',
  definition  text not null default '',
  planned     boolean not null default false,                    -- 계획정지(회의·교육 등) — 이상 탐지 비교에서 뺌
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint downtime_code_uniq unique (owner_id, code)
);

create table if not exists public.weekly_report (
  id           bigint generated always as identity primary key,
  owner_id     uuid not null default auth.uid(),
  week_start   date not null check (extract(isodow from week_start) = 1),   -- 그 주 월요일
  report_text  text not null default '',
  ai_note      text not null default '',                        -- AI 답(검토 후 사용)
  rules        jsonb not null default '{}'::jsonb,              -- 그때 쓴 탐지 기준
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint weekly_report_uniq unique (owner_id, week_start)
);

-- ----------------------------------------------------------------------------
-- 2. 함수 · 트리거 (search_path 고정)
-- ----------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

do $trg$
declare t text;
begin
  foreach t in array array['production_record', 'downtime', 'downtime_code', 'weekly_report']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
                   t || '_updated_at', t);
  end loop;
end;
$trg$;

-- ----------------------------------------------------------------------------
-- 3. RLS — 본인 행만
-- ----------------------------------------------------------------------------

alter table public.production_record enable row level security;
alter table public.downtime          enable row level security;
alter table public.downtime_code     enable row level security;
alter table public.weekly_report     enable row level security;

do $rls$
declare t text;
begin
  foreach t in array array['production_record', 'downtime', 'downtime_code', 'weekly_report']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for select to authenticated using (owner_id = auth.uid())',
                   t || '_select', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (owner_id = auth.uid())',
                   t || '_insert', t);
    execute format('create policy %I on public.%I for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
                   t || '_update', t);
    execute format('create policy %I on public.%I for delete to authenticated using (owner_id = auth.uid())',
                   t || '_delete', t);
  end loop;
end;
$rls$;

-- ----------------------------------------------------------------------------
-- 4. 표 권한 — Supabase 는 새 표마다 anon 에도 전 권한을 붙인다. 정책 + 권한 회수 두 겹.
-- ----------------------------------------------------------------------------

revoke all on public.production_record, public.downtime, public.downtime_code, public.weekly_report from anon;
grant select, insert, update, delete on public.production_record, public.downtime, public.downtime_code, public.weekly_report to authenticated;

-- ----------------------------------------------------------------------------
-- 5. 함수 실행 권한 — PUBLIC 과 anon 을 둘 다 끊는다(Supabase 가 anon 에 자동 부여하므로).
--    트리거 전용 함수는 authenticated 를 남긴다.
-- ----------------------------------------------------------------------------

revoke all on function public.set_updated_at() from public, anon;
grant execute on function public.set_updated_at() to authenticated;

-- ============================================================================
-- 끝.
-- ============================================================================
