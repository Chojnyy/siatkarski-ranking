-- =====================================================================
-- Migracja 002 (2026-11-12)
-- 1. Sesja mieszana: MVP i wygrany pojedynek to osobne punkty (max 2).
--    Premia za powrót / nieparzystość liczą się tylko, gdy nie ma żadnego z nich.
--    Sesja ekipowa i randomy: bez zmian (max 1 punkt na sesję).
-- 2. Limit: jedno aktywne (oczekujące lub zaakceptowane) wysłane wyzwanie na osobę na sesję.
-- 3. Własny awatar: kolumna custom_avatar_url + bucket "avatars" w Storage.
-- Uruchom w Supabase: SQL Editor → New query → Run. Można uruchomić ponownie.
-- =====================================================================

-- ---------- 1. Punkty ----------
create or replace view public.v_session_points with (security_invoker = on) as
with
part as (
  select p.session_id, p.user_id, p.team_won, p.no_challenge,
         s.type, s.start_at, s.end_at, s.mvp_enabled, s.duels_enabled
  from participants p join sessions s on s.id = p.session_id
),
team_pts as (
  select session_id, user_id, 'Wygrana drużyny'::text as reason, 'team'::text as kind
  from part where type = 'ekipowa' and team_won
),
mvp_counts as (
  select v.session_id, v.candidate_id, count(*) as c
  from mvp_votes v
  join part pv on pv.session_id = v.session_id and pv.user_id = v.voter_id
  join part pc on pc.session_id = v.session_id and pc.user_id = v.candidate_id
  where pc.mvp_enabled
  group by v.session_id, v.candidate_id
),
mvp_ranked as (
  select session_id, candidate_id,
         rank()   over (partition by session_id order by c desc) as r,
         count(*) over (partition by session_id, c)             as n_same
  from mvp_counts
),
mvp_pts as (
  select session_id, candidate_id as user_id, 'MVP sesji'::text as reason, 'mvp'::text as kind
  from mvp_ranked where r = 1 and n_same = 1
),
duel_counts as (
  select d.id, d.session_id, d.challenger_id, d.challenged_id,
    (select count(*) from duel_votes v
       join participants pv on pv.session_id = d.session_id and pv.user_id = v.voter_id
      where v.duel_id = d.id and v.winner_id = d.challenger_id
        and v.voter_id not in (d.challenger_id, d.challenged_id)) as va,
    (select count(*) from duel_votes v
       join participants pv on pv.session_id = d.session_id and pv.user_id = v.voter_id
      where v.duel_id = d.id and v.winner_id = d.challenged_id
        and v.voter_id not in (d.challenger_id, d.challenged_id)) as vb
  from duels d join sessions s on s.id = d.session_id
  where d.status = 'accepted' and s.duels_enabled
),
duel_pts as (
  select session_id,
         case when va > vb then challenger_id else challenged_id end as user_id,
         'Wygrany pojedynek'::text as reason, 'duel'::text as kind
  from duel_counts where va <> vb
),
started as (
  select id, row_number() over (order by start_at, id) as n
  from sessions where start_at <= now()
),
att as (
  select p.user_id, p.session_id, st.n,
         lag(st.n) over (partition by p.user_id order by st.n) as prev_n
  from participants p join started st on st.id = p.session_id
),
comeback_pts as (
  select session_id, user_id, 'Premia za powrót'::text as reason, 'comeback'::text as kind
  from att where prev_n is not null and n - prev_n - 1 >= 4
),
odd_pts as (
  select o.session_id, o.user_id, ('Nieparzystość: ' || o.reason)::text as reason, 'odd'::text as kind
  from odd_awards o
  join part p on p.session_id = o.session_id and p.user_id = o.user_id
  where p.duels_enabled and p.type <> 'ekipowa' and not p.no_challenge
    and not exists (select 1 from duels d where d.session_id = o.session_id and d.status = 'accepted'
                    and o.user_id in (d.challenger_id, d.challenged_id))
),
allp as (
  select * from team_pts union all select * from mvp_pts union all select * from duel_pts
  union all select * from comeback_pts union all select * from odd_pts
)
select a.session_id, a.user_id,
       case when p.type = 'mieszana' then
         -- MVP i pojedynek osobno; premia/nieparzystość tylko gdy nie ma żadnego z nich
         greatest(bool_or(a.kind = 'mvp')::int + bool_or(a.kind = 'duel')::int,
                  bool_or(a.kind in ('comeback', 'odd'))::int)
       else 1 end as points,
       array_agg(a.reason order by a.reason) as reasons
from allp a
join part p on p.session_id = a.session_id and p.user_id = a.user_id
group by a.session_id, a.user_id, p.type;

grant select on public.v_session_points to authenticated;

-- ---------- 2. Limit wyzwań ----------
create or replace function public.challenge(p_session uuid, p_opponent uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := _require_member(); s sessions; v_id uuid;
begin
  select * into s from sessions where id = p_session;
  if not found then raise exception 'Nie ma takiej sesji'; end if;
  if not s.duels_enabled then raise exception 'W tej sesji pojedynki są wyłączone'; end if;
  if now() >= _mid(s) then
    raise exception 'Wyzwania są możliwe tylko do połowy sesji (do %)', _hhmm(_mid(s));
  end if;
  if p_opponent = me then raise exception 'Nie można wyzwać samego siebie'; end if;
  if not exists (select 1 from profiles where id = p_opponent and is_member) then
    raise exception 'Można wyzwać tylko osobę z ekipy';
  end if;
  if exists (select 1 from participants where session_id = p_session and user_id = me and no_challenge) then
    raise exception 'Masz zaznaczone „nie chcę wyzywać” w tej sesji';
  end if;
  if exists (select 1 from duels where session_id = p_session and challenger_id = me
             and status in ('pending', 'accepted')) then
    raise exception 'Limit: jedno wyzwanie na sesję. Masz już wysłane wyzwanie w tej sesji';
  end if;
  if _in_accepted_duel(p_session, me) then raise exception 'Masz już pojedynek w tej sesji'; end if;
  if _in_accepted_duel(p_session, p_opponent) then raise exception 'Ta osoba ma już pojedynek w tej sesji'; end if;
  if exists (select 1 from duels where session_id = p_session and status = 'pending'
             and least(challenger_id, challenged_id) = least(me, p_opponent)
             and greatest(challenger_id, challenged_id) = greatest(me, p_opponent)) then
    raise exception 'Wyzwanie między wami już czeka na odpowiedź';
  end if;
  insert into participants (session_id, user_id, updated_by) values (p_session, me, me) on conflict do nothing;
  insert into duels (session_id, challenger_id, challenged_id) values (p_session, me, p_opponent) returning id into v_id;
  perform _log('wyzwanie', p_session, p_opponent, jsonb_build_object('pojedynek', v_id), null);
  return v_id;
end $$;

-- ---------- 3. Własny awatar ----------
alter table public.profiles add column if not exists custom_avatar_url text;

create or replace function public.set_my_avatar(p_url text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require_member();
  if p_url is not null
     and p_url not like '%/storage/v1/object/public/avatars/' || auth.uid()::text || '/%' then
    raise exception 'Nieprawidłowy adres zdjęcia';
  end if;
  update profiles set custom_avatar_url = p_url where id = auth.uid();
  perform _log(case when p_url is null then 'awatar_usuniety' else 'awatar_zmieniony' end, null, auth.uid(), null, null);
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 1048576, array['image/webp', 'image/jpeg', 'image/png'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;

-- Każdy z ekipy zapisuje/usuwa tylko we własnym folderze avatars/<id>/
drop policy if exists avatars_select on storage.objects;
create policy avatars_select on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists avatars_insert on storage.objects;
create policy avatars_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text and public.am_member());
drop policy if exists avatars_update on storage.objects;
create policy avatars_update on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists avatars_delete on storage.objects;
create policy avatars_delete on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
