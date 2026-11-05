-- Stand-in for the shared Supabase schema: only the tables and columns the
-- connector touches, named as in the Bulletin App migrations.
create schema if not exists auth;
create table auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql as $$ select null::uuid $$;
create or replace function set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

create table sermons (
  id uuid primary key default gen_random_uuid(), owner_user_id uuid references auth.users(id),
  title text, manuscript_text text, manuscript_url text, scripture_reference text, theme text, preached_at date, notes text,
  original_sermon_number int, strength int, timeless text, is_eulogy boolean not null default false, major_stories text, lectionary_year text,
  manuscript_locked boolean not null default false, manuscript_locked_at timestamptz, manuscript_locked_revision_id uuid,
  liturgy_theme text, previous_titles text[] not null default '{}', deceased_name text, eulogy_outline text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create trigger sermons_updated_at before update on sermons for each row execute function set_updated_at();
create table preachings (id uuid primary key default gen_random_uuid(), sermon_id uuid not null references sermons(id) on delete cascade,
  preached_at date, location text, title_used text, series text, notes text, owner_user_id uuid, is_at_our_church boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table sermon_revisions (id uuid primary key default gen_random_uuid(), sermon_id uuid not null references sermons(id) on delete cascade,
  owner_user_id uuid, snapshot_title text, snapshot_manuscript_text text, snapshot_scripture_reference text, snapshot_theme text, snapshot_notes text,
  label text, taken_at timestamptz not null default now(), created_at timestamptz not null default now());
create table resources (id uuid primary key default gen_random_uuid(), owner_user_id uuid not null,
  resource_type text not null check (resource_type in ('story','quote','illustration','joke','note','photo','exegesis')),
  title text, content text not null, source text, source_url text, themes text[] not null default '{}', scripture_refs text, tone text, notes text,
  library_id uuid, external_source text, external_guid text, original_created_at timestamptz, auto_generated boolean not null default false, auto_source_label text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create trigger resources_updated_at before update on resources for each row execute function set_updated_at();
create table sermon_resources (id uuid primary key default gen_random_uuid(), sermon_id uuid not null references sermons(id) on delete cascade,
  resource_id uuid not null references resources(id) on delete cascade, owner_user_id uuid not null, used_notes text, created_at timestamptz not null default now());
create table workspace_slides (id uuid primary key default gen_random_uuid(), sermon_id uuid not null references sermons(id) on delete cascade,
  owner_user_id uuid not null, sort_order int not null default 0,
  slide_type text not null default 'content' check (slide_type in ('title','scripture','quote','image','content','blank')),
  title text, body text, notes text, anchor_paragraph_text text, anchor_paragraph_idx int,
  image_resource_id uuid references resources(id) on delete set null, marker_description text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create trigger ws_updated_at before update on workspace_slides for each row execute function set_updated_at();
create table sermon_slide_images (id uuid primary key default gen_random_uuid(), sermon_id uuid not null references sermons(id) on delete cascade,
  owner_user_id uuid not null, sort_order int not null default 0, image_path text not null, original_filename text,
  matched_marker_number int, matched_marker_description text, notes text, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table sermon_stashed_blocks (id uuid primary key default gen_random_uuid(), sermon_id uuid not null references sermons(id) on delete cascade,
  owner_user_id uuid not null, title text, body text not null, source text, source_resource_id uuid, source_scripture text, used_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table sermon_liturgies (id uuid primary key default gen_random_uuid(), owner_user_id uuid not null, title text not null, raw_body text,
  used_at date, used_location text, scripture_refs text, notes text, external_source text, external_guid text, original_created_at timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table sermon_liturgy_sections (id uuid primary key default gen_random_uuid(), liturgy_id uuid not null references sermon_liturgies(id) on delete cascade,
  owner_user_id uuid not null, section_kind text not null default 'other', title text, body text not null, sort_order int not null default 0,
  is_announcement boolean not null default false, created_at timestamptz not null default now());
create table sermon_liturgy_links (id uuid primary key default gen_random_uuid(), liturgy_id uuid not null references sermon_liturgies(id) on delete cascade,
  sermon_id uuid not null references sermons(id) on delete cascade, owner_user_id uuid not null,
  link_kind text not null default 'manual' check (link_kind in ('manual','title_match','scripture_match','date_match')),
  confidence text not null default 'high' check (confidence in ('high','medium','low')), approved boolean not null default true,
  created_at timestamptz not null default now(), unique (liturgy_id, sermon_id));
create table liturgy_element_instructions (id uuid primary key default gen_random_uuid(), owner_user_id uuid not null, element_type text not null,
  instructions text not null default '', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table pastoral_voice_guides (id uuid primary key default gen_random_uuid(), owner_user_id uuid not null, guide_text text not null default '',
  word_count_target int, created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table voice_exemplars (id uuid primary key default gen_random_uuid(), voice_guide_id uuid not null references pastoral_voice_guides(id) on delete cascade,
  owner_user_id uuid not null, sermon_id uuid not null references sermons(id) on delete cascade, sort_order int not null default 0, note text,
  created_at timestamptz not null default now());
create table sermon_background_docs (id uuid primary key default gen_random_uuid(), owner_user_id uuid not null, sermon_id uuid not null references sermons(id) on delete cascade,
  title text not null, file_path text, mime_type text, file_size_bytes bigint, kind text not null, extracted_text text, page_count int, notes text, source_url text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table worship_plans (id uuid primary key default gen_random_uuid(), service_date date not null unique, theme text, scripture_reference text,
  sermon_topic text, notes text, selected_sermon_id uuid references sermons(id) on delete set null, sermon_from_scratch boolean not null default false,
  text_source text, lectionary_year text, lectionary_designation text, liturgical_season text, selected_text_option_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
