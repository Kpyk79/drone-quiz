-- Drone Show: run once in Supabase -> SQL Editor
-- Drone Show quiz: elimination game.
-- Tables are locked by RLS (no policies); browsers use only the SECURITY DEFINER functions below.
-- Safe to re-run: drops previous quiz_* objects first.

do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'quiz\_%' loop
    execute 'drop function ' || r.sig || ' cascade';
  end loop;
end $$;
drop table if exists public.quiz_answers, public.quiz_players, public.quiz_games, public.quiz_questions cascade;

create table public.quiz_questions (
  id serial primary key,
  set_name text not null default 'drones',
  position int not null,
  emoji text,
  question text not null,
  options jsonb not null,
  correct int not null,
  unique (set_name, position)
);

create table public.quiz_games (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  host_secret uuid not null default gen_random_uuid(),
  set_name text not null default 'drones',
  status text not null default 'lobby' check (status in ('lobby','stage','finished')),
  lobby_ends_at timestamptz not null default now() + interval '10 minutes',
  keep_ratio numeric not null default 0.5 check (keep_ratio > 0 and keep_ratio < 1),
  q_seconds int not null default 60,
  stage_no int not null default 0,
  stage_started_at timestamptz,
  resolved_stage int not null default 0,
  resolve_at timestamptz,
  no_correct boolean not null default false,
  winner_id uuid,
  question_order int[],
  created_at timestamptz not null default now()
);
create index on public.quiz_games (code, created_at desc);

create table public.quiz_players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.quiz_games(id) on delete cascade,
  name text not null,
  avatar text,
  out_stage int,
  created_at timestamptz not null default now()
);
create index on public.quiz_players (game_id);

create table public.quiz_answers (
  game_id uuid not null references public.quiz_games(id) on delete cascade,
  player_id uuid not null references public.quiz_players(id) on delete cascade,
  stage_no int not null,
  choice int not null,
  correct boolean not null,
  ms int not null,
  passed boolean,
  created_at timestamptz not null default clock_timestamp(),
  primary key (player_id, stage_no)
);
create index on public.quiz_answers (game_id, stage_no);

alter table public.quiz_questions enable row level security;
alter table public.quiz_games enable row level security;
alter table public.quiz_players enable row level security;
alter table public.quiz_answers enable row level security;

-- ---------- internal helpers ----------

-- 5..4..3..2..1..ПОЧАЛИ! = 6 seconds before the question appears
create function public.quiz_q_start(g public.quiz_games) returns timestamptz
language sql immutable set search_path = public as $$ select g.stage_started_at + interval '6 seconds' $$;

create function public.quiz_question_row(g public.quiz_games) returns public.quiz_questions
language sql stable security definer set search_path = public as $$
  select q.* from quiz_questions q
  where q.set_name = g.set_name
    and q.position = coalesce(
      g.question_order[((g.stage_no - 1) % array_length(g.question_order, 1)) + 1],
      (g.stage_no - 1) % greatest(1, (select count(*) from quiz_questions where set_name = g.set_name)))
$$;

-- How many players go through this stage. Always eliminates at least one; final (k = 1) leaves a single winner.
create function public.quiz_keep(g public.quiz_games, alive int) returns int
language sql immutable set search_path = public as $$
  select case when alive <= 2 then 1
              else least(alive - 1, greatest(1, ceil(alive * g.keep_ratio)::int)) end
$$;

-- Closes a stage once time is up or every alive player answered. Idempotent.
create function public.quiz_tick(p_game uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
declare g quiz_games; dl timestamptz; alive int; n int; last_at timestamptz; ncorrect int; k int; r_at timestamptz; win uuid;
begin
  select * into g from quiz_games where id = p_game;
  if g.id is null or g.status <> 'stage' or g.resolved_stage >= g.stage_no then return; end if;
  dl := quiz_q_start(g) + make_interval(secs => g.q_seconds);
  select count(*) into alive from quiz_players where game_id = g.id and out_stage is null;
  select count(*), max(a.created_at) into n, last_at
    from quiz_answers a join quiz_players p on p.id = a.player_id
    where a.game_id = g.id and a.stage_no = g.stage_no and p.out_stage is null;
  if clock_timestamp() < dl and (alive = 0 or n < alive) then return; end if;

  select * into g from quiz_games where id = p_game for update;
  if g.resolved_stage >= g.stage_no then return; end if;

  r_at := case when alive > 0 and n >= alive then least(last_at, dl) else least(clock_timestamp(), dl) end;
  select count(*) into ncorrect from quiz_answers a join quiz_players p on p.id = a.player_id
    where a.game_id = g.id and a.stage_no = g.stage_no and a.correct and p.out_stage is null;

  if ncorrect = 0 then
    -- Nobody got it right: everybody stays for another chance.
    update quiz_games set resolved_stage = g.stage_no, resolve_at = r_at, no_correct = true where id = g.id;
    return;
  end if;

  k := quiz_keep(g, alive);
  update quiz_answers a set passed = (r.rn <= k)
    from (select a2.player_id, row_number() over (order by a2.ms, a2.created_at) rn
          from quiz_answers a2 join quiz_players p on p.id = a2.player_id
          where a2.game_id = g.id and a2.stage_no = g.stage_no and a2.correct and p.out_stage is null) r
    where a.player_id = r.player_id and a.stage_no = g.stage_no;
  update quiz_answers set passed = false where game_id = g.id and stage_no = g.stage_no and not correct;
  update quiz_players p set out_stage = g.stage_no
    where p.game_id = g.id and p.out_stage is null
      and not exists (select 1 from quiz_answers a where a.player_id = p.id and a.stage_no = g.stage_no and a.passed);
  if (select count(*) from quiz_players where game_id = g.id and out_stage is null) = 1 then
    select id into win from quiz_players where game_id = g.id and out_stage is null;
  end if;
  update quiz_games set resolved_stage = g.stage_no, resolve_at = r_at, no_correct = false, winner_id = win
    where id = g.id;
end $$;

create function public.quiz_phase(g public.quiz_games, out phase text, out ms_left int)
language plpgsql stable set search_path = public as $$
declare t timestamptz := clock_timestamp(); qs timestamptz;
begin
  ms_left := 0;
  if g.status = 'lobby' then
    if t < g.lobby_ends_at then phase := 'lobby'; ms_left := ceil(extract(epoch from g.lobby_ends_at - t) * 1000);
    else phase := 'ready'; end if;
    return;
  end if;
  if g.status = 'finished' then phase := 'finished'; return; end if;
  qs := quiz_q_start(g);
  if t < qs then phase := 'countdown'; ms_left := ceil(extract(epoch from qs - t) * 1000); return; end if;
  if g.resolved_stage < g.stage_no then
    phase := 'question';
    ms_left := greatest(0, ceil(extract(epoch from qs + make_interval(secs => g.q_seconds) - t) * 1000));
    return;
  end if;
  if t < g.resolve_at + interval '3 seconds' then
    phase := 'reveal'; ms_left := ceil(extract(epoch from g.resolve_at + interval '3 seconds' - t) * 1000);
  else
    phase := 'result';
  end if;
end $$;

-- Everything the big screen may show.
create function public.quiz_public(g public.quiz_games) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare ph record; q quiz_questions; alive_now int; alive_start int; total int; answered int;
        lobby jsonb; result jsonb; winner jsonb; qjson jsonb;
begin
  ph := quiz_phase(g);
  select count(*) into total from quiz_players where game_id = g.id;
  select count(*) into alive_now from quiz_players where game_id = g.id and out_stage is null;
  select count(*) into alive_start from quiz_players
    where game_id = g.id and (out_stage is null or out_stage >= g.stage_no);
  select count(*) into answered from quiz_answers where game_id = g.id and stage_no = g.stage_no;

  if ph.phase in ('lobby','ready') then
    select coalesce(jsonb_agg(jsonb_build_object('name', name, 'avatar', avatar) order by created_at), '[]')
      into lobby from (select * from quiz_players where game_id = g.id order by created_at desc limit 120) p;
  end if;

  if ph.phase in ('question','reveal','result') then
    q := quiz_question_row(g);
    qjson := jsonb_build_object('emoji', q.emoji, 'question', q.question, 'options', q.options,
      'correct', case when ph.phase = 'result' then q.correct end);
  end if;

  if ph.phase = 'result' then
    select jsonb_build_object(
      'no_correct', g.no_correct,
      'passed', coalesce((select jsonb_agg(jsonb_build_object('name', p.name, 'avatar', p.avatar, 'ms', a.ms) order by a.ms)
                 from quiz_answers a join quiz_players p on p.id = a.player_id
                 where a.game_id = g.id and a.stage_no = g.stage_no and a.passed), '[]'),
      'out', (select count(*) from quiz_players where game_id = g.id and out_stage = g.stage_no),
      'correct_count', (select count(*) from quiz_answers where game_id = g.id and stage_no = g.stage_no and correct)
    ) into result;
  end if;

  if g.winner_id is not null and ph.phase in ('result','finished') then
    select jsonb_build_object('name', name, 'avatar', avatar) into winner from quiz_players where id = g.winner_id;
  end if;

  return jsonb_build_object(
    'phase', ph.phase, 'ms_left', ph.ms_left, 'code', g.code, 'q_seconds', g.q_seconds,
    'stage', g.stage_no, 'players', total, 'alive', case when ph.phase = 'result' then alive_now else alive_start end,
    'answered', answered, 'keep', case when g.status = 'stage' then quiz_keep(g, alive_start) end,
    'is_final', g.status = 'stage' and quiz_keep(g, alive_start) = 1,
    'question', qjson, 'result', result, 'winner', winner, 'lobby', lobby);
end $$;

-- ---------- public API ----------

create function public.quiz_create_game(p_minutes int default 10, p_ratio numeric default 0.5)
returns json language plpgsql volatile security definer set search_path = public as $$
declare g quiz_games; c text; tries int := 0;
begin
  loop
    c := lpad((floor(random() * 9000) + 1000)::int::text, 4, '0');
    exit when not exists (select 1 from quiz_games where code = c and created_at > now() - interval '2 days');
    tries := tries + 1;
    if tries > 60 then raise exception 'no free code'; end if;
  end loop;
  insert into quiz_games (code, lobby_ends_at, keep_ratio, question_order)
    values (c, clock_timestamp() + make_interval(mins => least(greatest(coalesce(p_minutes, 10), 0), 120)),
            least(greatest(coalesce(p_ratio, 0.5), 0.1), 0.9),
            (select array_agg(position order by random()) from quiz_questions where set_name = 'drones'))
    returning * into g;
  return json_build_object('game_id', g.id, 'code', g.code, 'secret', g.host_secret);
end $$;

create function public.quiz_join(p_code text, p_name text, p_avatar text)
returns json language plpgsql volatile security definer set search_path = public as $$
declare g quiz_games; pid uuid; nm text := left(btrim(coalesce(p_name, '')), 20);
begin
  if length(nm) < 1 then raise exception 'name required'; end if;
  select * into g from quiz_games where code = btrim(p_code) and created_at > now() - interval '2 days'
    order by created_at desc limit 1;
  if g.id is null then raise exception 'game not found'; end if;
  if g.status <> 'lobby' then raise exception 'game already started'; end if;
  if (select count(*) from quiz_players where game_id = g.id) >= 300 then raise exception 'game full'; end if;
  insert into quiz_players (game_id, name, avatar) values (g.id, nm, left(coalesce(p_avatar, '🚁'), 8))
    returning id into pid;
  return json_build_object('game_id', g.id, 'player_id', pid);
end $$;

create function public.quiz_player_state(p_game uuid, p_player uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare g quiz_games; p quiz_players; a quiz_answers; pub jsonb; ph record; res text;
begin
  perform quiz_tick(p_game);
  select * into g from quiz_games where id = p_game;
  if g.id is null then return jsonb_build_object('phase', 'gone'); end if;
  select * into p from quiz_players where id = p_player and game_id = p_game;
  if p.id is null then return jsonb_build_object('phase', 'kicked'); end if;
  pub := quiz_public(g);
  ph := quiz_phase(g);
  select * into a from quiz_answers where player_id = p_player and stage_no = g.stage_no;

  if ph.phase = 'result' then
    res := case
      when p.out_stage is not null and p.out_stage < g.stage_no then 'out'
      when g.no_correct then 'saved'
      when g.winner_id = p.id then 'winner'
      when p.out_stage is null then 'pass'
      when a.player_id is null then 'timeout'
      when not a.correct then 'wrong'
      else 'slow' end;
  end if;

  return pub || jsonb_build_object('me', jsonb_build_object(
    'name', p.name, 'avatar', p.avatar, 'out_stage', p.out_stage,
    'answered', a.player_id is not null,
    'ms', case when ph.phase = 'result' then a.ms end,
    'result', res));
end $$;

create function public.quiz_answer(p_game uuid, p_player uuid, p_choice int)
returns json language plpgsql volatile security definer set search_path = public as $$
declare g quiz_games; ph record; q quiz_questions; p quiz_players; elapsed int;
begin
  select * into g from quiz_games where id = p_game;
  if g.id is null then raise exception 'game not found'; end if;
  select * into p from quiz_players where id = p_player and game_id = p_game;
  if p.id is null or p.out_stage is not null then return json_build_object('accepted', false); end if;
  ph := quiz_phase(g);
  if ph.phase <> 'question' then return json_build_object('accepted', false); end if;
  q := quiz_question_row(g);
  if p_choice < 0 or p_choice >= jsonb_array_length(q.options) then raise exception 'bad choice'; end if;
  elapsed := greatest(0, floor(extract(epoch from clock_timestamp() - quiz_q_start(g)) * 1000))::int;
  insert into quiz_answers (game_id, player_id, stage_no, choice, correct, ms)
    values (p_game, p_player, g.stage_no, p_choice, p_choice = q.correct, elapsed)
    on conflict do nothing;
  perform quiz_tick(p_game);
  return json_build_object('accepted', true);
end $$;

create function public.quiz_screen_state(p_code text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare g quiz_games;
begin
  select * into g from quiz_games where code = btrim(p_code) and created_at > now() - interval '2 days'
    order by created_at desc limit 1;
  if g.id is null then return jsonb_build_object('phase', 'gone'); end if;
  perform quiz_tick(g.id);
  select * into g from quiz_games where id = g.id;
  return quiz_public(g);
end $$;

-- ---------- host API (needs the secret returned by quiz_create_game) ----------

create function public.quiz_host_check(p_game uuid, p_secret uuid) returns public.quiz_games
language plpgsql stable security definer set search_path = public as $$
declare g quiz_games;
begin
  select * into g from quiz_games where id = p_game and host_secret = p_secret;
  if g.id is null then raise exception 'not host'; end if;
  return g;
end $$;

create function public.quiz_host_state(p_game uuid, p_secret uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare g quiz_games; q quiz_questions;
begin
  perform quiz_host_check(p_game, p_secret);
  perform quiz_tick(p_game);
  select * into g from quiz_games where id = p_game;
  q := quiz_question_row(g);
  return quiz_public(g) || jsonb_build_object(
    'keep_ratio', g.keep_ratio,
    'host_question', case when g.status = 'stage' then jsonb_build_object(
        'emoji', q.emoji, 'question', q.question, 'options', q.options, 'correct', q.correct) end,
    'roster', coalesce((select jsonb_agg(jsonb_build_object(
        'id', p.id, 'name', p.name, 'avatar', p.avatar, 'out_stage', p.out_stage,
        'answered', exists (select 1 from quiz_answers a where a.player_id = p.id and a.stage_no = g.stage_no))
        order by p.out_stage nulls first, p.created_at)
      from quiz_players p where p.game_id = g.id), '[]'));
end $$;

create function public.quiz_host_lobby_time(p_game uuid, p_secret uuid, p_seconds int)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  perform quiz_host_check(p_game, p_secret);
  update quiz_games set lobby_ends_at = clock_timestamp() + make_interval(secs => least(greatest(p_seconds, 0), 7200))
    where id = p_game and status = 'lobby';
  return quiz_host_state(p_game, p_secret);
end $$;

create function public.quiz_host_start(p_game uuid, p_secret uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  perform quiz_host_check(p_game, p_secret);
  update quiz_games set status = 'stage', stage_no = 1, stage_started_at = clock_timestamp(),
      lobby_ends_at = least(lobby_ends_at, clock_timestamp())
    where id = p_game and status = 'lobby'
      and exists (select 1 from quiz_players where game_id = p_game);
  return quiz_host_state(p_game, p_secret);
end $$;

create function public.quiz_host_next(p_game uuid, p_secret uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare g quiz_games; ph record;
begin
  g := quiz_host_check(p_game, p_secret);
  perform quiz_tick(p_game);
  select * into g from quiz_games where id = p_game;
  ph := quiz_phase(g);
  if ph.phase = 'result' then
    if g.winner_id is not null or not exists (select 1 from quiz_players where game_id = g.id and out_stage is null) then
      update quiz_games set status = 'finished' where id = p_game;
    else
      update quiz_games set stage_no = g.stage_no + 1, stage_started_at = clock_timestamp(), no_correct = false
        where id = p_game;
    end if;
  end if;
  return quiz_host_state(p_game, p_secret);
end $$;

create function public.quiz_host_skip(p_game uuid, p_secret uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare g quiz_games;
begin
  g := quiz_host_check(p_game, p_secret);
  update quiz_games set stage_started_at = clock_timestamp() - interval '6 seconds' - make_interval(secs => q_seconds)
    where id = p_game and status = 'stage' and resolved_stage < stage_no
      and clock_timestamp() >= stage_started_at + interval '6 seconds';
  return quiz_host_state(p_game, p_secret);
end $$;

create function public.quiz_host_kick(p_game uuid, p_secret uuid, p_player uuid)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
begin
  perform quiz_host_check(p_game, p_secret);
  delete from quiz_players where id = p_player and game_id = p_game;
  return quiz_host_state(p_game, p_secret);
end $$;

-- ---------- permissions ----------
do $$ declare r record; begin
  for r in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'quiz\_%' loop
    execute 'revoke all on function ' || r.sig || ' from public, anon, authenticated';
  end loop;
end $$;
grant execute on function
  public.quiz_create_game(int, numeric), public.quiz_join(text, text, text),
  public.quiz_player_state(uuid, uuid), public.quiz_answer(uuid, uuid, int), public.quiz_screen_state(text),
  public.quiz_host_state(uuid, uuid), public.quiz_host_lobby_time(uuid, uuid, int), public.quiz_host_start(uuid, uuid),
  public.quiz_host_next(uuid, uuid), public.quiz_host_skip(uuid, uuid), public.quiz_host_kick(uuid, uuid, uuid)
  to anon, authenticated;

-- Questions for the "drones" set. correct = index of the right option (0..3).
delete from public.quiz_questions where set_name = 'drones';
insert into public.quiz_questions (set_name, position, emoji, question, options, correct) values
('drones', 0,  '🚁', 'Що таке дрон?',
  '["Підводний човен","Літальний апарат без пілота на борту","Швидкий велосипед","Великий птах"]', 1),
('drones', 1,  '🔢', 'Скільки гвинтів у квадрокоптера?',
  '["2","6","4","1"]', 2),
('drones', 2,  '🥽', 'Що бачить пілот FPV-дрона у своїх окулярах?',
  '["Мультики","Те, що бачить камера дрона","Прогноз погоди","Нічого не бачить"]', 1),
('drones', 3,  '🇺🇦', 'Яке місто — столиця України?',
  '["Львів","Одеса","Харків","Київ"]', 3),
('drones', 4,  '🔥', 'Дрон Matrice 4T має тепловізор. Що він бачить?',
  '["Тепло","Звуки","Запахи","Думки"]', 0),
('drones', 5,  '🎨', 'Якого кольору прапор України?',
  '["Червоний і білий","Синій і жовтий","Зелений і синій","Жовтий і червоний"]', 1),
('drones', 6,  '🔋', 'Звідки дрон бере енергію для польоту?',
  '["З акумулятора","З бензину","З дров","З води"]', 0),
('drones', 7,  '🔱', 'Як називається герб України?',
  '["Сокира","Корона","Тризуб","Зірка"]', 2),
('drones', 8,  '👨‍✈️', 'Як називають людину, яка керує дроном?',
  '["Капітан","Машиніст","Кухар","Оператор, або пілот"]', 3),
('drones', 9,  '🏠', 'Що зробить розумний дрон, коли сідає батарея?',
  '["Засне в повітрі","Повернеться додому","Полетить на Місяць","Почне співати"]', 1),
('drones', 10, '🎂', 'Коли ми святкуємо День Незалежності України?',
  '["24 серпня","1 січня","8 березня","25 грудня"]', 0),
('drones', 11, '🌊', 'Яка найдовша річка, що тече через Україну від півночі до півдня?',
  '["Десна","Дніпро","Рось","Сейм"]', 1),
('drones', 12, '🎮', 'Чим пілот керує дроном?',
  '["Кермом","Пультом керування","Педалями","Ложкою"]', 1),
('drones', 13, '🌧️', 'У яку погоду дрону краще НЕ літати?',
  '["Коли тепло","Коли сонячно й тихо","Коли світло","У сильний вітер і зливу"]', 3),
('drones', 14, '📷', 'Навіщо дрону камера?',
  '["Варити суп","Співати пісні","Знімати фото й відео згори","Рахувати зірки"]', 2),
('drones', 15, '🔄', 'Що крутиться в дрона, щоб він летів?',
  '["Колеса","Хвіст","Крила, як у птаха","Пропелери (гвинти)"]', 3),
('drones', 16, '🛰️', 'Що допомагає дрону знати, де він знаходиться?',
  '["Супутники GPS","Ліхтарик","Парасолька","Дзвоник"]', 0),
('drones', 17, '🚒', 'Як дрон з тепловізором допомагає рятувальникам?',
  '["Шукає людей уночі за їхнім теплом","Пече пиріжки","Грає музику","Миє вікна"]', 0),
('drones', 18, '🦺', 'Де мають стояти глядачі, коли злітає дрон?',
  '["Під дроном","На безпечній відстані від дрона","Ловити дрон руками","На злітному майданчику"]', 1),
('drones', 19, '🔦', 'Що допомагає дрону бути помітним уночі?',
  '["Фарба","Наклейки","Вогники-ліхтарики","Пір''я"]', 2),
('drones', 20, '🐝', 'Чому дрон дзижчить, як бджола?',
  '["Бо в ньому живуть бджоли","Бо швидко крутяться гвинти","Бо він співає","Бо він сердиться"]', 1),
('drones', 21, '🛬', 'Що робить пілот наприкінці польоту?',
  '["Кидає пульт","Обережно саджає дрон","Залишає дрон у небі","Йде додому"]', 1);
