-- Agent image uploads: a private Storage bucket for images the phone attaches to
-- a chat turn. The app uploads each picked image under an object key prefixed by
-- the uploader's auth.uid(), signs a short-expiry URL, and sends that URL to the
-- daemon in the `input` message (see daemon/PROTOCOL.md). The daemon downloads it
-- to a temp file and hands the local path to the coding-agent CLI.
--
-- Layout: objects live at `<auth.uid()>/<rest…>` (e.g. `<uid>/<uuid>.png`). RLS
-- keys every operation on the FIRST path segment matching the caller's uid, so a
-- user can only read/write/delete objects under their own prefix.

-- ---------------------------------------------------------------------------
-- Bucket (private — no public read; access is via signed URLs only).
-- ---------------------------------------------------------------------------
-- Images only, capped at 10 MiB per object. The bucket enforces these
-- server-side regardless of the client, so a tampered app can't push a
-- non-image or an oversized blob. (RLS below still scopes every object to the
-- uploader's own uid prefix — a user can only ever write to their own space.)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'agent-uploads', 'agent-uploads', false,
  10485760,  -- 10 MiB
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']
)
on conflict (id) do update
  set file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------------
-- Row Level Security on storage.objects (RLS is already enabled on the table by
-- Supabase; we only add bucket-scoped, owner-prefixed policies).
--
-- `storage.foldername(name)` splits the object key on "/"; element [1] is the
-- first folder, which we require to equal the caller's uid.
-- ---------------------------------------------------------------------------
create policy "agent-uploads: owner can read own objects"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'agent-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "agent-uploads: owner can upload under own prefix"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'agent-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "agent-uploads: owner can update own objects"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'agent-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'agent-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "agent-uploads: owner can delete own objects"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'agent-uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
