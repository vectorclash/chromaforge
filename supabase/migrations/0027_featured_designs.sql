-- The homepage's "featured artwork" picks (2026-11-18). Until the gallery's social features have
-- the traffic to make "most liked" meaningful, the homepage shows up to 8 designs chosen by hand.
-- An admin (profiles.is_admin, which users cannot write -- see 0018) picks them from the gallery
-- modal; everyone can read the list.
--
-- The rules are enforced HERE, not only in the UI: at most 8 rows, and only a public still image
-- may be featured (animations never print -- lib/savedAnimation's printableRow). A design that is
-- deleted drops out by the cascade; one made private later is filtered out by designs' own RLS
-- when the homepage embeds it.

create table public.featured_designs (
  design_id uuid primary key references public.designs (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.featured_designs enable row level security;

create policy "Featured designs are viewable by everyone"
  on public.featured_designs for select
  using (true);

create policy "Admins can feature designs"
  on public.featured_designs for insert to authenticated
  with check (exists (select 1 from public.profiles where id = (select auth.uid()) and is_admin));

create policy "Admins can unfeature designs"
  on public.featured_designs for delete to authenticated
  using (exists (select 1 from public.profiles where id = (select auth.uid()) and is_admin));

create or replace function public.check_featured_design()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.featured_designs) >= 8 then
    raise exception 'At most 8 designs can be featured.' using errcode = 'check_violation';
  end if;
  if not exists (
    select 1 from public.designs
    where id = new.design_id and is_public and kind = 'image'
  ) then
    raise exception 'Only a public image can be featured.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.check_featured_design() from public, anon, authenticated;

create trigger featured_designs_check
  before insert on public.featured_designs
  for each row execute function public.check_featured_design();

-- Supabase's default privileges hand a new table every right to both roles; keep exactly what the
-- client uses (0022's rule).
revoke all on public.featured_designs from anon, authenticated;
grant select on public.featured_designs to anon, authenticated;
grant insert (design_id), delete on public.featured_designs to authenticated;
