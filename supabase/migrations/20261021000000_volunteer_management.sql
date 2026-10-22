-- ============================================================
-- Bottor Learning Foundation — Volunteer Management System
-- Migration 001 (2026-10-21)
--
-- Security model:
--   * Row-Level Security is ENABLED on every table with NO policies,
--     and all privileges are revoked from the anon/authenticated roles.
--     The browser can never read or write these tables directly.
--   * Only the Vercel serverless functions (using the service-role key,
--     stored as a server-side environment variable) access this data,
--     after checking the staff member's role.
--   * Background-check REPORTS are never stored here — only status,
--     dates, and an external vendor reference number.
-- ============================================================

create extension if not exists btree_gist;

-- ---------- Volunteers (application + volunteer record) ----------
create table public.volunteers (
  id uuid primary key default gen_random_uuid(),
  track text not null check (track in ('general', 'court_ordered')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'declined', 'inactive', 'withdrawn')),

  first_name text not null check (char_length(first_name) between 1 and 80),
  last_name text not null check (char_length(last_name) between 1 and 80),
  email text not null check (char_length(email) <= 254),
  phone text not null check (char_length(phone) <= 30),
  age_confirmed boolean not null check (age_confirmed),  -- adults (18+) only

  availability_days text[] not null default '{}',
  availability_notes text check (char_length(availability_notes) <= 500),
  interests text[] not null default '{}',
  skills text check (char_length(skills) <= 1000),
  preferred_assignments text check (char_length(preferred_assignments) <= 500),

  emergency_name text not null check (char_length(emergency_name) <= 120),
  emergency_relationship text not null check (char_length(emergency_relationship) <= 60),
  emergency_phone text not null check (char_length(emergency_phone) <= 30),

  -- Court-ordered community service (no offense details are ever collected)
  court_required_hours numeric(6, 2) check (court_required_hours > 0 and court_required_hours <= 1000),
  court_deadline date,
  agency_name text check (char_length(agency_name) <= 160),
  agency_contact_name text check (char_length(agency_contact_name) <= 120),
  agency_contact_email text check (char_length(agency_contact_email) <= 254),
  agency_contact_phone text check (char_length(agency_contact_phone) <= 30),
  court_reported_status text check (court_reported_status in ('approved', 'pending', 'not_requested', 'unsure')),
  court_approval_status text not null default 'not_recorded'
    check (court_approval_status in ('not_recorded', 'pending', 'approved', 'denied')),
  court_approval_notes text check (char_length(court_approval_notes) <= 1000),
  court_approval_recorded_by uuid,
  court_approval_recorded_at timestamptz,

  target_hours numeric(6, 2) check (target_hours > 0 and target_hours <= 1000),

  -- Youth safety / screening (admin-only fields)
  screening_status text not null default 'not_started'
    check (screening_status in ('not_started', 'in_progress', 'cleared', 'not_cleared')),
  background_check_status text not null default 'not_started'
    check (background_check_status in ('not_required', 'not_started', 'pending', 'cleared', 'not_cleared', 'expired')),
  background_check_completed_on date,
  background_check_expires_on date,
  background_check_reference text check (char_length(background_check_reference) <= 120),
  supervision_required boolean not null default true,
  admin_notes text check (char_length(admin_notes) <= 2000),

  decision_reason text check (char_length(decision_reason) <= 1000),
  decided_by uuid,
  decided_at timestamptz,
  ended_reason text check (char_length(ended_reason) <= 1000),
  ended_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint court_fields_required check (
    track <> 'court_ordered' or (
      court_required_hours is not null
      and court_deadline is not null
      and agency_name is not null
      and agency_contact_name is not null
      and (agency_contact_email is not null or agency_contact_phone is not null)
      and court_reported_status is not null
    )
  )
);

create index volunteers_status_idx on public.volunteers (status);
create index volunteers_email_idx on public.volunteers (lower(email));

-- ---------- Staff accounts (linked to Supabase Auth users) ----------
create table public.staff_users (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users (id) on delete cascade,
  email text not null,
  full_name text not null,
  title text,
  role text not null check (role in ('admin', 'coordinator', 'supervisor')),
  can_sign_letters boolean not null default false,
  -- If a staff member is ALSO a volunteer, link them here so they can never
  -- verify their own hours.
  volunteer_id uuid references public.volunteers (id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint only_admins_sign check (not can_sign_letters or (role = 'admin' and title is not null))
);

alter table public.volunteers
  add constraint volunteers_decided_by_fk foreign key (decided_by) references public.staff_users (id) on delete set null,
  add constraint volunteers_court_recorded_by_fk foreign key (court_approval_recorded_by) references public.staff_users (id) on delete set null;

-- ---------- Agreement acknowledgments ----------
create table public.agreement_acknowledgments (
  id uuid primary key default gen_random_uuid(),
  volunteer_id uuid not null references public.volunteers (id) on delete cascade,
  agreement_version text not null,
  typed_name text not null check (char_length(typed_name) <= 170),
  method text not null default 'web_form_checkbox_and_typed_name',
  acknowledged_at timestamptz not null default now()
);

create index agreement_ack_volunteer_idx on public.agreement_acknowledgments (volunteer_id);

-- ---------- Activities / assignments ----------
create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 120),
  description text check (char_length(description) <= 1000),
  location text check (char_length(location) <= 200),
  youth_facing boolean not null default false,
  requires_supervision boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.volunteer_assignments (
  id uuid primary key default gen_random_uuid(),
  volunteer_id uuid not null references public.volunteers (id) on delete cascade,
  assignment_id uuid not null references public.assignments (id) on delete restrict,
  supervisor_name text not null check (char_length(supervisor_name) <= 120),
  status text not null default 'active' check (status in ('active', 'ended')),
  assigned_by uuid references public.staff_users (id) on delete set null,
  assigned_at timestamptz not null default now(),
  ended_at timestamptz
);

create unique index volunteer_assignments_one_active
  on public.volunteer_assignments (volunteer_id, assignment_id) where status = 'active';

-- ---------- Hour entries ----------
create table public.hour_entries (
  id uuid primary key default gen_random_uuid(),
  volunteer_id uuid not null references public.volunteers (id) on delete cascade,
  assignment_id uuid not null references public.assignments (id) on delete restrict,
  service_date date not null,
  start_time time not null,
  end_time time not null,
  break_minutes integer not null default 0 check (break_minutes >= 0),
  net_minutes integer not null,
  supervisor_name text not null check (char_length(supervisor_name) <= 120),
  notes text check (char_length(notes) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'voided')),
  created_by uuid references public.staff_users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verified_by uuid references public.staff_users (id) on delete set null,
  verified_at timestamptz,
  verification_note text check (char_length(verification_note) <= 1000),

  constraint end_after_start check (end_time > start_time),
  constraint net_positive check (net_minutes > 0),
  constraint net_matches_times check (
    net_minutes = (extract(epoch from (end_time - start_time)) / 60)::integer - break_minutes
  ),
  constraint approved_has_verifier check (status <> 'approved' or (verified_by is not null and verified_at is not null)),
  -- No overlapping active entries for the same volunteer.
  constraint no_overlapping_entries exclude using gist (
    volunteer_id with =,
    tsrange(service_date + start_time, service_date + end_time) with &&
  ) where (status in ('pending', 'approved'))
);

create index hour_entries_volunteer_idx on public.hour_entries (volunteer_id, service_date);
create index hour_entries_status_idx on public.hour_entries (status);

-- Defense in depth: a staff member linked to a volunteer record can never
-- approve hours for that volunteer (also enforced in the API).
create function public.prevent_self_verification() returns trigger
language plpgsql as $$
begin
  if new.status = 'approved' and exists (
    select 1 from public.staff_users s
    where s.id = new.verified_by and s.volunteer_id = new.volunteer_id
  ) then
    raise exception 'Volunteers may not verify their own hours' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger hour_entries_no_self_verification
  before insert or update on public.hour_entries
  for each row execute function public.prevent_self_verification();

-- ---------- Hour correction history ----------
create table public.hour_entry_revisions (
  id uuid primary key default gen_random_uuid(),
  hour_entry_id uuid not null references public.hour_entries (id) on delete cascade,
  changed_by uuid references public.staff_users (id) on delete set null,
  changed_at timestamptz not null default now(),
  reason text not null check (char_length(reason) between 1 and 1000),
  previous jsonb not null
);

create index hour_entry_revisions_entry_idx on public.hour_entry_revisions (hour_entry_id);

-- ---------- Verification letters ----------
create table public.verification_letters (
  id uuid primary key default gen_random_uuid(),
  letter_number text not null unique,
  volunteer_id uuid not null references public.volunteers (id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'approved', 'void')),
  total_minutes integer not null check (total_minutes > 0),
  entry_count integer not null check (entry_count > 0),
  entry_ids uuid[] not null,
  first_service_date date not null,
  last_service_date date not null,
  issue_date date,
  signer_name text,
  signer_title text,
  drafted_by uuid references public.staff_users (id) on delete set null,
  drafted_at timestamptz not null default now(),
  approved_by uuid references public.staff_users (id) on delete set null,
  approved_at timestamptz,
  voided_by uuid references public.staff_users (id) on delete set null,
  voided_at timestamptz,
  void_reason text check (char_length(void_reason) <= 1000),
  constraint approved_letter_complete check (
    status <> 'approved' or (
      approved_by is not null and approved_at is not null and issue_date is not null
      and signer_name is not null and signer_title is not null
    )
  )
);

create index verification_letters_volunteer_idx on public.verification_letters (volunteer_id);

-- ---------- Audit log ----------
create table public.audit_log (
  id bigint generated always as identity primary key,
  actor_staff_id uuid references public.staff_users (id) on delete set null,
  actor_email text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index audit_log_created_idx on public.audit_log (created_at desc);

-- ---------- Spam / brute-force throttle (stores salted hashes, never raw IPs) ----------
create table public.submission_throttle (
  id bigint generated always as identity primary key,
  key_hash text not null,
  created_at timestamptz not null default now()
);

create index submission_throttle_key_idx on public.submission_throttle (key_hash, created_at);

-- ---------- Lock everything down ----------
do $$
declare t text;
begin
  foreach t in array array[
    'volunteers', 'staff_users', 'agreement_acknowledgments', 'assignments',
    'volunteer_assignments', 'hour_entries', 'hour_entry_revisions',
    'verification_letters', 'audit_log', 'submission_throttle'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end;
$$;

revoke execute on function public.prevent_self_verification() from anon, authenticated;
