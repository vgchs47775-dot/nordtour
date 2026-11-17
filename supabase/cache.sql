-- Nordtour: gemeinsamer Zwischenspeicher für berechnete Routen und Tankstellen/Trinkwasser.
-- Im Supabase-Dashboard unter "SQL Editor" komplett einfügen und auf "Run" klicken.
-- Was ein Gerät einmal berechnet hat (Routing über Valhalla, Tankstellen/Wasser über Overpass),
-- bekommen alle anderen Geräte sofort – auch das iPad, ohne selbst nachzufragen.
-- Nur der angemeldete Besitzer kann lesen und schreiben.

create table if not exists public.route_cache (
  owner      uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  kind       text        not null check (kind in ('route', 'osm')),
  key        text        not null,
  data       jsonb       not null,
  updated_at timestamptz not null default now(),
  primary key (owner, kind, key)
);

alter table public.route_cache enable row level security;
drop policy if exists "eigener Cache lesen"   on public.route_cache;
drop policy if exists "eigener Cache anlegen" on public.route_cache;
drop policy if exists "eigener Cache ändern"  on public.route_cache;
drop policy if exists "eigener Cache löschen" on public.route_cache;
create policy "eigener Cache lesen"   on public.route_cache for select to authenticated using (owner = (select auth.uid()));
create policy "eigener Cache anlegen" on public.route_cache for insert to authenticated with check (owner = (select auth.uid()));
create policy "eigener Cache ändern"  on public.route_cache for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy "eigener Cache löschen" on public.route_cache for delete to authenticated using (owner = (select auth.uid()));

revoke all on public.route_cache from anon;
grant select, insert, update, delete on public.route_cache to authenticated;
