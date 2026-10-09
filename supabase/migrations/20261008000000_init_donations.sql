-- Donation leaderboard: initial schema
--
-- Applied with `supabase db push` (see README). Creates the donations table, the
-- leaderboard ranking function, Row Level Security policies, explicit grants, and
-- enables Realtime on the table.

-- ── Table ─────────────────────────────────────────────────────────────────────
-- One row per payment event: each one-time gift and each recurring billing cycle.

create table public.donations (
  id                       uuid        primary key default gen_random_uuid(),
  stripe_payment_intent_id text        unique not null,
  stripe_subscription_id   text,                  -- non-null for recurring; groups billing cycles
  name                     text        not null,  -- always set; generated for anonymous donors
  original_amount          numeric     not null,  -- what the donor paid, in their currency
  original_currency        text        not null default 'usd',
  amount_usd               numeric     not null,  -- USD equivalent at time of payment
  created_at               timestamptz default now()
);

-- ── Leaderboard ranking function ──────────────────────────────────────────────
-- The leaderboard widget calls this instead of querying the table directly.
-- One-time gifts are individual entries; recurring gifts are summed per subscription.
-- Ordering is by USD total; the original currency is returned for display.

create or replace function public.leaderboard_rankings(
  cutoff_ts  timestamptz,   -- pass null for all-time
  row_limit  int default 10
)
returns table(
  display_name      text,
  total_usd         numeric,
  total_original    numeric,
  original_currency text
)
language sql stable
set search_path = public, pg_temp
as $$
  select display_name, total_usd, total_original, original_currency
  from (
    -- One-time donations: each payment is its own entry
    select
      name              as display_name,
      amount_usd        as total_usd,
      original_amount   as total_original,
      original_currency
    from donations
    where stripe_subscription_id is null
      and (cutoff_ts is null or created_at >= cutoff_ts)

    union all

    -- Recurring donations: summed per subscription
    -- (currency is fixed per subscription, so summing original_amount is safe)
    select
      (array_agg(name order by created_at desc))[1],
      sum(amount_usd),
      sum(original_amount),
      (array_agg(original_currency order by created_at desc))[1]
    from donations
    where stripe_subscription_id is not null
      and (cutoff_ts is null or created_at >= cutoff_ts)
    group by stripe_subscription_id
  ) combined
  order by total_usd desc
  limit row_limit;
$$;

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Anyone can read (the leaderboard is public). Nobody can write from the browser:
-- there are no insert/update/delete policies, so those are denied by default.
-- The service role (used only inside Edge Functions) bypasses RLS.

alter table public.donations enable row level security;

create policy "Public read"
  on public.donations for select
  using (true);

-- ── Grants ────────────────────────────────────────────────────────────────────
-- Stated explicitly so this works even if your project doesn't automatically expose
-- new tables to the API.

grant select on public.donations to anon;
grant select, insert, update, delete on public.donations to service_role;

grant execute on function public.leaderboard_rankings(timestamptz, int) to anon;

-- ── Realtime ──────────────────────────────────────────────────────────────────
-- Lets the widgets receive a push whenever a donation row changes.

alter publication supabase_realtime add table public.donations;
