-- ChromaForge initial schema
--
-- Designs are stored SEED-FIRST: the canonical artwork is { generatorVersion, seed, colors,
-- ... } in `designs.data` (jsonb), reconstructable at any resolution by the renderer. The
-- relational columns carry ownership, visibility, and like counts for the gallery.
--
-- Run this in the Supabase SQL editor (or via `supabase db push` if using the CLI).

create extension if not exists "pgcrypto"; -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- profiles: public-facing user info, 1:1 with auth.users
-- ---------------------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text unique,
  display_name text,
  avatar_url   text,
  created_at   timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Profiles are viewable by everyone"
  on public.profiles for select using (true);

create policy "Users can insert their own profile"
  on public.profiles for insert with check (auth.uid() = id);

create policy "Users can update their own profile"
  on public.profiles for update using (auth.uid() = id);

-- Auto-create a profile whenever a new auth user signs up (Google OAuth or email).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- designs: saved artworks (seed-based jsonb payload + metadata)
-- ---------------------------------------------------------------------------
create table public.designs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  title       text,
  kind        text not null default 'image' check (kind in ('image', 'animation')),
  data        jsonb not null,        -- { generatorVersion, seed, colors, ... }
  is_public   boolean not null default true,
  likes_count integer not null default 0,
  created_at  timestamptz not null default now()
);

create index designs_user_id_idx on public.designs(user_id);
create index designs_public_created_idx on public.designs(created_at desc) where is_public;

alter table public.designs enable row level security;

create policy "Public designs are viewable by everyone"
  on public.designs for select using (is_public or auth.uid() = user_id);

create policy "Users can insert their own designs"
  on public.designs for insert with check (auth.uid() = user_id);

create policy "Users can update their own designs"
  on public.designs for update using (auth.uid() = user_id);

create policy "Users can delete their own designs"
  on public.designs for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- likes: join table powering gallery hearts + likes_count
-- ---------------------------------------------------------------------------
create table public.likes (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  design_id  uuid not null references public.designs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, design_id)
);

alter table public.likes enable row level security;

create policy "Likes are viewable by everyone"
  on public.likes for select using (true);

create policy "Users can like as themselves"
  on public.likes for insert with check (auth.uid() = user_id);

create policy "Users can remove their own likes"
  on public.likes for delete using (auth.uid() = user_id);

-- Keep designs.likes_count in sync with the likes table.
create or replace function public.handle_like_change()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    update public.designs set likes_count = likes_count + 1 where id = new.design_id;
  elsif (tg_op = 'DELETE') then
    update public.designs set likes_count = greatest(likes_count - 1, 0) where id = old.design_id;
  end if;
  return null;
end;
$$;

create trigger on_like_change
  after insert or delete on public.likes
  for each row execute function public.handle_like_change();
