-- Nordtour: automatische Sicherung + Wachhalten.
-- Im Supabase-Dashboard unter "SQL Editor" komplett einfügen und auf "Run" klicken.
--
-- 1) Tabelle trip_backups: Kopien deiner Reisedaten. Jede Nacht um 3 Uhr (UTC) wird kopiert,
--    aber nur, wenn sich seit der letzten Sicherung etwas geändert hat. Aufbewahrt werden
--    90 Tage, mindestens aber die letzten 10 Sicherungen.
-- 2) Funktion ping(): wird vom GitHub-Auftrag „Supabase wach halten“ zweimal pro Woche
--    aufgerufen, damit das kostenlose Projekt nicht wegen Inaktivität pausiert.
-- Fotos (Bucket „tagebuch“) werden nicht kopiert – sie werden nie überschrieben, nur bewusst gelöscht.

create table if not exists public.trip_backups (
  id       bigint generated always as identity primary key,
  owner    uuid        not null references auth.users (id) on delete cascade,
  trip_id  text        not null,
  data     jsonb       not null,
  version  bigint      not null,
  saved_at timestamptz not null default now()
);
create index if not exists trip_backups_owner_idx on public.trip_backups (owner, trip_id, saved_at desc);

-- Lesen darf nur der Besitzer (für „Wiederherstellen“ in der App); geschrieben wird nur über die Funktionen unten.
alter table public.trip_backups enable row level security;
drop policy if exists "eigene Sicherungen lesen" on public.trip_backups;
create policy "eigene Sicherungen lesen" on public.trip_backups for select to authenticated
  using (owner = (select auth.uid()));
revoke all on public.trip_backups from anon, authenticated;
grant select on public.trip_backups to authenticated;

-- Alle Reisen sichern (nur geänderte) und alte Sicherungen aufräumen – läuft nachts automatisch
create or replace function public.backup_trips() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.trip_backups (owner, trip_id, data, version)
  select t.owner, t.id, t.data, t.version from public.trips t
  where not exists (select 1 from public.trip_backups b
                    where b.owner = t.owner and b.trip_id = t.id and b.version = t.version);
  get diagnostics n = row_count;
  delete from public.trip_backups
  where saved_at < now() - interval '90 days'
    and id not in (select id from (select id, row_number() over (partition by owner, trip_id order by saved_at desc) as rn
                                   from public.trip_backups) x where rn <= 10);
  return n;
end $$;
revoke execute on function public.backup_trips() from public, anon, authenticated;

-- „Jetzt sichern“ aus der App: sichert nur die eigenen Reisen
create or replace function public.backup_now() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into public.trip_backups (owner, trip_id, data, version)
  select t.owner, t.id, t.data, t.version from public.trips t
  where t.owner = auth.uid()
    and not exists (select 1 from public.trip_backups b
                    where b.owner = t.owner and b.trip_id = t.id and b.version = t.version);
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function public.backup_now() from public, anon;
grant execute on function public.backup_now() to authenticated;

-- Wachhalten: liefert nur die Uhrzeit, gibt keine Daten preis
create or replace function public.ping() returns timestamptz
language sql stable as $$ select now() $$;
grant execute on function public.ping() to anon, authenticated;

-- Zeitplan: jede Nacht um 3:00 UTC sichern
create extension if not exists pg_cron;
select cron.unschedule(jobid) from cron.job where jobname = 'nordtour-sicherung';
select cron.schedule('nordtour-sicherung', '0 3 * * *', 'select public.backup_trips()');

-- Gleich eine erste Sicherung anlegen
select public.backup_trips() as erste_sicherung;
