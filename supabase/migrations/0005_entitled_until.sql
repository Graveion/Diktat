-- Add entitled_until to account_state for RevenueCat subscription state.
-- The relay reads this column to gate access server-side.
-- Written by the RevenueCat webhook (see relay/HARDENING.md §RevenueCat webhook).

alter table public.account_state
  add column if not exists entitled_until timestamptz;

comment on column public.account_state.entitled_until is
  'Set by the RevenueCat webhook when a subscription is purchased/renewed/expired. '
  'null = no active RC subscription (may still be entitled via trial or comp_until).';
