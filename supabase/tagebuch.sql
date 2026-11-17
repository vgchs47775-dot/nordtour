-- Nordtour: Foto-Speicher für das Reisetagebuch.
-- Im Supabase-Dashboard unter "SQL Editor" komplett einfügen und auf "Run" klicken.
-- Legt einen PRIVATEN Bucket "tagebuch" an. Jede Person darf nur in ihren eigenen Ordner
-- (<Benutzer-ID>/...) schreiben und nur von dort lesen.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('tagebuch', 'tagebuch', false, 5242880, array['image/jpeg'])   -- max. 5 MB pro Foto (die App verkleinert vorher)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "tagebuch lesen"    on storage.objects;
drop policy if exists "tagebuch anlegen"  on storage.objects;
drop policy if exists "tagebuch ändern"   on storage.objects;
drop policy if exists "tagebuch löschen"  on storage.objects;

create policy "tagebuch lesen" on storage.objects for select to authenticated
  using (bucket_id = 'tagebuch' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "tagebuch anlegen" on storage.objects for insert to authenticated
  with check (bucket_id = 'tagebuch' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "tagebuch ändern" on storage.objects for update to authenticated
  using (bucket_id = 'tagebuch' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'tagebuch' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "tagebuch löschen" on storage.objects for delete to authenticated
  using (bucket_id = 'tagebuch' and (storage.foldername(name))[1] = (select auth.uid())::text);
