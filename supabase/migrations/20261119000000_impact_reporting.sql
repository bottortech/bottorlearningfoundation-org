-- ============================================================
-- Bottor Learning Foundation — Impact reporting (Phase 5)
-- Migration 003 (2026-11-19). Small, additive changes only.
-- ============================================================

-- Starting totals ("baselines") record figures kept before the portal existed.
-- period_start..as_of is the span they cover. A report includes a baseline only
-- when it covers that whole span, and then skips entries dated inside it, so
-- nothing is counted twice.
alter table public.impact_baselines add column period_start date;
alter table public.impact_baselines
  add constraint impact_baselines_period check (period_start is null or period_start <= as_of);

-- Allow engagement counts (not unique people) to be recorded per event.
alter table public.event_impact_counts drop constraint event_impact_counts_metric_check;
alter table public.event_impact_counts add constraint event_impact_counts_metric_check check (metric in (
  'attendance', 'children_served', 'families_served', 'game_participants',
  'table_interactions', 'activity_plays',
  'books_distributed', 'clothing_distributed', 'other_items_distributed'
));

notify pgrst, 'reload schema';
