-- Phase 4 (Operations), Task 4: the private `documents` storage bucket and the
-- deny-all client fence on storage.objects.
--
-- ===========================================================================
-- SERVER-MEDIATED STORAGE (Q53). THE BROWSER NEVER TOUCHES THE BUCKET.
-- ===========================================================================
-- Every byte in and out of this bucket goes through a Next.js Server Action /
-- Route Handler running the service-role Storage client (lib/supabase/storage.ts).
-- The browser is NEVER handed a Storage grant: it uploads by POSTing a
-- multipart form to `uploadDocumentAction`, and it downloads (Task 5) by
-- following a short-lived signed URL the server issues only AFTER it has
-- authorised the caller and confirmed scan_status='clean'.
--
-- TWO CONTROLS, IN ORDER OF PRIMACY:
--   1. `public = false` on the bucket. This is THE control. A private bucket
--      serves no object without a signed URL or a service-role request; there
--      is no anonymous public URL to guess.
--   2. A deny-all RLS fence on storage.objects for the `documents` bucket, to
--      the `authenticated` and `anon` roles. storage.objects ships with RLS
--      ENABLED and no permissive policy, so clients are already denied by
--      default -- this RESTRICTIVE policy makes that denial explicit AND
--      future-proof: even if a later migration adds a broad permissive policy
--      (a second, public, bucket, say), a restrictive policy is AND-ed with
--      every permissive one, so no client role can ever reach a `documents`
--      object regardless of what else is granted. service_role bypasses RLS
--      entirely and is unaffected -- that is the whole point: the privileged
--      server path works, the client path cannot.
--
-- `allowed_mime_types` and `file_size_limit` on the bucket are Storage's OWN
-- belt-and-braces. They are NOT the file-type allowlist. The allowlist is the
-- application's magic-byte content sniff (lib/security/file-allowlist.ts),
-- because a client-declared Content-Type is untrusted and a bucket MIME check
-- reads exactly that declared header. The bucket list here is the same modern
-- OOXML + PDF/image/text set the sniff accepts, deliberately EXCLUDING every
-- macro-enabled Office format (.docm/.xlsm/.pptm) and every executable --
-- SECURITY.md § 6: "documents, images, PDFs ... no executables, no
-- macro-enabled Office formats".
--
-- ADDITIVE, and the only Task 4 migration. No table in `public` changes.

-- ===========================================================================
-- The bucket -- private, 25 MiB cap, allowlisted MIME (belt-and-braces).
-- ===========================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 26214400,
        array['application/pdf','image/png','image/jpeg','image/webp','image/gif',
              'text/plain','text/csv',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do nothing;

-- ===========================================================================
-- The deny-all client fence.
--
-- RESTRICTIVE policies: for a client (authenticated/anon) to touch ANY
-- storage.objects row it must satisfy every restrictive policy AND at least
-- one permissive policy. `using (bucket_id <> 'documents')` makes each
-- restrictive term FALSE for a `documents` object, so no client role reaches
-- one -- upload, read, rename or delete -- even if a permissive policy is
-- added later. There is no permissive policy on storage.objects in this
-- project today, so clients are already denied; these make the denial a
-- written invariant rather than an absence, which is the thing a later change
-- could quietly undo.
--
-- service_role is exempt from RLS and is the ONLY writer/reader of these
-- objects, via lib/supabase/storage.ts on the server.
-- ===========================================================================
create policy "documents_deny_client_select"
  on storage.objects as restrictive for select to authenticated, anon
  using (bucket_id <> 'documents');

create policy "documents_deny_client_insert"
  on storage.objects as restrictive for insert to authenticated, anon
  with check (bucket_id <> 'documents');

create policy "documents_deny_client_update"
  on storage.objects as restrictive for update to authenticated, anon
  using (bucket_id <> 'documents')
  with check (bucket_id <> 'documents');

create policy "documents_deny_client_delete"
  on storage.objects as restrictive for delete to authenticated, anon
  using (bucket_id <> 'documents');
