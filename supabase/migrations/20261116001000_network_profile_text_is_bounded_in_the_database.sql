-- ===========================================================================
-- NETWORK PROFILE TEXT IS BOUNDED IN THE DATABASE (audit 2026-11-16)
-- ===========================================================================
-- network_profiles is the one table whose text other tenants read, and its
-- length caps lived only in lib/network/profiles.ts (readProfile), which a
-- direct PostgREST write with the member's own JWT never runs. A holder of
-- manage_network_profile could store and publish arbitrarily large values,
-- which the directory views then project into every other tenant's pages.
--
-- Same numbers as lib/crm/validate.ts (MAX_SHORT_TEXT 200, MAX_LONG_TEXT
-- 4000). char_length counts code points, never more than the form's UTF-16
-- length, so nothing the form accepts is refused here. A NULL passes.
--
-- NOT VALID: existing rows are not re-checked, so this cannot fail on hosted
-- data; every insert and update from now on is checked. A row already over a
-- cap stays readable and must be shortened before its next edit.
-- ===========================================================================
alter table public.network_profiles
  add constraint network_profiles_text_is_bounded check (
        char_length(display_name)  <= 200
    and char_length(headline)      <= 200
    and char_length(city)          <= 200
    and char_length(region)        <= 200
    and char_length(country)       <= 200
    and char_length(website_url)   <= 200
    and char_length(contact_email) <= 200
    and char_length(bio)           <= 4000
  ) not valid;

comment on constraint network_profiles_text_is_bounded on public.network_profiles is
  'Audit 2026-11-16: the published text columns carry the caps of lib/crm/validate.ts (200; bio 4000) in the database, because this is the one table whose rows other tenants read and a direct PostgREST write skips the form. NOT VALID: applied to new writes only.';
