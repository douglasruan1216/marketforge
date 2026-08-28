-- MarketForge — Supabase schema
-- Run this whole file once in: Supabase Dashboard -> SQL Editor -> New query
-- Safe to re-run (uses IF NOT EXISTS / OR REPLACE / DROP ... IF EXISTS throughout).

-- ============================================================
-- TABLES
-- ============================================================

create table if not exists mf_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  cash numeric not null default 10000,
  created_at timestamptz not null default now()
);

create table if not exists mf_stocks (
  symbol text primary key,
  name text not null,
  sector text not null default 'Other',
  reserve_cash numeric not null,
  reserve_shares numeric not null,
  founder_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists mf_price_history (
  id bigint generated always as identity primary key,
  symbol text not null references mf_stocks(symbol) on delete cascade,
  price numeric not null,
  at timestamptz not null default now()
);
create index if not exists mf_price_history_symbol_idx on mf_price_history(symbol, at desc);

create table if not exists mf_holdings (
  user_id uuid not null references auth.users(id) on delete cascade,
  symbol text not null references mf_stocks(symbol) on delete cascade,
  shares numeric not null default 0,
  primary key (user_id, symbol)
);

create table if not exists mf_activity (
  id bigint generated always as identity primary key,
  kind text not null,
  text text not null,
  symbol text,
  at timestamptz not null default now()
);
create index if not exists mf_activity_at_idx on mf_activity(at desc);

-- ============================================================
-- ROW LEVEL SECURITY — clients can never write these tables directly.
-- All mutation happens through the SECURITY DEFINER functions below,
-- which validate everything server-side (same as the old Python server did).
-- ============================================================

alter table mf_profiles enable row level security;
alter table mf_stocks enable row level security;
alter table mf_price_history enable row level security;
alter table mf_holdings enable row level security;
alter table mf_activity enable row level security;

drop policy if exists mf_profiles_select on mf_profiles;
create policy mf_profiles_select on mf_profiles for select using (auth.role() = 'authenticated');

drop policy if exists mf_stocks_select on mf_stocks;
create policy mf_stocks_select on mf_stocks for select using (auth.role() = 'authenticated');

drop policy if exists mf_price_history_select on mf_price_history;
create policy mf_price_history_select on mf_price_history for select using (auth.role() = 'authenticated');

drop policy if exists mf_holdings_select on mf_holdings;
create policy mf_holdings_select on mf_holdings for select using (auth.role() = 'authenticated');

drop policy if exists mf_activity_select on mf_activity;
create policy mf_activity_select on mf_activity for select using (auth.role() = 'authenticated');

-- (No insert/update/delete policies exist for any role above, so direct
-- client writes are always denied. The functions below are SECURITY
-- DEFINER, so they run with the table owner's privileges and bypass RLS —
-- that's the ONLY path to mutating data.)

-- ============================================================
-- Auto-create a profile (10,000 starting cash) whenever someone signs up
-- ============================================================

create or replace function mf_handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into mf_profiles (user_id, display_name, cash)
  values (new.id, split_part(new.email, '@', 1), 10000)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists mf_on_auth_user_created on auth.users;
create trigger mf_on_auth_user_created
  after insert on auth.users
  for each row execute function mf_handle_new_user();

-- ============================================================
-- Helper: trim price history to the last 240 points per stock
-- ============================================================

create or replace function mf_trim_history(p_symbol text)
returns void
language sql
security definer
set search_path = public
as $$
  delete from mf_price_history
  where symbol = p_symbol
    and id not in (
      select id from mf_price_history where symbol = p_symbol order by at desc limit 240
    );
$$;

-- ============================================================
-- mf_create_stock — IPO a new stock at exactly $1.00/share
-- ============================================================

create or replace function mf_create_stock(p_name text, p_symbol text, p_sector text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_symbol text := upper(trim(p_symbol));
  v_name text := left(coalesce(nullif(trim(p_name), ''), v_symbol), 40);
  v_sector text := left(coalesce(nullif(trim(p_sector), ''), 'Other'), 20);
  v_uid uuid := auth.uid();
  v_cash numeric;
  v_display text;
  v_listing_fee constant numeric := 500;
  v_ipo_price constant numeric := 1;
  v_depth constant numeric := 2000;
  v_founder_bonus constant numeric := 50;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if v_symbol !~ '^[A-Z]{1,5}$' then raise exception 'Symbol must be 1-5 letters'; end if;
  if exists (select 1 from mf_stocks where symbol = v_symbol) then
    raise exception 'That symbol is already listed';
  end if;

  select cash, display_name into v_cash, v_display from mf_profiles where user_id = v_uid for update;
  if v_cash is null then raise exception 'not_authenticated'; end if;
  if v_cash < v_listing_fee then
    raise exception 'Need $% to pay the IPO listing fee', to_char(v_listing_fee, 'FM999999990');
  end if;

  update mf_profiles set cash = cash - v_listing_fee where user_id = v_uid;

  insert into mf_stocks (symbol, name, sector, reserve_cash, reserve_shares, founder_id)
  values (v_symbol, v_name, v_sector, v_ipo_price * v_depth, v_depth, v_uid);

  insert into mf_price_history (symbol, price) values (v_symbol, v_ipo_price);

  insert into mf_holdings (user_id, symbol, shares) values (v_uid, v_symbol, v_founder_bonus)
    on conflict (user_id, symbol) do update set shares = mf_holdings.shares + v_founder_bonus;

  insert into mf_activity (kind, text, symbol)
  values ('ipo', v_display || ' launched ' || v_name || ' (' || v_symbol || ') at $1.00/share', v_symbol);

  return json_build_object('ok', true, 'symbol', v_symbol);
end;
$$;

-- ============================================================
-- mf_buy — constant-product AMM swap: cash in, shares out
-- ============================================================

create or replace function mf_buy(p_symbol text, p_cash_amount numeric)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_symbol text := upper(trim(p_symbol));
  v_uid uuid := auth.uid();
  v_fee constant numeric := 0.0025;
  v_cash numeric;
  v_display text;
  v_rc numeric; v_rs numeric;
  v_net_in numeric;
  v_shares_out numeric;
  v_new_price numeric;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if p_cash_amount is null or p_cash_amount <= 0 then raise exception 'Amount must be positive'; end if;

  select reserve_cash, reserve_shares into v_rc, v_rs from mf_stocks where symbol = v_symbol for update;
  if v_rc is null then raise exception 'Unknown symbol'; end if;

  select cash, display_name into v_cash, v_display from mf_profiles where user_id = v_uid for update;
  if v_cash is null then raise exception 'not_authenticated'; end if;
  if p_cash_amount > v_cash + 0.000001 then raise exception 'Not enough cash'; end if;

  v_net_in := p_cash_amount * (1 - v_fee);
  v_shares_out := v_rs - (v_rc * v_rs) / (v_rc + v_net_in);
  if v_shares_out <= 0 or v_shares_out >= v_rs * 0.98 then
    raise exception 'Order too large for this stock''s liquidity';
  end if;

  v_new_price := (v_rc + p_cash_amount) / (v_rs - v_shares_out);

  update mf_stocks set reserve_cash = v_rc + p_cash_amount, reserve_shares = v_rs - v_shares_out
    where symbol = v_symbol;
  update mf_profiles set cash = cash - p_cash_amount where user_id = v_uid;
  insert into mf_holdings (user_id, symbol, shares) values (v_uid, v_symbol, v_shares_out)
    on conflict (user_id, symbol) do update set shares = mf_holdings.shares + v_shares_out;

  insert into mf_price_history (symbol, price) values (v_symbol, v_new_price);
  perform mf_trim_history(v_symbol);

  insert into mf_activity (kind, text, symbol)
  values ('buy', v_display || ' bought ' || to_char(v_shares_out, 'FM999999990.000') || ' ' || v_symbol
                 || ' for $' || to_char(p_cash_amount, 'FM999999990.00'), v_symbol);

  return json_build_object('ok', true, 'shares_out', v_shares_out);
end;
$$;

-- ============================================================
-- mf_sell — constant-product AMM swap: shares in, cash out
-- ============================================================

create or replace function mf_sell(p_symbol text, p_shares_amount numeric)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_symbol text := upper(trim(p_symbol));
  v_uid uuid := auth.uid();
  v_fee constant numeric := 0.0025;
  v_have numeric;
  v_display text;
  v_rc numeric; v_rs numeric;
  v_net_in numeric;
  v_cash_out numeric;
  v_new_price numeric;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;
  if p_shares_amount is null or p_shares_amount <= 0 then raise exception 'Amount must be positive'; end if;

  select reserve_cash, reserve_shares into v_rc, v_rs from mf_stocks where symbol = v_symbol for update;
  if v_rc is null then raise exception 'Unknown symbol'; end if;

  select shares into v_have from mf_holdings where user_id = v_uid and symbol = v_symbol for update;
  v_have := coalesce(v_have, 0);
  if p_shares_amount > v_have + 0.000000001 then raise exception 'Not enough shares'; end if;

  v_net_in := p_shares_amount * (1 - v_fee);
  v_cash_out := v_rc - (v_rc * v_rs) / (v_rs + v_net_in);
  if v_cash_out <= 0 or v_cash_out >= v_rc * 0.98 then
    raise exception 'Order too large for this stock''s liquidity';
  end if;

  v_new_price := (v_rc - v_cash_out) / (v_rs + p_shares_amount);

  update mf_stocks set reserve_shares = v_rs + p_shares_amount, reserve_cash = v_rc - v_cash_out
    where symbol = v_symbol;

  update mf_holdings set shares = shares - p_shares_amount where user_id = v_uid and symbol = v_symbol;
  delete from mf_holdings where user_id = v_uid and symbol = v_symbol and shares <= 0.000000001;

  update mf_profiles set cash = cash + v_cash_out where user_id = v_uid
    returning display_name into v_display;

  insert into mf_price_history (symbol, price) values (v_symbol, v_new_price);
  perform mf_trim_history(v_symbol);

  insert into mf_activity (kind, text, symbol)
  values ('sell', v_display || ' sold ' || to_char(p_shares_amount, 'FM999999990.000') || ' ' || v_symbol
                  || ' for $' || to_char(v_cash_out, 'FM999999990.00'), v_symbol);

  return json_build_object('ok', true, 'cash_out', v_cash_out);
end;
$$;

-- ============================================================
-- mf_get_state — everything the client needs in one call
-- (mirrors what the old Python server's /api/state returned)
-- ============================================================

create or replace function mf_get_state()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile record;
  v_stocks json;
  v_portfolio json;
  v_activity json;
  v_richest json;
  v_priciest json;
  v_networth numeric;
begin
  if v_uid is null then raise exception 'not_authenticated'; end if;

  select * into v_profile from mf_profiles where user_id = v_uid;
  if v_profile is null then raise exception 'not_authenticated'; end if;

  select coalesce(json_agg(row_to_json(t)), '[]'::json) into v_stocks
  from (
    select
      s.symbol, s.name, s.sector,
      (s.reserve_cash / s.reserve_shares) as price,
      (s.founder_id = v_uid) as founder,
      coalesce((
        select json_agg(hh.price order by hh.at)
        from (select price, at from mf_price_history where symbol = s.symbol order by at desc limit 60) hh
      ), '[]'::json) as history
    from mf_stocks s
    order by s.symbol
  ) t;

  select coalesce(json_agg(row_to_json(t)), '[]'::json) into v_portfolio
  from (
    select h.symbol, s.name, h.shares, (s.reserve_cash / s.reserve_shares) as price,
           h.shares * (s.reserve_cash / s.reserve_shares) as value
    from mf_holdings h join mf_stocks s on s.symbol = h.symbol
    where h.user_id = v_uid and h.shares > 0.000001
    order by value desc
  ) t;

  select coalesce(json_agg(row_to_json(act)), '[]'::json) into v_activity
  from (select kind, text, symbol, extract(epoch from at) as t from mf_activity order by at desc limit 40) act;

  select coalesce(json_agg(row_to_json(t)), '[]'::json) into v_richest
  from (
    select p.display_name,
      p.cash + coalesce((
        select sum(h.shares * (s.reserve_cash / s.reserve_shares))
        from mf_holdings h join mf_stocks s on s.symbol = h.symbol
        where h.user_id = p.user_id
      ), 0) as net_worth
    from mf_profiles p
    order by net_worth desc
    limit 10
  ) t;

  select coalesce(json_agg(row_to_json(t)), '[]'::json) into v_priciest
  from (select symbol, name, (reserve_cash / reserve_shares) as price from mf_stocks order by price desc limit 10) t;

  select v_profile.cash + coalesce((
    select sum(h.shares * (s.reserve_cash / s.reserve_shares))
    from mf_holdings h join mf_stocks s on s.symbol = h.symbol
    where h.user_id = v_uid
  ), 0) into v_networth;

  return json_build_object(
    'username', v_profile.display_name,
    'cash', v_profile.cash,
    'net_worth', v_networth,
    'starting_cash', 10000,
    'listing_fee', 500,
    'founder_bonus', 50,
    'trade_tax_pct', 0.25,
    'stocks', v_stocks,
    'portfolio', v_portfolio,
    'activity', v_activity,
    'leaderboard', json_build_object('richest', v_richest, 'priciest', v_priciest)
  );
end;
$$;

grant execute on function mf_get_state() to authenticated;
grant execute on function mf_buy(text, numeric) to authenticated;
grant execute on function mf_sell(text, numeric) to authenticated;
grant execute on function mf_create_stock(text, text, text) to authenticated;
