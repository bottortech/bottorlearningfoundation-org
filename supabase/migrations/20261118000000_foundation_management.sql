-- ============================================================
-- Bottor Learning Foundation — Foundation Management Portal
-- Migration 002 (2026-11-18)
--
-- Adds per-person permission overrides plus the tables for donations,
-- inventory, event impact counts, impact goals/publications, and donor
-- acknowledgments. EXISTING TABLES AND RECORDS ARE NOT CHANGED.
--
-- Same security model as migration 001: Row-Level Security on, no
-- policies, all privileges revoked from anon/authenticated. Only the
-- server (service-role key) reads or writes these tables.
-- ============================================================

-- ---------- Per-person permission overrides ----------
-- Role defaults live in api/_lib/permissions.js. A row here grants or
-- revokes ONE permission for ONE staff member. Only an administrator
-- with permissions.manage can change these (enforced by the API).
create table public.staff_permission_grants (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff_users (id) on delete cascade,
  permission text not null check (char_length(permission) <= 64),
  effect text not null check (effect in ('grant', 'revoke')),
  granted_by uuid references public.staff_users (id) on delete set null,
  granted_at timestamptz not null default now(),
  unique (staff_id, permission)
);

-- ---------- Donors ----------
create table public.donors (
  id uuid primary key default gen_random_uuid(),
  donor_type text not null default 'individual' check (donor_type in ('individual', 'organization')),
  name text not null check (char_length(name) between 1 and 160),
  contact_name text check (char_length(contact_name) <= 120),
  email text check (char_length(email) <= 254),
  phone text check (char_length(phone) <= 30),
  address_line1 text check (char_length(address_line1) <= 160),
  address_line2 text check (char_length(address_line2) <= 160),
  city text check (char_length(city) <= 80),
  state text check (char_length(state) <= 40),
  postal_code text check (char_length(postal_code) <= 20),
  notes text check (char_length(notes) <= 2000),
  created_by uuid references public.staff_users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index donors_name_idx on public.donors (lower(name));

-- ---------- Donations ----------
create table public.donations (
  id uuid primary key default gen_random_uuid(),
  -- Null donor_id is allowed for anonymous gifts with no donor record.
  donor_id uuid references public.donors (id) on delete restrict,
  is_anonymous boolean not null default false,   -- never shown publicly by name
  received_on date not null,
  donation_type text not null check (donation_type in ('monetary', 'in_kind')),
  amount numeric(12, 2) check (amount > 0),       -- monetary gifts only
  payment_method text check (payment_method in ('cash', 'check', 'card', 'givebutter', 'bank_transfer', 'other')),
  restriction text not null default 'unrestricted' check (restriction in ('unrestricted', 'restricted')),
  restriction_purpose text check (char_length(restriction_purpose) <= 500),
  description text check (char_length(description) <= 1000),
  -- Internal estimate for in-kind gifts. Never printed on donor letters.
  estimated_value numeric(12, 2) check (estimated_value >= 0),
  notes text check (char_length(notes) <= 2000),
  is_historical boolean not null default false,  -- entered after the fact
  request_id uuid unique,                         -- blocks double-submitted forms
  status text not null default 'active' check (status in ('active', 'void')),
  void_reason text check (char_length(void_reason) <= 1000),
  created_by uuid references public.staff_users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint monetary_needs_amount check (donation_type <> 'monetary' or amount is not null),
  constraint in_kind_has_no_amount check (donation_type <> 'in_kind' or amount is null),
  constraint restricted_needs_purpose check (restriction <> 'restricted' or restriction_purpose is not null),
  constraint donor_or_anonymous check (donor_id is not null or is_anonymous)
);

create index donations_received_idx on public.donations (received_on);
create index donations_donor_idx on public.donations (donor_id);

create table public.donation_documents (
  id uuid primary key default gen_random_uuid(),
  donation_id uuid not null references public.donations (id) on delete cascade,
  storage_path text not null unique,              -- private Supabase Storage bucket
  file_name text not null check (char_length(file_name) <= 200),
  content_type text not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  uploaded_by uuid references public.staff_users (id) on delete set null,
  uploaded_at timestamptz not null default now()
);

-- ---------- Inventory ----------
create table public.inventory_categories (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z_]+$'),
  name text not null,
  sort_order integer not null default 0,
  active boolean not null default true
);

insert into public.inventory_categories (slug, name, sort_order) values
  ('books', 'Books', 1),
  ('clothing', 'Clothing', 2),
  ('electronics', 'Electronics & technology', 3),
  ('educational_supplies', 'Educational supplies', 4),
  ('other', 'Other donated items', 5);

create table public.donation_items (
  id uuid primary key default gen_random_uuid(),
  donation_id uuid not null references public.donations (id) on delete cascade,
  category_id uuid not null references public.inventory_categories (id) on delete restrict,
  description text not null check (char_length(description) between 1 and 300),
  quantity integer not null check (quantity > 0),
  estimated_value numeric(12, 2) check (estimated_value >= 0)
);

-- Events the foundation hosted, attended, or exhibited at (for distributions
-- and impact counts). public_event_id links to an entry in events-data.js.
create table public.program_events (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  event_date date not null,
  participation text not null check (participation in ('hosted', 'exhibited', 'attended', 'partnered')),
  location text check (char_length(location) <= 300),
  public_event_id text check (char_length(public_event_id) <= 120),
  notes text check (char_length(notes) <= 2000),
  created_by uuid references public.staff_users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (name, event_date)
);

-- The inventory ledger. Stock on hand = sum(quantity) per category.
-- Positive = in (opening balance, received); negative = out (distributed);
-- adjustments may be either and always need a documented reason.
create table public.inventory_transactions (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.inventory_categories (id) on delete restrict,
  txn_type text not null check (txn_type in ('opening_balance', 'received', 'distributed', 'adjustment')),
  quantity integer not null check (quantity <> 0),
  occurred_on date not null,
  donation_item_id uuid unique references public.donation_items (id) on delete restrict,
  event_id uuid references public.program_events (id) on delete restrict,
  reason text check (char_length(reason) <= 1000),
  notes text check (char_length(notes) <= 1000),
  is_historical boolean not null default false,
  request_id uuid unique,
  created_by uuid references public.staff_users (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint direction_matches_type check (
    (txn_type in ('opening_balance', 'received') and quantity > 0)
    or (txn_type = 'distributed' and quantity < 0)
    or txn_type = 'adjustment'
  ),
  constraint adjustment_needs_reason check (txn_type <> 'adjustment' or reason is not null),
  constraint received_links_item check (txn_type <> 'received' or donation_item_id is not null)
);

create index inventory_txn_category_idx on public.inventory_transactions (category_id, occurred_on);
create index inventory_txn_event_idx on public.inventory_transactions (event_id);

-- One opening balance per category.
create unique index inventory_one_opening_balance
  on public.inventory_transactions (category_id) where txn_type = 'opening_balance';

-- Stock can never go below zero (also checked in the API with a clear message).
create function public.inventory_never_negative() returns trigger
language plpgsql as $$
declare on_hand bigint;
begin
  select coalesce(sum(quantity), 0) into on_hand
  from public.inventory_transactions where category_id = new.category_id;
  if on_hand < 0 then
    raise exception 'Inventory for this category cannot go below zero' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger inventory_transactions_never_negative
  after insert or update on public.inventory_transactions
  for each row execute function public.inventory_never_negative();

-- ---------- Event impact counts ----------
create table public.event_impact_counts (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.program_events (id) on delete cascade,
  metric text not null check (metric in (
    'attendance', 'children_served', 'families_served', 'game_participants',
    'books_distributed', 'clothing_distributed', 'other_items_distributed'
  )),
  value integer not null check (value >= 0),
  -- exact | approximate ("about") | estimated | minimum ("200+")
  qualifier text not null default 'exact' check (qualifier in ('exact', 'approximate', 'estimated', 'minimum')),
  notes text check (char_length(notes) <= 1000),
  recorded_by uuid references public.staff_users (id) on delete set null,
  recorded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, metric)
);

-- Totals already published on the website before this system existed.
-- Reports add only events dated AFTER as_of, so nothing is counted twice.
create table public.impact_baselines (
  id uuid primary key default gen_random_uuid(),
  metric text not null unique,
  value integer not null check (value >= 0),
  qualifier text not null default 'exact' check (qualifier in ('exact', 'approximate', 'estimated', 'minimum')),
  as_of date not null,
  notes text check (char_length(notes) <= 1000),
  recorded_by uuid references public.staff_users (id) on delete set null,
  recorded_at timestamptz not null default now()
);

create table public.impact_goals (
  id uuid primary key default gen_random_uuid(),
  goal_year integer not null check (goal_year between 2020 and 2100),
  metric text not null check (char_length(metric) <= 64),
  target integer not null check (target > 0),
  notes text check (char_length(notes) <= 500),
  set_by uuid references public.staff_users (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (goal_year, metric)
);

-- Admin-approved figures for the public website. Aggregates only — no donor data.
create table public.impact_publications (
  id uuid primary key default gen_random_uuid(),
  figures jsonb not null,
  as_of date not null,
  status text not null default 'published' check (status in ('published', 'superseded')),
  approved_by uuid references public.staff_users (id) on delete set null,
  approved_at timestamptz not null default now()
);

-- At most one row can be 'published' at a time.
create unique index impact_one_published on public.impact_publications (status) where status = 'published';

-- ---------- Donor acknowledgments ----------
create table public.donor_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  donation_id uuid not null references public.donations (id) on delete restrict,
  letter_number text not null unique,
  status text not null default 'draft' check (status in ('draft', 'ready', 'sent', 'void')),
  content jsonb not null,                         -- snapshot of the letter as generated
  generated_by uuid references public.staff_users (id) on delete set null,
  generated_at timestamptz not null default now(),
  sent_on date,
  sent_method text check (sent_method in ('mail', 'email', 'in_person', 'other')),
  sent_recorded_by uuid references public.staff_users (id) on delete set null,
  void_reason text check (char_length(void_reason) <= 1000),
  notes text check (char_length(notes) <= 1000),
  constraint sent_needs_details check (status <> 'sent' or (sent_on is not null and sent_method is not null))
);

create index donor_ack_donation_idx on public.donor_acknowledgments (donation_id);
-- Only one live (non-void) acknowledgment per donation.
create unique index donor_ack_one_live on public.donor_acknowledgments (donation_id) where status <> 'void';

-- ---------- Lock everything down ----------
do $$
declare t text;
begin
  foreach t in array array[
    'staff_permission_grants', 'donors', 'donations', 'donation_documents',
    'inventory_categories', 'donation_items', 'program_events', 'inventory_transactions',
    'event_impact_counts', 'impact_baselines', 'impact_goals', 'impact_publications',
    'donor_acknowledgments'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end;
$$;

revoke execute on function public.inventory_never_negative() from anon, authenticated;

-- Make the new tables visible to the API immediately.
notify pgrst, 'reload schema';
