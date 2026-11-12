-- =====================================================================
-- Siatkarski ranking — schemat bazy (Supabase / Postgres)
-- Uruchom całość w Supabase: SQL Editor → New query → Run.
-- Wszystkie zapisy idą przez funkcje RPC (security definer), które
-- pilnują reguł ze specyfikacji. Tabele są tylko do odczytu dla ekipy.
-- Punkty NIE są przechowywane — liczy je widok v_session_points.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Konfiguracja ----------
create table if not exists public.app_config (
  id                     int primary key default 1 check (id = 1),
  entry_window_hours     int not null default 24 check (entry_window_hours in (24, 48)),
  vote_window_hours      int not null default 24,
  launch_date            date not null default '2027-01-01',
  randomy_mvp_default    boolean not null default false,
  randomy_duels_default  boolean not null default false
);
insert into public.app_config (id) values (1) on conflict do nothing;

-- ---------- Ekipa ----------
create table if not exists public.allowed_emails (
  email     text primary key,
  is_admin  boolean not null default false,
  added_by  uuid,
  added_at  timestamptz not null default now()
);

create table if not exists public.profiles (
  id            uuid primary key references auth.users on delete cascade,
  email         text not null,
  display_name  text not null,
  avatar_url    text,
  is_member     boolean not null default false,
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ---------- Sesje ----------
do $$ begin
  create type public.session_type as enum ('ekipowa', 'mieszana', 'randomy');
exception when duplicate_object then null; end $$;

create table if not exists public.sessions (
  id                   uuid primary key default gen_random_uuid(),
  start_at             timestamptz not null,
  end_at               timestamptz not null,
  type                 public.session_type not null,
  leader_id            uuid not null references public.profiles,
  mvp_enabled          boolean not null,
  duels_enabled        boolean not null,
  note                 text,
  leader_submitted_at  timestamptz,
  created_by           uuid references public.profiles,
  created_at           timestamptz not null default now(),
  check (end_at > start_at)
);
create index if not exists sessions_start_idx on public.sessions (start_at);

create table if not exists public.participants (
  session_id    uuid not null references public.sessions on delete cascade,
  user_id       uuid not null references public.profiles,
  team_won      boolean not null default false,
  no_challenge  boolean not null default false,
  updated_by    uuid,
  updated_at    timestamptz not null default now(),
  primary key (session_id, user_id)
);

-- ---------- Pojedynki ----------
do $$ begin
  create type public.duel_status as enum ('pending', 'accepted', 'declined', 'withdrawn', 'cancelled');
exception when duplicate_object then null; end $$;

create table if not exists public.duels (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references public.sessions on delete cascade,
  challenger_id  uuid not null references public.profiles,
  challenged_id  uuid not null references public.profiles,
  status         public.duel_status not null default 'pending',
  created_at     timestamptz not null default now(),
  responded_at   timestamptz,
  withdrawn_at   timestamptz,
  withdrawn_by   uuid,
  check (challenger_id <> challenged_id)
);
create index if not exists duels_session_idx on public.duels (session_id);

create table if not exists public.duel_votes (
  duel_id     uuid not null references public.duels on delete cascade,
  voter_id    uuid not null references public.profiles,
  winner_id   uuid not null references public.profiles,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (duel_id, voter_id)
);

-- ---------- MVP ----------
create table if not exists public.mvp_votes (
  session_id    uuid not null references public.sessions on delete cascade,
  voter_id      uuid not null references public.profiles,
  candidate_id  uuid not null references public.profiles,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (session_id, voter_id),
  check (voter_id <> candidate_id)
);

-- ---------- Punkt za nieparzystość ----------
create table if not exists public.odd_awards (
  session_id  uuid not null references public.sessions on delete cascade,
  user_id     uuid not null references public.profiles,
  reason      text not null,
  awarded_by  uuid references public.profiles,
  created_at  timestamptz not null default now(),
  primary key (session_id, user_id)
);

-- ---------- Historia (wszystko, co się wydarzyło) ----------
create table if not exists public.history (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  session_id  uuid,          -- celowo bez FK: wpis zostaje po usunięciu sesji
  kind        text not null,
  target_id   uuid,
  details     jsonb,
  reason      text
);
create index if not exists history_session_idx on public.history (session_id, at desc);

-- =====================================================================
-- Funkcje pomocnicze
-- =====================================================================
create or replace function public.am_member() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_member from profiles p where p.id = auth.uid()), false)
$$;

create or replace function public.am_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_member and p.is_admin from profiles p where p.id = auth.uid()), false)
$$;

create or replace function public._require_member() returns uuid
language plpgsql stable security definer set search_path = public as $$
begin
  if not am_member() then raise exception 'Brak dostępu – strona tylko dla ekipy'; end if;
  return auth.uid();
end $$;

create or replace function public._log(p_kind text, p_session uuid, p_target uuid, p_details jsonb, p_reason text)
returns void language sql security definer set search_path = public as $$
  insert into history (actor_id, session_id, kind, target_id, details, reason)
  values (auth.uid(), p_session, p_kind, p_target, p_details, nullif(trim(p_reason), ''));
$$;

create or replace function public._hhmm(t timestamptz) returns text
language sql stable as $$ select to_char(t at time zone 'Europe/Warsaw', 'HH24:MI') $$;

create or replace function public._mid(s public.sessions) returns timestamptz
language sql immutable as $$ select s.start_at + (s.end_at - s.start_at) / 2 $$;

create or replace function public._lead_deadline(s public.sessions) returns timestamptz
language sql stable security definer set search_path = public as $$
  select s.start_at + make_interval(hours => (select entry_window_hours from app_config where id = 1))
$$;

create or replace function public._vote_end(s public.sessions) returns timestamptz
language sql stable security definer set search_path = public as $$
  select s.end_at + make_interval(hours => (select vote_window_hours from app_config where id = 1))
$$;

create or replace function public._next_start(s public.sessions) returns timestamptz
language sql stable security definer set search_path = public as $$
  select min(x.start_at) from sessions x where x.start_at > s.start_at
$$;

-- Czy aktor może (bez korekty admina) zmienić wynik danej osoby w sesji?
create or replace function public._can_edit_results(s public.sessions, p_actor uuid, p_target uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_dl timestamptz := _lead_deadline(s); v_next timestamptz;
begin
  if p_actor = s.leader_id and now() <= v_dl then return true; end if;
  if p_actor = p_target then
    if now() <= v_dl then return true; end if;
    -- lider nie zatwierdził wyników w oknie → uczestnik może wpisać swoje do startu następnej sesji
    if s.leader_submitted_at is null then
      v_next := _next_start(s);
      if v_next is null or now() < v_next then return true; end if;
    end if;
  end if;
  return false;
end $$;

-- Zwraca true, jeśli to korekta admina (wymaga powodu); rzuca błąd, gdy brak uprawnień.
create or replace function public._authorize_results(s public.sessions, p_target uuid, p_reason text)
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  if _can_edit_results(s, auth.uid(), p_target) then return false; end if;
  if am_admin() then
    if coalesce(trim(p_reason), '') = '' then
      raise exception 'Korekta administratora wymaga podania powodu';
    end if;
    return true;
  end if;
  raise exception 'Wyniki tej sesji są już zablokowane';
end $$;

create or replace function public._in_accepted_duel(p_session uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from duels d where d.session_id = p_session and d.status = 'accepted'
                 and p_user in (d.challenger_id, d.challenged_id))
$$;

create or replace function public._is_participant(p_session uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from participants where session_id = p_session and user_id = p_user)
$$;

-- =====================================================================
-- Nowe konto: profil + dostęp, jeśli e-mail jest na liście ekipy
-- =====================================================================
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare a allowed_emails;
begin
  select * into a from allowed_emails where email = lower(new.email);
  insert into profiles (id, email, display_name, avatar_url, is_member, is_admin)
  values (
    new.id, lower(new.email),
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data->>'avatar_url',
    a.email is not null,
    coalesce(a.is_admin, false)
  ) on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Gdy e-mail trafi na listę po pierwszym logowaniu — zsynchronizuj profil.
create or replace function public.sync_allowed_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update profiles set is_member = true, is_admin = (is_admin or new.is_admin) where email = new.email;
  return new;
end $$;

drop trigger if exists on_allowed_email on public.allowed_emails;
create trigger on_allowed_email after insert or update on public.allowed_emails
  for each row execute function public.sync_allowed_email();

-- =====================================================================
-- RPC: sesje
-- =====================================================================
create or replace function public.create_session(
  p_start timestamptz, p_end timestamptz, p_type public.session_type,
  p_leader uuid default null, p_mvp boolean default null, p_duels boolean default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := _require_member(); v_id uuid; v_leader uuid := coalesce(p_leader, auth.uid()); c app_config;
begin
  if p_end <= p_start then raise exception 'Koniec sesji musi być po jej starcie'; end if;
  if not exists (select 1 from profiles where id = v_leader and is_member) then
    raise exception 'Lider musi być osobą z ekipy';
  end if;
  select * into c from app_config where id = 1;
  insert into sessions (start_at, end_at, type, leader_id, mvp_enabled, duels_enabled, note, created_by)
  values (p_start, p_end, p_type, v_leader,
          case when p_type = 'randomy' then coalesce(p_mvp, c.randomy_mvp_default) else true end,
          case when p_type = 'randomy' then coalesce(p_duels, c.randomy_duels_default) else true end,
          nullif(trim(p_note), ''), me)
  returning id into v_id;
  insert into participants (session_id, user_id, updated_by) values (v_id, v_leader, me);
  perform _log('sesja_utworzona', v_id, v_leader,
               jsonb_build_object('typ', p_type, 'start', p_start, 'koniec', p_end), null);
  return v_id;
end $$;

create or replace function public.update_session(
  p_session uuid, p_start timestamptz, p_end timestamptz, p_type public.session_type,
  p_leader uuid, p_mvp boolean default null, p_duels boolean default null, p_note text default null,
  p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := _require_member(); s sessions; corr boolean := false;
begin
  select * into s from sessions where id = p_session;
  if not found then raise exception 'Nie ma takiej sesji'; end if;
  if not (me = s.leader_id and now() <= _lead_deadline(s)) then
    if am_admin() then
      if coalesce(trim(p_reason), '') = '' then raise exception 'Korekta administratora wymaga podania powodu'; end if;
      corr := true;
    else
      raise exception 'Sesję może edytować lider (w oknie wpisu wyników) lub administrator';
    end if;
  end if;
  if p_end <= p_start then raise exception 'Koniec sesji musi być po jej starcie'; end if;
  if not exists (select 1 from profiles where id = p_leader and is_member) then
    raise exception 'Lider musi być osobą z ekipy';
  end if;
  update sessions set
    start_at = p_start, end_at = p_end, type = p_type, leader_id = p_leader,
    mvp_enabled   = case when p_type = 'randomy' then coalesce(p_mvp, mvp_enabled) else true end,
    duels_enabled = case when p_type = 'randomy' then coalesce(p_duels, duels_enabled) else true end,
    note = nullif(trim(p_note), '')
  where id = p_session;
  perform _log(case when corr then 'korekta_sesji' else 'sesja_zmieniona' end, p_session, null,
               jsonb_build_object('poprzednio', to_jsonb(s), 'typ', p_type, 'start', p_start, 'koniec', p_end, 'lider', p_leader),
               p_reason);
end $$;

create or replace function public.delete_session(p_session uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare s sessions;
begin
  perform _require_member();
  if not am_admin() then raise exception 'Sesję może usunąć tylko administrator'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Podaj powód usunięcia'; end if;
  select * into s from sessions where id = p_session;
  if not found then raise exception 'Nie ma takiej sesji'; end if;
  perform _log('sesja_usunieta', p_session, null, to_jsonb(s), p_reason);
  delete from sessions where id = p_session;
end $$;

create or replace function public.submit_results(p_session uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := _require_member(); s sessions;
begin
  select * into s from sessions where id = p_session;
  if not found then raise exception 'Nie ma takiej sesji'; end if;
  if me <> s.leader_id then raise exception 'Wyniki zatwierdza lider sesji'; end if;
  if now() > _lead_deadline(s) then raise exception 'Okno wpisu wyników lidera minęło'; end if;
  update sessions set leader_submitted_at = now() where id = p_session;
  perform _log('wyniki_zatwierdzone', p_session, null, null, null);
end $$;

-- Obecność / wygrana drużyny / „nie chcę wyzywać”
create or replace function public.set_participant(
  p_session uuid, p_user uuid, p_present boolean,
  p_team_won boolean default null, p_no_challenge boolean default null, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := _require_member(); s sessions; corr boolean; v_old participants;
begin
  select * into s from sessions where id = p_session;
  if not found then raise exception 'Nie ma takiej sesji'; end if;
  if not exists (select 1 from profiles where id = p_user and is_member) then
    raise exception 'Ta osoba nie jest w ekipie';
  end if;
  corr := _authorize_results(s, p_user, p_reason);
  select * into v_old from participants where session_id = p_session and user_id = p_user;

  if p_present then
    if coalesce(p_no_challenge, false) and _in_accepted_duel(p_session, p_user) then
      raise exception 'Jest zaakceptowany pojedynek – najpierw go wycofaj';
    end if;
    if coalesce(p_team_won, false) and s.type <> 'ekipowa' then
      raise exception 'Wygrana drużyny liczy się tylko w sesji ekipowej';
    end if;
    insert into participants (session_id, user_id, team_won, no_challenge, updated_by, updated_at)
    values (p_session, p_user, coalesce(p_team_won, false), coalesce(p_no_challenge, false), me, now())
    on conflict (session_id, user_id) do update set
      team_won     = coalesce(p_team_won, participants.team_won),
      no_challenge = coalesce(p_no_challenge, participants.no_challenge),
      updated_by   = me, updated_at = now();
  else
    delete from participants where session_id = p_session and user_id = p_user;
  end if;

  perform _log(case when corr then 'korekta' else 'wynik' end, p_session, p_user,
               jsonb_strip_nulls(jsonb_build_object('obecny', p_present, 'wygrana', p_team_won,
                                                    'nie_wyzywa', p_no_challenge, 'poprzednio', to_jsonb(v_old))),
               p_reason);
end $$;

-- =====================================================================
-- RPC: pojedynki
-- =====================================================================
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

create or replace function public.respond_duel(p_duel uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := _require_member(); d duels; s sessions;
begin
  select * into d from duels where id = p_duel for update;
  if not found then raise exception 'Nie ma takiego pojedynku'; end if;
  select * into s from sessions where id = d.session_id;
  if d.challenged_id <> me then raise exception 'Odpowiedzieć może tylko osoba wyzwana'; end if;
  if d.status <> 'pending' then raise exception 'To wyzwanie nie czeka już na odpowiedź'; end if;
  if now() >= _mid(s) then
    raise exception 'Wyzwanie wygasło – akceptacja była możliwa do %', _hhmm(_mid(s));
  end if;
  if p_accept then
    if _in_accepted_duel(d.session_id, me) then raise exception 'Masz już pojedynek w tej sesji'; end if;
    if _in_accepted_duel(d.session_id, d.challenger_id) then raise exception 'Wyzywający ma już inny pojedynek'; end if;
    update participants set no_challenge = false where session_id = d.session_id and user_id = me;
    insert into participants (session_id, user_id, updated_by) values (d.session_id, me, me) on conflict do nothing;
    update duels set status = 'accepted', responded_at = now() where id = p_duel;
    -- pozostałe oczekujące wyzwania tej dwójki w sesji tracą sens
    update duels set status = 'cancelled', responded_at = now()
      where session_id = d.session_id and status = 'pending' and id <> p_duel
        and (challenger_id in (me, d.challenger_id) or challenged_id in (me, d.challenger_id));
  else
    update duels set status = 'declined', responded_at = now() where id = p_duel;
  end if;
  perform _log(case when p_accept then 'pojedynek_przyjety' else 'pojedynek_odrzucony' end,
               d.session_id, d.challenger_id, jsonb_build_object('pojedynek', p_duel), null);
end $$;

create or replace function public.withdraw_duel(p_duel uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := _require_member(); d duels; s sessions;
begin
  select * into d from duels where id = p_duel for update;
  if not found then raise exception 'Nie ma takiego pojedynku'; end if;
  select * into s from sessions where id = d.session_id;
  if me not in (d.challenger_id, d.challenged_id) then raise exception 'To nie twój pojedynek'; end if;
  if d.status = 'pending' then
    if me <> d.challenger_id then raise exception 'Wyzwanie możesz przyjąć albo odrzucić'; end if;
    update duels set status = 'cancelled', withdrawn_at = now(), withdrawn_by = me where id = p_duel;
  elsif d.status = 'accepted' then
    if now() >= s.end_at then
      raise exception 'Po zakończeniu sesji (%) nie można wycofać pojedynku', _hhmm(s.end_at);
    end if;
    update duels set status = 'withdrawn', withdrawn_at = now(), withdrawn_by = me where id = p_duel;
  else
    raise exception 'Tego pojedynku nie da się już wycofać';
  end if;
  perform _log('pojedynek_wycofany', d.session_id, case when me = d.challenger_id then d.challenged_id else d.challenger_id end,
               jsonb_build_object('pojedynek', p_duel), null);
end $$;

-- p_winner = null → wycofanie głosu
create or replace function public.vote_duel(p_duel uuid, p_winner uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := _require_member(); d duels; s sessions;
begin
  select * into d from duels where id = p_duel;
  if not found then raise exception 'Nie ma takiego pojedynku'; end if;
  select * into s from sessions where id = d.session_id;
  if d.status <> 'accepted' or not s.duels_enabled then raise exception 'Ten pojedynek się nie odbył'; end if;
  if now() < s.end_at then raise exception 'Głosowanie rusza po zakończeniu sesji (%)', _hhmm(s.end_at); end if;
  if now() > _vote_end(s) then raise exception 'Głosowanie już się zamknęło'; end if;
  if me in (d.challenger_id, d.challenged_id) then raise exception 'Uczestnicy pojedynku nie głosują'; end if;
  if not _is_participant(d.session_id, me) then raise exception 'Głosują tylko osoby obecne na sesji'; end if;
  if p_winner is null then
    delete from duel_votes where duel_id = p_duel and voter_id = me;
  else
    if p_winner not in (d.challenger_id, d.challenged_id) then raise exception 'Nieprawidłowy wybór'; end if;
    insert into duel_votes (duel_id, voter_id, winner_id) values (p_duel, me, p_winner)
    on conflict (duel_id, voter_id) do update set winner_id = excluded.winner_id, updated_at = now();
  end if;
  perform _log(case when p_winner is null then 'glos_pojedynek_wycofany' else 'glos_pojedynek' end,
               d.session_id, p_winner, jsonb_build_object('pojedynek', p_duel), null);
end $$;

-- =====================================================================
-- RPC: MVP  (p_candidate = null → wycofanie głosu)
-- =====================================================================
create or replace function public.vote_mvp(p_session uuid, p_candidate uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := _require_member(); s sessions;
begin
  select * into s from sessions where id = p_session;
  if not found then raise exception 'Nie ma takiej sesji'; end if;
  if not s.mvp_enabled then raise exception 'W tej sesji MVP jest wyłączone'; end if;
  if now() < s.end_at then raise exception 'Głosowanie rusza po zakończeniu sesji (%)', _hhmm(s.end_at); end if;
  if now() > _vote_end(s) then raise exception 'Głosowanie już się zamknęło'; end if;
  if not _is_participant(p_session, me) then raise exception 'Głosują tylko osoby obecne na sesji'; end if;
  if p_candidate is null then
    delete from mvp_votes where session_id = p_session and voter_id = me;
  else
    if p_candidate = me then raise exception 'Nie można głosować na siebie'; end if;
    if not _is_participant(p_session, p_candidate) then raise exception 'Ta osoba nie grała w tej sesji'; end if;
    insert into mvp_votes (session_id, voter_id, candidate_id) values (p_session, me, p_candidate)
    on conflict (session_id, voter_id) do update set candidate_id = excluded.candidate_id, updated_at = now();
  end if;
  perform _log(case when p_candidate is null then 'glos_mvp_wycofany' else 'glos_mvp' end,
               p_session, p_candidate, null, null);
end $$;

-- =====================================================================
-- RPC: punkt za nieparzystość (przyznaje lider po uzgodnieniu z grupą)
-- =====================================================================
create or replace function public.award_odd(p_session uuid, p_user uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := _require_member(); s sessions; corr boolean := false; p participants;
begin
  select * into s from sessions where id = p_session;
  if not found then raise exception 'Nie ma takiej sesji'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Podaj powód (zapisze się w historii)'; end if;
  if not (me = s.leader_id and now() <= _lead_deadline(s)) then
    if am_admin() then corr := true;
    else raise exception 'Punkt za nieparzystość przyznaje lider sesji (w oknie wpisu wyników)'; end if;
  end if;
  if s.type = 'ekipowa' then raise exception 'W sesjach ekipowych ta zasada nie obowiązuje'; end if;
  if not s.duels_enabled then raise exception 'Ta zasada dotyczy tylko sesji z pojedynkami'; end if;
  select * into p from participants where session_id = p_session and user_id = p_user;
  if not found then raise exception 'Ta osoba nie grała w tej sesji'; end if;
  if p.no_challenge then raise exception 'Osoba z oznaczeniem „nie chcę wyzywać” nie dostaje punktu'; end if;
  if _in_accepted_duel(p_session, p_user) then raise exception 'Ta osoba miała parę do pojedynku'; end if;
  insert into odd_awards (session_id, user_id, reason, awarded_by) values (p_session, p_user, trim(p_reason), me)
  on conflict (session_id, user_id) do update set reason = excluded.reason, awarded_by = me, created_at = now();
  perform _log(case when corr then 'korekta_nieparzystosc' else 'punkt_nieparzystosc' end, p_session, p_user, null, p_reason);
end $$;

create or replace function public.revoke_odd(p_session uuid, p_user uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := _require_member(); s sessions; corr boolean := false;
begin
  select * into s from sessions where id = p_session;
  if not found then raise exception 'Nie ma takiej sesji'; end if;
  if not (me = s.leader_id and now() <= _lead_deadline(s)) then
    if am_admin() and coalesce(trim(p_reason), '') <> '' then corr := true;
    elsif am_admin() then raise exception 'Korekta administratora wymaga podania powodu';
    else raise exception 'Cofnąć punkt może lider (w oknie wpisu wyników) lub administrator'; end if;
  end if;
  delete from odd_awards where session_id = p_session and user_id = p_user;
  perform _log(case when corr then 'korekta_nieparzystosc_cofnieta' else 'punkt_nieparzystosc_cofniety' end,
               p_session, p_user, null, p_reason);
end $$;

-- =====================================================================
-- RPC: profil i administracja
-- =====================================================================
create or replace function public.update_my_name(p_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform _require_member();
  if length(trim(coalesce(p_name, ''))) < 2 then raise exception 'Za krótka nazwa'; end if;
  update profiles set display_name = left(trim(p_name), 40) where id = auth.uid();
end $$;

create or replace function public.admin_add_email(p_email text, p_admin boolean default false)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not am_admin() then raise exception 'Tylko administrator'; end if;
  insert into allowed_emails (email, is_admin, added_by) values (lower(trim(p_email)), p_admin, auth.uid())
  on conflict (email) do update set is_admin = excluded.is_admin;
  perform _log('ekipa_dodano', null, null, jsonb_build_object('email', lower(trim(p_email)), 'admin', p_admin), null);
end $$;

create or replace function public.admin_remove_member(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_email text;
begin
  if not am_admin() then raise exception 'Tylko administrator'; end if;
  if p_user = auth.uid() then raise exception 'Nie można usunąć samego siebie'; end if;
  select email into v_email from profiles where id = p_user;
  delete from allowed_emails where email = v_email;
  update profiles set is_member = false, is_admin = false where id = p_user;
  perform _log('ekipa_usunieto', null, p_user, jsonb_build_object('email', v_email), null);
end $$;

create or replace function public.admin_set_admin(p_user uuid, p_value boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not am_admin() then raise exception 'Tylko administrator'; end if;
  if p_user = auth.uid() and not p_value then raise exception 'Nie odbieraj sobie uprawnień – zrób to z innego konta'; end if;
  update profiles set is_admin = p_value where id = p_user and is_member;
  update allowed_emails set is_admin = p_value where email = (select email from profiles where id = p_user);
  perform _log('admin_zmiana', null, p_user, jsonb_build_object('admin', p_value), null);
end $$;

create or replace function public.admin_set_config(p_entry_hours int, p_randomy_mvp boolean, p_randomy_duels boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not am_admin() then raise exception 'Tylko administrator'; end if;
  update app_config set entry_window_hours = p_entry_hours,
                        randomy_mvp_default = p_randomy_mvp,
                        randomy_duels_default = p_randomy_duels
  where id = 1;
  perform _log('konfiguracja', null, null,
               jsonb_build_object('okno_wpisu_h', p_entry_hours, 'randomy_mvp', p_randomy_mvp, 'randomy_pojedynki', p_randomy_duels), null);
end $$;

-- Własne zdjęcie profilowe (plik w Storage: avatars/<id użytkownika>/...)
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

-- =====================================================================
-- Punkty — liczone na bieżąco z zapisanych danych (nic nie jest sumowane na zapas)
-- =====================================================================
create or replace view public.v_session_points with (security_invoker = on) as
with
part as (
  select p.session_id, p.user_id, p.team_won, p.no_challenge,
         s.type, s.start_at, s.end_at, s.mvp_enabled, s.duels_enabled
  from participants p join sessions s on s.id = p.session_id
),
team_pts as (
  select session_id, user_id, 'Wygrana drużyny'::text as reason
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
  select session_id, candidate_id as user_id, 'MVP sesji'::text as reason
  from mvp_ranked where r = 1 and n_same = 1          -- remis = brak punktu
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
         'Wygrany pojedynek'::text as reason
  from duel_counts where va <> vb                    -- remis / brak głosów = brak punktu
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
  select session_id, user_id, 'Premia za powrót'::text as reason
  from att where prev_n is not null and n - prev_n - 1 >= 4
),
odd_pts as (
  select o.session_id, o.user_id, ('Nieparzystość: ' || o.reason)::text as reason
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
         -- mieszana: MVP i pojedynek osobno (max 2); premia/nieparzystość tylko gdy nie ma żadnego z nich
         greatest(bool_or(a.reason = 'MVP sesji')::int + bool_or(a.reason = 'Wygrany pojedynek')::int,
                  bool_or(a.reason = 'Premia za powrót' or a.reason like 'Nieparzystość:%')::int)
       else 1 end as points,                          -- pozostałe typy: max 1 punkt na osobę na sesję
       array_agg(a.reason order by a.reason) as reasons
from allp a
join part p on p.session_id = a.session_id and p.user_id = a.user_id
group by a.session_id, a.user_id, p.type;

create or replace view public.v_ranking with (security_invoker = on) as
select extract(year from (s.start_at at time zone 'Europe/Warsaw'))::int as year,
       p.user_id,
       count(*)::int                                   as sessions_played,
       coalesce(sum(sp.points), 0)::int                as points,
       count(*) filter (where p.no_challenge)::int     as no_challenge_count,
       (array_agg(p.no_challenge order by s.start_at desc))[1] as last_no_challenge
from participants p
join sessions s on s.id = p.session_id and s.start_at <= now()
left join v_session_points sp on sp.session_id = p.session_id and sp.user_id = p.user_id
group by 1, 2;

-- =====================================================================
-- Uprawnienia: odczyt tylko dla ekipy, zapis wyłącznie przez RPC
-- =====================================================================
alter table public.app_config     enable row level security;
alter table public.allowed_emails enable row level security;
alter table public.profiles       enable row level security;
alter table public.sessions       enable row level security;
alter table public.participants   enable row level security;
alter table public.duels          enable row level security;
alter table public.duel_votes     enable row level security;
alter table public.mvp_votes      enable row level security;
alter table public.odd_awards     enable row level security;
alter table public.history        enable row level security;

drop policy if exists r on public.app_config;     create policy r on public.app_config     for select using (am_member());
drop policy if exists r on public.allowed_emails; create policy r on public.allowed_emails for select using (am_admin());
drop policy if exists r on public.profiles;       create policy r on public.profiles       for select
  using (id = auth.uid() or (am_member() and (is_member or am_admin())));
drop policy if exists r on public.sessions;       create policy r on public.sessions       for select using (am_member());
drop policy if exists r on public.participants;   create policy r on public.participants   for select using (am_member());
drop policy if exists r on public.duels;          create policy r on public.duels          for select using (am_member());
drop policy if exists r on public.duel_votes;     create policy r on public.duel_votes     for select using (am_member());
drop policy if exists r on public.mvp_votes;      create policy r on public.mvp_votes      for select using (am_member());
drop policy if exists r on public.odd_awards;     create policy r on public.odd_awards     for select using (am_member());
drop policy if exists r on public.history;        create policy r on public.history        for select using (am_member());

revoke insert, update, delete on all tables in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;
revoke all on all tables in schema public from anon;
grant select on public.v_session_points, public.v_ranking to authenticated;

-- Funkcje pomocnicze nie mogą być wołane bezpośrednio z przeglądarki.
revoke execute on function public._log(text, uuid, uuid, jsonb, text) from public, anon, authenticated;
revoke execute on function public._require_member() from public, anon, authenticated;
revoke execute on function public._lead_deadline(public.sessions) from public, anon, authenticated;
revoke execute on function public._vote_end(public.sessions) from public, anon, authenticated;
revoke execute on function public._next_start(public.sessions) from public, anon, authenticated;
revoke execute on function public._can_edit_results(public.sessions, uuid, uuid) from public, anon, authenticated;
revoke execute on function public._authorize_results(public.sessions, uuid, text) from public, anon, authenticated;
revoke execute on function public._in_accepted_duel(uuid, uuid) from public, anon, authenticated;
revoke execute on function public._is_participant(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.sync_allowed_email() from public, anon, authenticated;
