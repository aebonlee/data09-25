-- ============================================================================
-- 로컬 검증 전용 — data09-25 프로젝트별 검증 (운영 실행 금지, 가드 내장)
--
--  사용자 A·B 두 명과 비로그인(anon)을 번갈아 흉내 내어
--  ① 본인 행만 보이는가 ② 남의 생산 행에 비가동을 끼워 넣을 수 없는가
--  ③ anon 은 아무것도 못 하는가 ④ CHECK·UNIQUE·외래키·연쇄 삭제가 걸리는가
--  ⑤ 함수 권한에 PUBLIC·anon 이 남지 않았는가 를 잰다. 값은 전부 가상(SMP- 품번).
-- ============================================================================

do $guard$
begin
  if exists (select 1 from pg_roles where rolname in ('supabase_admin', 'authenticator'))
     or exists (select 1 from pg_namespace where nspname = 'graphql') then
    raise exception '이 파일은 로컬 검증 전용입니다. 운영 데이터베이스에서 실행할 수 없습니다.';
  end if;
end;
$guard$;

create or replace function public._assert_raises(p_sql text, p_state text, p_label text)
returns void language plpgsql set search_path = public as $fn$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_state then raise notice '  OK   %', p_label; return; end if;
    raise exception 'FAIL  %  (기대 SQLSTATE %, 실제 % — %)', p_label, p_state, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL  %  (기대 SQLSTATE % 인데 성공했다)', p_label, p_state;
end;
$fn$;

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.com')
on conflict (id) do nothing;

do $t$ begin raise notice '[프로젝트] data09-25 — 소유자 격리 · 생산 행 소속 · anon 차단 · 제약 · 함수 권한'; end $t$;

-- ----------------------------------------------------------------------------
-- 1. 사용자 A 가 가상 주간표 두 줄(실적 1 + 다음 주 계획 1)과 비가동·코드·보고서를 저장한다
-- ----------------------------------------------------------------------------
begin;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
do $t$
begin
  insert into public.production_record (rec_key, plan_date, line, part_no, part_name, plan_qty, plan_hr, work_hr, cast_date, cast_line, total_qty, good_qty, scrap_qty, down_note, produced)
  values ('2026-09-21|4|SMP-B401|2026-09-21', '2026-09-21', '4', 'SMP-B401', '브래킷', 150, 10, 9.6, '2026-09-21', '4', 90, 89, 1, 'C:유압 누유 점검(120)', true);
  insert into public.production_record (rec_key, plan_date, line, part_no, part_name, plan_qty, plan_hr)
  values ('2026-09-28|4|SMP-B401|', '2026-09-28', '4', 'SMP-B401', '브래킷', 150, 10);
  insert into public.downtime (rec_key, code, minutes) values ('2026-09-21|4|SMP-B401|2026-09-21', 'A', 40), ('2026-09-21|4|SMP-B401|2026-09-21', 'C', 120);
  insert into public.downtime_code (code, name, planned) values ('C', '설비 이상', false), ('G', '회의', true);
  insert into public.weekly_report (week_start, report_text, ai_note) values ('2026-09-21', '주조 주간 생산현황 보고', '');

  perform public._assert_eq((select owner_id from public.downtime where code = 'C'),
    '11111111-1111-1111-1111-111111111111'::uuid, 'owner_id 기본값이 auth.uid() 로 채워진다');
  perform public._assert_eq((select sum(minutes) from public.downtime), 160::numeric, 'A 는 자기 비가동(40 + 120분)을 본다');
  perform public._assert_eq((select count(*) from public.production_record where not produced), 1::bigint, '계획만 있는 행은 produced = false 로 들어간다');
end $t$;
commit;

begin;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
do $t$
begin
  update public.weekly_report set ai_note = '4호기 유압 확인' where week_start = '2026-09-21';
  perform public._assert((select updated_at > created_at from public.weekly_report where week_start = '2026-09-21'),
    'updated_at 트리거가 수정 시각을 갱신한다');
  -- 같은 행을 다시 가져오면 upsert 로 바뀐다(onConflict = owner_id,rec_key)
  insert into public.production_record (rec_key, plan_date, line, part_no, part_name, plan_qty, good_qty, scrap_qty, total_qty, cast_date, produced)
  values ('2026-09-21|4|SMP-B401|2026-09-21', '2026-09-21', '4', 'SMP-B401', '브래킷', 150, 88, 2, 90, '2026-09-21', true)
  on conflict (owner_id, rec_key) do update set good_qty = excluded.good_qty, scrap_qty = excluded.scrap_qty;
  perform public._assert_eq((select good_qty from public.production_record where rec_key like '2026-09-21|%'), 88::numeric,
    '같은 행(일자+호기+품번+주조일자)은 두 번 들어가지 않고 바뀐다');
end $t$;
commit;

-- ----------------------------------------------------------------------------
-- 2. 사용자 B — A 의 행을 보지도, 고치지도, 지우지도, 대신 쓰지도 못한다
-- ----------------------------------------------------------------------------
begin;
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
set local role authenticated;
do $t$
declare n bigint;
begin
  perform public._assert_eq(
    (select count(*) from public.production_record) + (select count(*) from public.downtime)
    + (select count(*) from public.downtime_code) + (select count(*) from public.weekly_report),
    0::bigint, 'B 에게는 A 의 행이 4개 표 어디에서도 보이지 않는다');

  update public.production_record set good_qty = 0;
  get diagnostics n = row_count;
  perform public._assert_eq(n, 0::bigint, 'B 의 UPDATE 는 A 의 생산 행에 닿지 않는다');

  delete from public.downtime;
  get diagnostics n = row_count;
  perform public._assert_eq(n, 0::bigint, 'B 의 DELETE 는 A 의 비가동에 닿지 않는다');

  perform public._assert_raises(
    $s$insert into public.weekly_report (owner_id, week_start) values ('11111111-1111-1111-1111-111111111111', '2026-09-14')$s$,
    '42501', 'B 는 owner_id 를 A 로 적어 대신 쓸 수 없다');

  -- B 가 A 의 rec_key 를 알아냈다고 가정한다
  perform public._assert_raises(
    $s$insert into public.downtime (rec_key, code, minutes) values ('2026-09-21|4|SMP-B401|2026-09-21', 'B', 30)$s$,
    '23503', 'B 는 자기 owner_id 로라도 A 의 생산 행에 비가동을 붙일 수 없다 (복합 외래키)');

  insert into public.production_record (rec_key, plan_date, part_no) values ('2026-09-21|4|SMP-B401|2026-09-21', '2026-09-21', 'SMP-B401');
  perform public._assert_eq((select count(*) from public.production_record), 1::bigint, '같은 rec_key 라도 사용자가 다르면 따로 저장된다');

  perform public._assert_raises(
    $s$update public.production_record set owner_id = '11111111-1111-1111-1111-111111111111'$s$,
    '42501', 'B 는 자기 행의 owner_id 를 A 로 넘길 수 없다 (with check)');
end $t$;
commit;

do $t$
begin
  perform public._assert_eq((select good_qty from public.production_record
      where owner_id = '11111111-1111-1111-1111-111111111111' and produced), 88::numeric, 'B 의 시도 뒤에도 A 의 양품은 88 그대로다');
  perform public._assert_eq((select count(*) from public.downtime
      where owner_id = '11111111-1111-1111-1111-111111111111'), 2::bigint, 'B 의 시도 뒤에도 A 의 비가동 2건은 그대로다');
end $t$;

-- ----------------------------------------------------------------------------
-- 3. 비로그인(anon) — 읽기도 쓰기도 막힌다
-- ----------------------------------------------------------------------------
begin;
set local request.jwt.claim.sub = '';
set local role anon;
do $t$
declare t text;
begin
  foreach t in array array['production_record','downtime','downtime_code','weekly_report']
  loop
    perform public._assert_raises(format('select * from public.%I', t), '42501', 'anon 은 ' || t || ' 를 읽을 수 없다');
  end loop;
  perform public._assert_raises(
    $s$insert into public.production_record (rec_key, plan_date, part_no) values ('x', '2026-09-21', 'X')$s$, '42501', 'anon 은 생산 행을 만들 수 없다');
end $t$;
commit;

-- ----------------------------------------------------------------------------
-- 4. 정책 구조
-- ----------------------------------------------------------------------------
do $t$
declare v_bad text;
begin
  select string_agg(p.polname, ', ') into v_bad
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')
         not like '%owner_id = auth.uid()%';
  perform public._assert(v_bad is null,
    '모든 정책이 owner_id = auth.uid() 로 묶여 있다' || coalesce(' (발견: ' || v_bad || ')', ''));
  perform public._assert_eq((select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'),
    16::bigint, '정책 수가 16개다 (4개 표 × 4, 재실행해도 늘지 않는다)');
end $t$;

-- ----------------------------------------------------------------------------
-- 5. CHECK · UNIQUE · 외래키 · 연쇄 삭제
-- ----------------------------------------------------------------------------
begin;
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
do $t$
begin
  perform public._assert_raises($s$insert into public.production_record (rec_key, plan_date, part_no, total_qty, good_qty, scrap_qty) values ('k1', '2026-09-22', 'SMP-1', 12, 9, 1)$s$,
    '23514', '총 수량 ≠ 양품 + 폐기 는 막는다');
  perform public._assert_raises($s$insert into public.production_record (rec_key, plan_date, part_no, good_qty) values ('k2', '2026-09-22', 'SMP-1', -1)$s$,
    '23514', '양품은 음수가 될 수 없다');
  perform public._assert_raises($s$insert into public.production_record (rec_key, plan_date, part_no, work_hr) values ('k3', '2026-09-22', 'SMP-1', 25)$s$,
    '23514', '작업(HR)은 하루 24시간을 넘을 수 없다');
  perform public._assert_raises($s$insert into public.production_record (rec_key, plan_date, part_no) values ('k4', '2026-09-22', '  ')$s$,
    '23514', '품번은 비워 둘 수 없다');
  perform public._assert_raises($s$insert into public.production_record (rec_key, plan_date, part_no, produced) values ('k5', '2026-09-22', 'SMP-1', true)$s$,
    '23514', '실적 행이라면서 주조일자·양품이 모두 없으면 막는다');
  perform public._assert_raises($s$insert into public.downtime (rec_key, code, minutes) values ('2026-09-21|4|SMP-B401|2026-09-21', 'AB', 10)$s$,
    '23514', '비가동 코드는 영문 대문자 한 글자다');
  perform public._assert_raises($s$insert into public.downtime (rec_key, code, minutes) values ('2026-09-21|4|SMP-B401|2026-09-21', 'D', 0)$s$,
    '23514', '비가동 분은 0보다 커야 한다(0분은 행을 만들지 않음)');
  perform public._assert_raises($s$insert into public.downtime (rec_key, code, minutes) values ('2026-09-21|4|SMP-B401|2026-09-21', 'A', 10)$s$,
    '23505', '한 행의 같은 코드는 하나뿐이다');
  perform public._assert_raises($s$insert into public.downtime (rec_key, code, minutes) values ('없는 행', 'A', 10)$s$,
    '23503', '없는 생산 행에는 비가동을 붙일 수 없다');
  perform public._assert_raises($s$insert into public.downtime_code (code, name) values ('C', '중복')$s$,
    '23505', '같은 코드는 하나만 둔다');
  perform public._assert_raises($s$insert into public.weekly_report (week_start) values ('2026-09-22')$s$,
    '23514', '보고서 주는 월요일이어야 한다');

  delete from public.production_record where produced;
  perform public._assert_eq((select count(*) from public.downtime), 0::bigint, '생산 행을 지우면 그 비가동도 함께 지워진다');
end $t$;
commit;

-- ----------------------------------------------------------------------------
-- 6. 함수 권한 · search_path · 표 권한
-- ----------------------------------------------------------------------------
do $t$
declare v_bad text;
begin
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname not like '\_assert%'
     and (p.proacl is null
          or exists (select 1 from aclexplode(p.proacl) a
                      where a.privilege_type = 'EXECUTE'
                        and (a.grantee = 0 or a.grantee = 'anon'::regrole::oid)));
  perform public._assert(v_bad is null,
    'proacl 에 PUBLIC·anon EXECUTE 가 없다' || coalesce(' (발견: ' || v_bad || ')', ''));

  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname not like '\_assert%'
     and not coalesce('search_path=public' = any(p.proconfig), false);
  perform public._assert(v_bad is null,
    '모든 함수에 search_path = public 이 고정돼 있다' || coalesce(' (발견: ' || v_bad || ')', ''));

  select string_agg(c.relname, ', ') into v_bad
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
     and has_table_privilege('anon', c.oid, 'SELECT');
  perform public._assert(v_bad is null,
    'anon 에게 표 SELECT 권한이 없다' || coalesce(' (발견: ' || v_bad || ')', ''));
end $t$;
