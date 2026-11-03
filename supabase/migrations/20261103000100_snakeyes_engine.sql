-- SNAKEYES — server-authoritative street dice engine.
--
-- Clients NEVER write tables. They get SELECT (RLS) + Realtime, and call the public RPCs
-- below (SECURITY DEFINER). Every RPC validates identity, seat, turn order, phase, balance
-- and the daily cap, then mutates state under a row lock on the room.
-- All deadlines are stored server-side and resolved by engine.tick_room(), which runs from
-- pg_cron every second and lazily on every RPC. A client can trigger a tick but a tick only
-- ever compares deadlines to the database clock, so no client can extend or skip a timer.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron with schema pg_catalog;

create schema if not exists engine;
revoke all on schema engine from public;

-- ───────────────────────────── tables ─────────────────────────────

create table public.players (
  id             uuid primary key,              -- auth.uid() for humans, random for bots
  username       text not null,
  is_bot         boolean not null default false,
  balance        bigint not null default 1000 check (balance >= 0),
  daily_cap      bigint not null default 5000 check (daily_cap between 100 and 100000),
  last_refill_at timestamptz,
  created_at     timestamptz not null default now()
);
create unique index players_human_username_key on public.players (lower(username)) where not is_bot;

create table public.rooms (
  id               text primary key,
  created_by       uuid references public.players(id),
  created_at       timestamptz not null default now(),
  phase            text not null default 'idle'
                   check (phase in ('idle','betting','catch_window','catch_vote','reroll')),
  hand_no          int not null default 0,
  roll_seq         int not null default 0,       -- resolved rolls in the current hand
  shooter_seat     int,
  point            int,
  phase_started_at timestamptz not null default now(),
  phase_deadline   timestamptz,
  current_roll_id  bigint,
  last_human_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.seats (
  room_id    text not null references public.rooms(id) on delete cascade,
  seat_no    int  not null check (seat_no between 0 and 7),
  player_id  uuid not null references public.players(id),
  is_bot     boolean not null default false,
  status     text not null default 'active' check (status in ('active','away')),
  last_seen  timestamptz not null default now(),
  hold_until timestamptz,
  joined_at  timestamptz not null default now(),
  primary key (room_id, seat_no),
  unique (room_id, player_id)
);
create index seats_player_idx on public.seats (player_id);

create table public.rolls (
  id             bigserial primary key,
  room_id        text not null references public.rooms(id) on delete cascade,
  hand_no        int not null,
  roll_seq       int not null,
  shooter_id     uuid not null references public.players(id),
  d1             int not null check (d1 between 1 and 6),
  d2             int not null check (d2 between 1 and 6),
  source         text not null check (source in ('virtual','godice','auto')),
  status         text not null default 'pending' check (status in ('pending','final','void')),
  catch_deadline timestamptz not null,
  created_at     timestamptz not null default now()
);
create index rolls_room_idx on public.rolls (room_id, id desc);

create table public.catches (
  id            bigserial primary key,
  room_id       text not null references public.rooms(id) on delete cascade,
  roll_id       bigint not null references public.rolls(id) on delete cascade,
  caller_id     uuid not null references public.players(id),
  reason        text not null,
  eligible      int not null,
  vote_deadline timestamptz not null,
  status        text not null default 'open' check (status in ('open','upheld','rejected')),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  unique (roll_id)
);

create table public.catch_votes (
  catch_id   bigint not null references public.catches(id) on delete cascade,
  voter_id   uuid not null references public.players(id),
  agree      boolean not null,
  created_at timestamptz not null default now(),
  primary key (catch_id, voter_id)
);

create table public.bets (
  id                 bigserial primary key,
  room_id            text not null references public.rooms(id) on delete cascade,
  hand_no            int not null,
  placed_before_roll int not null,
  player_id          uuid not null references public.players(id),
  side               text not null check (side in ('with','against')),
  amount             bigint not null check (amount > 0),
  status             text not null default 'open' check (status in ('open','locked','won','lost','refunded')),
  payout             bigint not null default 0,
  created_at         timestamptz not null default now(),
  settled_at         timestamptz
);
create index bets_room_hand_idx on public.bets (room_id, hand_no);

create table public.play_ledger (
  player_id uuid not null references public.players(id),
  day       date not null,
  wagered   bigint not null default 0,
  primary key (player_id, day)
);

create table public.events (            -- hand history; every state change writes one
  id         bigserial primary key,
  room_id    text not null references public.rooms(id) on delete cascade,
  created_at timestamptz not null default now(),
  hand_no    int,
  kind       text not null,
  actor_id   uuid,
  actor_name text,
  data       jsonb not null default '{}'
);
create index events_room_idx on public.events (room_id, id desc);

-- ───────────────────────────── RLS: read-only for clients ─────────────────────────────

alter table public.players     enable row level security;
alter table public.rooms       enable row level security;
alter table public.seats       enable row level security;
alter table public.rolls       enable row level security;
alter table public.catches     enable row level security;
alter table public.catch_votes enable row level security;
alter table public.bets        enable row level security;
alter table public.play_ledger enable row level security;
alter table public.events      enable row level security;

create policy players_read     on public.players     for select to anon, authenticated using (true);
create policy rooms_read       on public.rooms       for select to anon, authenticated using (true);
create policy seats_read       on public.seats       for select to anon, authenticated using (true);
create policy rolls_read       on public.rolls       for select to anon, authenticated using (true);
create policy catches_read     on public.catches     for select to anon, authenticated using (true);
create policy catch_votes_read on public.catch_votes for select to anon, authenticated using (true);
create policy bets_read        on public.bets        for select to anon, authenticated using (true);
create policy events_read      on public.events      for select to anon, authenticated using (true);
create policy ledger_read_own  on public.play_ledger for select to authenticated using (player_id = auth.uid());

-- belt and braces: no write grants at all, even if a policy were added by mistake
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke usage, select, update on all sequences in schema public from anon, authenticated;
grant select on all tables in schema public to anon, authenticated;

-- ───────────────────────────── rules (mirrored in src/lib/rules.ts) ─────────────────────────────

create or replace function public.rules_config() returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'maxSeats', 8, 'startingCoins', 1000, 'minBet', 10, 'maxBet', 1000,
    'catchWindowSec', 5, 'catchVoteSec', 6, 'shotClockSec', 25,
    'disconnectAfterSec', 8, 'seatHoldSec', 30, 'defaultDailyCap', 5000)
$$;

create or replace function engine.cfg(k text) returns int
language sql immutable set search_path = '' as $$ select (public.rules_config() ->> k)::int $$;

create or replace function engine.secs(k text) returns interval
language sql immutable set search_path = '' as $$ select make_interval(secs => engine.cfg(k)) $$;

create or replace function public.rules_resolve_roll(p_point int, p_total int) returns jsonb
language plpgsql immutable set search_path = '' as $$
begin
  if p_total is null or p_total < 2 or p_total > 12 then raise exception 'BAD_TOTAL'; end if;
  if p_point is null then
    if p_total in (7, 11) then return jsonb_build_object('outcome','win','point',null); end if;
    if p_total in (2, 3, 12) then return jsonb_build_object('outcome','lose','point',null); end if;
    return jsonb_build_object('outcome','point','point',p_total);
  end if;
  if p_point not in (4,5,6,8,9,10) then raise exception 'BAD_POINT'; end if;
  if p_total = p_point then return jsonb_build_object('outcome','win','point',p_point); end if;
  if p_total = 7 then return jsonb_build_object('outcome','lose','point',p_point); end if;
  return jsonb_build_object('outcome','continue','point',p_point);
end $$;

create or replace function public.rules_settle_bet(p_side text, p_amount bigint, p_result text) returns bigint
language sql immutable set search_path = '' as $$
  select case when (p_side = 'with' and p_result = 'win') or (p_side = 'against' and p_result = 'lose')
              then p_amount * 2 else 0 end
$$;

create or replace function public.rules_catch_verdict(p_eligible int, p_agree int, p_disagree int, p_closed boolean)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_eligible <= 0 then 'rejected'
    when p_agree * 2 > p_eligible then 'upheld'
    when (p_eligible - p_disagree) * 2 <= p_eligible then 'rejected'
    when p_closed then 'rejected'
    else 'open' end
$$;

-- ───────────────────────────── engine internals (not exposed via the API) ─────────────────────────────

create or replace function engine.err(code text) returns void
language plpgsql set search_path = '' as $$ begin raise exception using message = code, errcode = 'P0001'; end $$;

create or replace function engine.die() returns int
language plpgsql volatile set search_path = '' as $$
declare b int;
begin
  loop  -- rejection sampling keeps all six faces exactly equally likely
    b := get_byte(extensions.gen_random_bytes(1), 0);
    exit when b < 252;
  end loop;
  return 1 + b % 6;
end $$;

create or replace function engine.today() returns date
language sql stable set search_path = '' as $$ select (now() at time zone 'America/Chicago')::date $$;

create or replace function engine.me() returns uuid
language plpgsql stable set search_path = '' as $$
declare v uuid := auth.uid();
begin
  if v is null or not exists (select 1 from public.players where id = v) then perform engine.err('NOT_SIGNED_IN'); end if;
  return v;
end $$;

create or replace function engine.log(p_room text, p_kind text, p_actor uuid, p_data jsonb default '{}')
returns void language sql set search_path = '' as $$
  insert into public.events (room_id, hand_no, kind, actor_id, actor_name, data)
  values (p_room, (select hand_no from public.rooms where id = p_room), p_kind, p_actor,
          (select username from public.players where id = p_actor), coalesce(p_data, '{}'));
$$;

create or replace function engine.lock_room(p_room text) returns public.rooms
language plpgsql set search_path = '' as $$
declare r public.rooms;
begin
  select * into r from public.rooms where id = upper(p_room) for update;
  if not found then perform engine.err('NO_ROOM'); end if;
  return r;
end $$;

create or replace function engine.next_shooter(p_room text, p_current int) returns int
language sql stable set search_path = '' as $$
  select coalesce(
    (select seat_no from public.seats where room_id = p_room and status = 'active' and seat_no > coalesce(p_current, -1) order by seat_no limit 1),
    (select seat_no from public.seats where room_id = p_room and status = 'active' order by seat_no limit 1))
$$;

create or replace function engine.set_phase(p_room text, p_phase text, p_secs interval) returns void
language sql set search_path = '' as $$
  update public.rooms set phase = p_phase, phase_started_at = now(),
    phase_deadline = case when p_secs is null then null else now() + p_secs end, updated_at = now()
  where id = p_room;
$$;

create or replace function engine.start_hand(p_room text, p_after int) returns void
language plpgsql set search_path = '' as $$
declare s int;
begin
  s := engine.next_shooter(p_room, p_after);
  if s is null then
    update public.rooms set phase = 'idle', shooter_seat = null, point = null, current_roll_id = null,
      phase_deadline = null, phase_started_at = now(), updated_at = now() where id = p_room;
    return;
  end if;
  update public.rooms set hand_no = hand_no + 1, roll_seq = 0, point = null, shooter_seat = s,
    current_roll_id = null, phase = 'betting', phase_started_at = now(),
    phase_deadline = now() + engine.secs('shotClockSec'), updated_at = now()
  where id = p_room;
  perform engine.log(p_room, 'new_hand', (select player_id from public.seats where room_id = p_room and seat_no = s),
                     jsonb_build_object('seat', s));
end $$;

create or replace function engine.refund_bets(p_room text, p_player uuid, p_statuses text[]) returns bigint
language plpgsql set search_path = '' as $$
declare b record; total bigint := 0;
begin
  for b in select * from public.bets
           where room_id = p_room and status = any(p_statuses) and (p_player is null or player_id = p_player)
           for update loop
    update public.bets set status = 'refunded', payout = b.amount, settled_at = now() where id = b.id;
    update public.players set balance = balance + b.amount where id = b.player_id;
    update public.play_ledger set wagered = greatest(0, wagered - b.amount)
      where player_id = b.player_id and day = (b.created_at at time zone 'America/Chicago')::date;
    perform engine.log(p_room, 'refund', b.player_id, jsonb_build_object('amount', b.amount, 'bet_id', b.id));
    total := total + b.amount;
  end loop;
  return total;
end $$;

create or replace function engine.skip_shooter(p_room text, p_reason text) returns void
language plpgsql set search_path = '' as $$
declare r public.rooms;
begin
  r := engine.lock_room(p_room);
  if r.roll_seq > 0 or r.phase = 'reroll'
     or exists (select 1 from public.bets where room_id = p_room and hand_no = r.hand_no and status = 'locked') then
    perform engine.log(p_room, 'hand_void', null, jsonb_build_object('reason', p_reason, 'seat', r.shooter_seat));
  else
    perform engine.log(p_room, 'skip', null, jsonb_build_object('reason', p_reason, 'seat', r.shooter_seat));
  end if;
  perform engine.refund_bets(p_room, null, array['open','locked']);
  perform engine.start_hand(p_room, r.shooter_seat);
end $$;

create or replace function engine.do_join(p_room text, p_player uuid) returns int
language plpgsql set search_path = '' as $$
declare r public.rooms; s public.seats; free int; bot boolean;
begin
  r := engine.lock_room(p_room);
  select * into s from public.seats where room_id = r.id and player_id = p_player;
  if found then
    if s.status = 'away' then
      update public.seats set status = 'active', hold_until = null, last_seen = now() where room_id = r.id and seat_no = s.seat_no;
      perform engine.log(r.id, 'reconnect', p_player, jsonb_build_object('seat', s.seat_no));
    else
      update public.seats set last_seen = now() where room_id = r.id and seat_no = s.seat_no;
    end if;
    return s.seat_no;
  end if;
  select min(g) into free from generate_series(0, engine.cfg('maxSeats') - 1) g
   where not exists (select 1 from public.seats where room_id = r.id and seat_no = g);
  if free is null then perform engine.err('ROOM_FULL'); end if;
  select is_bot into bot from public.players where id = p_player;
  insert into public.seats (room_id, seat_no, player_id, is_bot) values (r.id, free, p_player, coalesce(bot, false));
  perform engine.log(r.id, 'join', p_player, jsonb_build_object('seat', free, 'bot', coalesce(bot, false)));
  if r.phase = 'idle' then perform engine.start_hand(r.id, null); end if;
  return free;
end $$;

create or replace function engine.do_leave(p_room text, p_player uuid, p_kind text default 'leave') returns void
language plpgsql set search_path = '' as $$
declare r public.rooms; s public.seats;
begin
  r := engine.lock_room(p_room);
  select * into s from public.seats where room_id = r.id and player_id = p_player;
  if not found then return; end if;
  perform engine.refund_bets(r.id, p_player, array['open']);  -- locked stakes stay in play and still settle
  delete from public.seats where room_id = r.id and seat_no = s.seat_no;
  perform engine.log(r.id, p_kind, p_player, jsonb_build_object('seat', s.seat_no));
  if not exists (select 1 from public.seats where room_id = r.id) then
    perform engine.start_hand(r.id, null);  -- no one left: goes idle
  elsif s.seat_no = r.shooter_seat and r.phase in ('betting', 'reroll') then
    perform engine.skip_shooter(r.id, 'shooter_left');
  end if;
end $$;

create or replace function engine.do_bet(p_room text, p_player uuid, p_side text, p_amount bigint) returns bigint
language plpgsql set search_path = '' as $$
declare r public.rooms; s public.seats; p public.players; played bigint; bid bigint;
begin
  r := engine.lock_room(p_room);
  if r.phase <> 'betting' then perform engine.err('BETTING_CLOSED'); end if;
  select * into s from public.seats where room_id = r.id and player_id = p_player;
  if not found or s.status <> 'active' then perform engine.err('NOT_SEATED'); end if;
  if p_side is null or p_side not in ('with', 'against') then perform engine.err('BAD_SIDE'); end if;
  if p_amount is null or p_amount < engine.cfg('minBet') or p_amount > engine.cfg('maxBet') then perform engine.err('BAD_AMOUNT'); end if;
  if s.seat_no = r.shooter_seat and p_side <> 'with' then perform engine.err('SHOOTER_BETS_WITH'); end if;
  if exists (select 1 from public.bets where room_id = r.id and hand_no = r.hand_no and player_id = p_player
             and side <> p_side and status in ('open', 'locked')) then perform engine.err('ONE_SIDE_PER_HAND'); end if;
  select * into p from public.players where id = p_player for update;
  if p.balance < p_amount then perform engine.err('INSUFFICIENT_COINS'); end if;
  played := coalesce((select wagered from public.play_ledger where player_id = p_player and day = engine.today()), 0);
  if played + p_amount > p.daily_cap then perform engine.err('DAILY_CAP'); end if;

  update public.players set balance = balance - p_amount where id = p_player;
  insert into public.play_ledger (player_id, day, wagered) values (p_player, engine.today(), p_amount)
    on conflict (player_id, day) do update set wagered = public.play_ledger.wagered + excluded.wagered;
  insert into public.bets (room_id, hand_no, placed_before_roll, player_id, side, amount)
    values (r.id, r.hand_no, r.roll_seq, p_player, p_side, p_amount) returning id into bid;
  perform engine.log(r.id, 'bet', p_player, jsonb_build_object('side', p_side, 'amount', p_amount, 'bet_id', bid));
  return bid;
end $$;

create or replace function engine.do_clear_bets(p_room text, p_player uuid) returns bigint
language plpgsql set search_path = '' as $$
declare r public.rooms;
begin
  r := engine.lock_room(p_room);
  if r.phase <> 'betting' then perform engine.err('BETTING_CLOSED'); end if;
  return engine.refund_bets(r.id, p_player, array['open']);
end $$;

create or replace function engine.do_roll(p_room text, p_player uuid, p_source text, p_d1 int, p_d2 int) returns bigint
language plpgsql set search_path = '' as $$
declare r public.rooms; s public.seats; a int; b int; rid bigint;
begin
  r := engine.lock_room(p_room);
  if r.phase not in ('betting', 'reroll') then perform engine.err('NOT_YOUR_TURN'); end if;
  select * into s from public.seats where room_id = r.id and player_id = p_player;
  if not found or s.seat_no is distinct from r.shooter_seat then perform engine.err('NOT_YOUR_TURN'); end if;
  if p_source in ('virtual', 'auto') then
    a := engine.die(); b := engine.die();            -- the server picks the faces; client values are ignored
  elsif p_source = 'godice' then                     -- physical dice report their faces (see README: trust model)
    if p_d1 is null or p_d2 is null or p_d1 not between 1 and 6 or p_d2 not between 1 and 6 then perform engine.err('BAD_DICE'); end if;
    a := p_d1; b := p_d2;
  else
    perform engine.err('BAD_SOURCE');
  end if;

  update public.bets set status = 'locked' where room_id = r.id and hand_no = r.hand_no and status = 'open';
  insert into public.rolls (room_id, hand_no, roll_seq, shooter_id, d1, d2, source, catch_deadline)
    values (r.id, r.hand_no, r.roll_seq + 1, p_player, a, b, p_source, now() + engine.secs('catchWindowSec'))
    returning id into rid;
  update public.rooms set phase = 'catch_window', phase_started_at = now(),
    phase_deadline = now() + engine.secs('catchWindowSec'), current_roll_id = rid, updated_at = now()
  where id = r.id;
  perform engine.log(r.id, 'roll', p_player, jsonb_build_object('d1', a, 'd2', b, 'total', a + b,
                     'source', p_source, 'point', r.point, 'roll_id', rid));
  return rid;
end $$;

create or replace function engine.settle_hand(p_room text, p_result text) returns void
language plpgsql set search_path = '' as $$
declare r public.rooms; b record; pay bigint; agg record;
begin
  r := engine.lock_room(p_room);
  perform engine.log(p_room, 'hand_end', (select player_id from public.seats where room_id = p_room and seat_no = r.shooter_seat),
                     jsonb_build_object('result', p_result, 'point', r.point));
  for b in select * from public.bets where room_id = p_room and hand_no = r.hand_no and status = 'locked' for update loop
    pay := public.rules_settle_bet(b.side, b.amount, p_result);
    update public.bets set status = case when pay > 0 then 'won' else 'lost' end, payout = pay, settled_at = now() where id = b.id;
    if pay > 0 then update public.players set balance = balance + pay where id = b.player_id; end if;
  end loop;
  for agg in select player_id, sum(amount) as staked, sum(payout) as paid from public.bets
             where room_id = p_room and hand_no = r.hand_no and status in ('won', 'lost') and settled_at = now()
             group by player_id loop
    perform engine.log(p_room, 'payout', agg.player_id,
      jsonb_build_object('staked', agg.staked, 'paid', agg.paid, 'net', agg.paid - agg.staked));
  end loop;
end $$;

create or replace function engine.finalize_roll(p_room text) returns void
language plpgsql set search_path = '' as $$
declare r public.rooms; ro public.rolls; res jsonb; outcome text;
begin
  r := engine.lock_room(p_room);
  select * into ro from public.rolls where id = r.current_roll_id for update;
  if not found then return; end if;
  update public.rolls set status = 'final' where id = ro.id;
  res := public.rules_resolve_roll(r.point, ro.d1 + ro.d2);
  outcome := res ->> 'outcome';
  update public.rooms set roll_seq = roll_seq + 1, current_roll_id = null where id = r.id;
  perform engine.log(r.id, 'roll_result', ro.shooter_id, jsonb_build_object('d1', ro.d1, 'd2', ro.d2,
                     'total', ro.d1 + ro.d2, 'outcome', outcome, 'point', res -> 'point', 'roll_id', ro.id));
  if outcome = 'point' then
    update public.rooms set point = (res ->> 'point')::int where id = r.id;
    perform engine.log(r.id, 'point_set', ro.shooter_id, jsonb_build_object('point', (res ->> 'point')::int));
    perform engine.set_phase(r.id, 'betting', engine.secs('shotClockSec'));
  elsif outcome = 'continue' then
    perform engine.set_phase(r.id, 'betting', engine.secs('shotClockSec'));
  else
    perform engine.settle_hand(r.id, outcome);
    perform engine.start_hand(r.id, r.shooter_seat);
  end if;
end $$;

create or replace function engine.check_catch(p_room text, p_closed boolean) returns text
language plpgsql set search_path = '' as $$
declare r public.rooms; c public.catches; yes int; no int; v text;
begin
  r := engine.lock_room(p_room);
  select * into c from public.catches where roll_id = r.current_roll_id and status = 'open' for update;
  if not found then return null; end if;
  select count(*) filter (where agree), count(*) filter (where not agree) into yes, no
    from public.catch_votes where catch_id = c.id;
  v := public.rules_catch_verdict(c.eligible, yes, no, p_closed);
  if v = 'upheld' then
    update public.catches set status = 'upheld', resolved_at = now() where id = c.id;
    update public.rolls set status = 'void' where id = c.roll_id;
    update public.rooms set current_roll_id = null where id = r.id;
    perform engine.set_phase(r.id, 'reroll', engine.secs('shotClockSec'));
    perform engine.log(r.id, 'catch_upheld', c.caller_id, jsonb_build_object('agree', yes, 'disagree', no,
                       'eligible', c.eligible, 'roll_id', c.roll_id, 'catch_id', c.id));
  elsif v = 'rejected' then
    update public.catches set status = 'rejected', resolved_at = now() where id = c.id;
    perform engine.log(r.id, 'catch_rejected', c.caller_id, jsonb_build_object('agree', yes, 'disagree', no,
                       'eligible', c.eligible, 'roll_id', c.roll_id, 'catch_id', c.id));
    perform engine.finalize_roll(r.id);
  end if;
  return v;
end $$;

create or replace function engine.do_call_catch(p_room text, p_player uuid, p_reason text) returns bigint
language plpgsql set search_path = '' as $$
declare r public.rooms; s public.seats; n int; cid bigint;
begin
  r := engine.lock_room(p_room);
  if r.phase = 'catch_vote' then perform engine.err('CATCH_ALREADY_CALLED'); end if;
  if r.phase <> 'catch_window' or now() >= r.phase_deadline then perform engine.err('CATCH_WINDOW_CLOSED'); end if;
  select * into s from public.seats where room_id = r.id and player_id = p_player;
  if not found or s.status <> 'active' then perform engine.err('NOT_SEATED'); end if;
  if s.seat_no = r.shooter_seat then perform engine.err('SHOOTER_CANNOT_CATCH'); end if;
  select count(*) into n from public.seats where room_id = r.id and status = 'active' and seat_no <> r.shooter_seat;
  insert into public.catches (room_id, roll_id, caller_id, reason, eligible, vote_deadline)
    values (r.id, r.current_roll_id, p_player,
            case when p_reason in ('off_table', 'cocked', 'bad_throw', 'other') then p_reason else 'other' end,
            n, now() + engine.secs('catchVoteSec'))
    returning id into cid;
  insert into public.catch_votes (catch_id, voter_id, agree) values (cid, p_player, true);
  perform engine.set_phase(r.id, 'catch_vote', engine.secs('catchVoteSec'));
  perform engine.log(r.id, 'catch_call', p_player, jsonb_build_object('reason', p_reason, 'eligible', n,
                     'roll_id', r.current_roll_id, 'catch_id', cid));
  perform engine.check_catch(r.id, false);
  return cid;
end $$;

create or replace function engine.do_vote(p_room text, p_player uuid, p_agree boolean) returns text
language plpgsql set search_path = '' as $$
declare r public.rooms; s public.seats; c public.catches;
begin
  r := engine.lock_room(p_room);
  if r.phase <> 'catch_vote' or now() >= r.phase_deadline then perform engine.err('NO_OPEN_CATCH'); end if;
  select * into c from public.catches where roll_id = r.current_roll_id and status = 'open';
  if not found then perform engine.err('NO_OPEN_CATCH'); end if;
  select * into s from public.seats where room_id = r.id and player_id = p_player;
  if not found or s.status <> 'active' or s.joined_at > c.created_at then perform engine.err('NOT_SEATED'); end if;
  if s.seat_no = r.shooter_seat then perform engine.err('SHOOTER_CANNOT_CATCH'); end if;
  if exists (select 1 from public.catch_votes where catch_id = c.id and voter_id = p_player) then perform engine.err('ALREADY_VOTED'); end if;
  insert into public.catch_votes (catch_id, voter_id, agree) values (c.id, p_player, coalesce(p_agree, false));
  perform engine.log(r.id, 'catch_vote', p_player, jsonb_build_object('agree', coalesce(p_agree, false), 'catch_id', c.id));
  return engine.check_catch(r.id, false);
end $$;

-- Bots act through the same do_* functions as humans: same validation, same events.
create or replace function engine.bots_act(p_room text) returns void
language plpgsql set search_path = '' as $$
declare r public.rooms; b record; age float8; my_side text; c public.catches;
begin
  for b in select s.seat_no, s.player_id, s.joined_at, p.balance from public.seats s
           join public.players p on p.id = s.player_id where s.room_id = p_room and p.is_bot order by s.seat_no loop
    select * into r from public.rooms where id = p_room;
    age := extract(epoch from now() - r.phase_started_at);
    begin
      if b.balance < 100 then update public.players set balance = 1000 where id = b.player_id; end if;
      if r.phase = 'betting' and b.seat_no = r.shooter_seat then
        if r.roll_seq = 0 and age >= 1 and not exists (select 1 from public.bets where room_id = p_room
             and hand_no = r.hand_no and player_id = b.player_id) then
          perform engine.do_bet(p_room, b.player_id, 'with', (5 * (5 + floor(random() * 16)))::bigint);
        end if;
        if age >= 3.5 then perform engine.do_roll(p_room, b.player_id, 'virtual', null, null); end if;
      elsif r.phase = 'reroll' and b.seat_no = r.shooter_seat and age >= 2.5 then
        perform engine.do_roll(p_room, b.player_id, 'virtual', null, null);
      elsif r.phase = 'betting' and age >= 1 and random() < 0.35 and not exists (select 1 from public.bets
             where room_id = p_room and hand_no = r.hand_no and player_id = b.player_id and placed_before_roll = r.roll_seq) then
        select side into my_side from public.bets where room_id = p_room and hand_no = r.hand_no
          and player_id = b.player_id and status in ('open', 'locked') limit 1;
        perform engine.do_bet(p_room, b.player_id,
          coalesce(my_side, case when random() < 0.7 then 'against' else 'with' end),
          (5 * (5 + floor(random() * 26)))::bigint);
      elsif r.phase = 'catch_window' and b.seat_no <> r.shooter_seat and age >= 1.5 and random() < 0.01 then
        perform engine.do_call_catch(p_room, b.player_id, 'cocked');
      elsif r.phase = 'catch_vote' and b.seat_no <> r.shooter_seat and age >= 1 and random() < 0.6 then
        select * into c from public.catches where roll_id = r.current_roll_id and status = 'open';
        if found and b.joined_at <= c.created_at
           and not exists (select 1 from public.catch_votes where catch_id = c.id and voter_id = b.player_id) then
          perform engine.do_vote(p_room, b.player_id, random() < 0.5);   -- bots agree ~50% of the time
        end if;
      end if;
    exception when others then
      null;  -- a bot hitting a rule (cap, closed window) just sits this tick out
    end;
  end loop;
end $$;

create or replace function engine.tick_room(p_room text) returns void
language plpgsql set search_path = '' as $$
declare r public.rooms; s record; shooter public.players;
begin
  r := engine.lock_room(p_room);

  -- presence: missed heartbeats -> away (seat held), hold expired -> seat released
  for s in select st.* from public.seats st where st.room_id = r.id and not st.is_bot and st.status = 'active'
           and st.last_seen < now() - engine.secs('disconnectAfterSec') loop
    update public.seats set status = 'away', hold_until = now() + engine.secs('seatHoldSec')
     where room_id = r.id and seat_no = s.seat_no;
    perform engine.log(r.id, 'disconnect', s.player_id,
      jsonb_build_object('seat', s.seat_no, 'hold_until', now() + engine.secs('seatHoldSec')));
  end loop;
  for s in select st.* from public.seats st where st.room_id = r.id and st.status = 'away' and st.hold_until <= now() loop
    perform engine.do_leave(r.id, s.player_id, 'seat_released');
  end loop;

  select * into r from public.rooms where id = r.id;
  if not exists (select 1 from public.seats where room_id = r.id) then
    if r.phase <> 'idle' then perform engine.start_hand(r.id, null); end if;  -- empty table goes idle
    return;
  end if;
  if not exists (select 1 from public.seats where room_id = r.id and status = 'active') then
    return;  -- everyone is away: hold the table until someone returns or holds expire
  end if;
  if r.phase = 'idle' then perform engine.start_hand(r.id, null); return; end if;

  -- shooter disconnected: auto-skip the turn (bets on an unfinished hand are refunded)
  if r.phase in ('betting', 'reroll') and not exists (select 1 from public.seats where room_id = r.id
       and seat_no = r.shooter_seat and status = 'active') then
    perform engine.skip_shooter(r.id, 'shooter_away');
    return;
  end if;

  -- deadlines (database clock only)
  if r.phase = 'catch_window' and now() >= r.phase_deadline then perform engine.finalize_roll(r.id); return; end if;
  if r.phase = 'catch_vote' and now() >= r.phase_deadline then perform engine.check_catch(r.id, true); return; end if;
  if r.phase in ('betting', 'reroll') and now() >= r.phase_deadline then
    select p.* into shooter from public.players p join public.seats st on st.player_id = p.id
     where st.room_id = r.id and st.seat_no = r.shooter_seat;
    perform engine.do_roll(r.id, shooter.id, 'auto', null, null);   -- shot clock expired: house rolls for them
    return;
  end if;

  perform engine.bots_act(r.id);
end $$;

create or replace function engine.tick_all() returns int
language plpgsql set search_path = '' as $$
declare rid text; n int := 0;
begin
  for rid in select id from public.rooms where last_human_at > now() - interval '90 seconds' loop
    begin
      perform 1 from public.rooms where id = rid for update skip locked;
      if found then perform engine.tick_room(rid); n := n + 1; end if;
    exception when others then
      raise warning 'tick % failed: %', rid, sqlerrm;
    end;
  end loop;
  return n;
end $$;

-- ───────────────────────────── public RPCs (the only write path) ─────────────────────────────

create or replace function public.server_now() returns timestamptz
language sql stable security definer set search_path = '' as $$ select now() $$;

create or replace function public.sign_in(p_username text) returns public.players
language plpgsql security definer set search_path = '' as $$
declare v uuid := auth.uid(); p public.players;
begin
  if v is null then perform engine.err('NOT_SIGNED_IN'); end if;
  if p_username is null or p_username !~ '^[A-Za-z0-9_]{2,16}$' then perform engine.err('BAD_NAME'); end if;
  if exists (select 1 from public.players where lower(username) = lower(p_username) and not is_bot and id <> v) then
    perform engine.err('NAME_TAKEN');
  end if;
  insert into public.players (id, username) values (v, p_username)
    on conflict (id) do update set username = excluded.username
    returning * into p;
  return p;
exception when unique_violation then
  perform engine.err('NAME_TAKEN'); return null;
end $$;

create or replace function public.create_room() returns text
language plpgsql security definer set search_path = '' as $$
declare me uuid := engine.me(); code text; alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
begin
  loop
    code := (select string_agg(substr(alphabet, 1 + get_byte(extensions.gen_random_bytes(1), 0) % length(alphabet), 1), '')
             from generate_series(1, 5));
    exit when not exists (select 1 from public.rooms where id = code);
  end loop;
  insert into public.rooms (id, created_by) values (code, me);
  perform engine.log(code, 'room_created', me);
  perform engine.do_join(code, me);
  return code;
end $$;

create or replace function public.join_room(p_room text) returns int
language plpgsql security definer set search_path = '' as $$
declare me uuid := engine.me(); seat int;
begin
  perform engine.tick_room(p_room);
  seat := engine.do_join(upper(p_room), me);
  update public.rooms set last_human_at = now() where id = upper(p_room);
  return seat;
end $$;

create or replace function public.leave_room(p_room text) returns void
language plpgsql security definer set search_path = '' as $$
begin perform engine.do_leave(upper(p_room), engine.me(), 'leave'); end $$;

create or replace function public.heartbeat(p_room text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); s public.seats; rid text := upper(p_room);
begin
  perform engine.lock_room(rid);
  update public.rooms set last_human_at = now() where id = rid;
  if me is not null then
    select * into s from public.seats where room_id = rid and player_id = me;
    if found then
      if s.status = 'away' then perform engine.do_join(rid, me);
      else update public.seats set last_seen = now() where room_id = rid and seat_no = s.seat_no; end if;
    end if;
  end if;
  perform engine.tick_room(rid);
  return jsonb_build_object('now', now(), 'seat', s.seat_no);
end $$;

create or replace function public.place_bet(p_room text, p_side text, p_amount bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare me uuid := engine.me();
begin perform engine.tick_room(p_room); return engine.do_bet(upper(p_room), me, p_side, p_amount); end $$;

create or replace function public.clear_bets(p_room text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare me uuid := engine.me();
begin perform engine.tick_room(p_room); return engine.do_clear_bets(upper(p_room), me); end $$;

create or replace function public.roll_dice(p_room text, p_source text default 'virtual', p_d1 int default null, p_d2 int default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare me uuid := engine.me();
begin
  if p_source not in ('virtual', 'godice') then perform engine.err('BAD_SOURCE'); end if;  -- 'auto' is server-only
  perform engine.tick_room(p_room);
  return engine.do_roll(upper(p_room), me, p_source, p_d1, p_d2);
end $$;

create or replace function public.call_catch(p_room text, p_reason text default 'other') returns bigint
language plpgsql security definer set search_path = '' as $$
declare me uuid := engine.me();
begin perform engine.tick_room(p_room); return engine.do_call_catch(upper(p_room), me, p_reason); end $$;

create or replace function public.vote_catch(p_room text, p_agree boolean) returns text
language plpgsql security definer set search_path = '' as $$
declare me uuid := engine.me();
begin perform engine.tick_room(p_room); return engine.do_vote(upper(p_room), me, p_agree); end $$;

create or replace function public.fill_bots(p_room text, p_count int default 3) returns int
language plpgsql security definer set search_path = '' as $$
declare me uuid := engine.me(); rid text := upper(p_room); names text[] := array['Lucky','Slim','Dutch','Kiki','Rio','Ace','Moxie','Tank'];
        added int := 0; nm text; bid uuid; free int;
begin
  perform engine.lock_room(rid);
  if not exists (select 1 from public.seats where room_id = rid and player_id = me) then perform engine.err('NOT_SEATED'); end if;
  foreach nm in array names loop
    exit when added >= least(greatest(coalesce(p_count, 3), 0), 3);
    continue when exists (select 1 from public.seats s join public.players p on p.id = s.player_id
                          where s.room_id = rid and p.is_bot and p.username = nm);
    select count(*) into free from public.seats where room_id = rid;
    exit when free >= engine.cfg('maxSeats');
    bid := gen_random_uuid();
    insert into public.players (id, username, is_bot, daily_cap) values (bid, nm, true, 100000);
    perform engine.do_join(rid, bid);
    added := added + 1;
  end loop;
  return added;
end $$;

create or replace function public.remove_bots(p_room text) returns int
language plpgsql security definer set search_path = '' as $$
declare me uuid := engine.me(); rid text := upper(p_room); b record; n int := 0;
begin
  perform engine.lock_room(rid);
  if not exists (select 1 from public.seats where room_id = rid and player_id = me) then perform engine.err('NOT_SEATED'); end if;
  for b in select player_id from public.seats where room_id = rid and is_bot loop
    perform engine.do_leave(rid, b.player_id, 'leave'); n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.set_daily_cap(p_cap bigint) returns bigint
language plpgsql security definer set search_path = '' as $$
declare me uuid := engine.me();
begin
  if p_cap is null or p_cap < 100 or p_cap > 100000 then perform engine.err('BAD_AMOUNT'); end if;
  update public.players set daily_cap = p_cap where id = me;
  return p_cap;
end $$;

create or replace function public.refill() returns bigint
language plpgsql security definer set search_path = '' as $$
declare me uuid := engine.me(); p public.players;
begin
  select * into p from public.players where id = me for update;
  if p.balance >= 100 or (p.last_refill_at is not null and p.last_refill_at > now() - interval '1 hour') then
    perform engine.err('NO_REFILL');
  end if;
  update public.players set balance = 1000, last_refill_at = now() where id = me;
  return 1000;
end $$;

create or replace function public.my_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'username', p.username, 'balance', p.balance, 'daily_cap', p.daily_cap,
    'played_today', coalesce((select wagered from public.play_ledger where player_id = p.id and day = engine.today()), 0),
    'server_now', now())
  from public.players p where p.id = auth.uid()
$$;

-- ───────────────────────────── privileges ─────────────────────────────

revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema engine from public, anon, authenticated;
grant execute on function public.rules_config(), public.rules_resolve_roll(int, int),
  public.rules_settle_bet(text, bigint, text), public.rules_catch_verdict(int, int, int, boolean),
  public.server_now() to anon, authenticated;
grant execute on function public.sign_in(text), public.create_room(), public.join_room(text), public.leave_room(text),
  public.heartbeat(text), public.place_bet(text, text, bigint), public.clear_bets(text),
  public.roll_dice(text, text, int, int), public.call_catch(text, text), public.vote_catch(text, boolean),
  public.fill_bots(text, int), public.remove_bots(text), public.set_daily_cap(bigint), public.refill(),
  public.my_status() to authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ───────────────────────────── realtime + server clock ─────────────────────────────

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.rooms, public.events, public.seats;
  end if;
end $$;

select cron.schedule('snakeyes-tick', '1 seconds', $$select engine.tick_all()$$);
select cron.schedule('snakeyes-cron-log-purge', '*/10 * * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '1 hour'$$);
