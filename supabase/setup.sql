-- Nordtour: Tabelle für die Reisedaten.
-- Im Supabase-Dashboard unter "SQL Editor" komplett einfügen und auf "Run" klicken.
-- Jede Reise ist eine Zeile; "data" enthält alles (Tage, Kosten, Listen, Einstellungen).

create table if not exists public.trips (
  owner      uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  data       jsonb       not null,
  version    bigint      not null default 1,   -- zählt bei jedem Speichern hoch (Konflikterkennung)
  updated_at timestamptz not null default now(),
  primary key (owner, id)
);

-- Zugriff nur auf die eigenen Zeilen (Row Level Security).
-- Ohne Anmeldung kann niemand etwas lesen oder schreiben, auch nicht mit dem öffentlichen Schlüssel.
alter table public.trips enable row level security;

drop policy if exists "eigene Reisen lesen"   on public.trips;
drop policy if exists "eigene Reisen anlegen" on public.trips;
drop policy if exists "eigene Reisen ändern"  on public.trips;
drop policy if exists "eigene Reisen löschen" on public.trips;

create policy "eigene Reisen lesen"   on public.trips for select to authenticated
  using (owner = (select auth.uid()));
create policy "eigene Reisen anlegen" on public.trips for insert to authenticated
  with check (owner = (select auth.uid()));
create policy "eigene Reisen ändern"  on public.trips for update to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create policy "eigene Reisen löschen" on public.trips for delete to authenticated
  using (owner = (select auth.uid()));

-- Nicht angemeldete Besucher bekommen gar keine Rechte auf die Tabelle.
revoke all on public.trips from anon;
grant select, insert, update, delete on public.trips to authenticated;
