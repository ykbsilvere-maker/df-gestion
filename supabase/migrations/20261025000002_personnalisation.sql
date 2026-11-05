-- =====================================================================
-- Migration 002 : personnalisation par entreprise
--   * informations légales et visuelles (RCCM, e-mail, logo, couleur) ;
--   * paramètres d'impression des reçus (A4 divisé en 6, thermique 58/80 mm) ;
--   * stockage des logos et photos de produits, cloisonné par entreprise.
-- =====================================================================

alter table public.organisations
  add column rccm      text check (rccm is null or length(rccm) <= 40),
  add column email     text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  add column logo_path text check (logo_path is null or length(logo_path) <= 300),
  add column couleur   text not null default 'foret'
                       check (couleur in ('foret','ocean','terre','prune','ardoise','nuit'));

grant update (rccm, email, logo_path, couleur) on public.organisations to authenticated;

create table public.parametres_impression (
  organisation_id  uuid primary key references public.organisations(id),
  format           text not null default 'a4_6'
                   check (format in ('a4_6','thermique_80','thermique_58')),
  afficher_logo    boolean not null default true,
  entete           text check (entete is null or length(entete) <= 160),
  pied             text default 'Merci de votre visite et à bientôt !' check (pied is null or length(pied) <= 300),
  mention_legale   text check (mention_legale is null or length(mention_legale) <= 200),
  afficher_caissier boolean not null default true,
  afficher_ncc     boolean not null default true,
  -- Feuille A4 : décalage pour compenser les marges physiques de l'imprimante (en mm).
  decalage_x_mm    numeric(4,1) not null default 0 check (decalage_x_mm between -10 and 10),
  decalage_y_mm    numeric(4,1) not null default 0 check (decalage_y_mm between -10 and 10),
  updated_at       timestamptz not null default now()
);

insert into public.parametres_impression (organisation_id)
select id from public.organisations
on conflict do nothing;

create function prive.tg_parametres_par_defaut() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.parametres_impression (organisation_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger organisations_parametres_par_defaut
  after insert on public.organisations
  for each row execute function prive.tg_parametres_par_defaut();

create trigger parametres_impression_updated_at before update on public.parametres_impression
  for each row execute function prive.tg_maj_updated_at();
create trigger parametres_impression_audit after insert or update or delete on public.parametres_impression
  for each row execute function prive.tg_audit();

alter table public.parametres_impression enable row level security;
create policy lecture on public.parametres_impression for select to authenticated
  using (prive.est_membre(organisation_id));
create policy modification on public.parametres_impression for update to authenticated
  using (prive.a_permission(organisation_id, 'administration.modifier'))
  with check (prive.a_permission(organisation_id, 'administration.modifier'));

revoke all on public.parametres_impression from anon, authenticated;
grant select on public.parametres_impression to authenticated;
grant update (format, afficher_logo, entete, pied, mention_legale, afficher_caissier, afficher_ncc,
              decalage_x_mm, decalage_y_mm)
  on public.parametres_impression to authenticated;

-- ---------------------------------------------------------------------
-- Stockage des images : un dossier par entreprise, nommé par son identifiant.
--   logos/<organisation_id>/...     produits/<organisation_id>/...
-- Les deux espaces sont publics en lecture (images affichées sur les reçus
-- et dans l'application) ; l'écriture est réservée aux personnes habilitées.
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('logos', 'logos', true, 524288, array['image/png','image/jpeg','image/webp']),
       ('produits', 'produits', true, 524288, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

create function prive.organisation_du_chemin(p_nom text) returns uuid
language plpgsql immutable as $$
declare dossier text := (storage.foldername(p_nom))[1];
begin
  if dossier ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return dossier::uuid;
  end if;
  return null;
end $$;
grant execute on function prive.organisation_du_chemin(text) to authenticated;

create policy df_images_lecture on storage.objects for select to authenticated
  using (bucket_id in ('logos','produits') and prive.est_membre(prive.organisation_du_chemin(name)));

create policy df_logos_ecriture on storage.objects for insert to authenticated
  with check (bucket_id = 'logos'
              and prive.a_permission(prive.organisation_du_chemin(name), 'administration.modifier'));
create policy df_logos_modification on storage.objects for update to authenticated
  using (bucket_id = 'logos'
         and prive.a_permission(prive.organisation_du_chemin(name), 'administration.modifier'));
create policy df_logos_suppression on storage.objects for delete to authenticated
  using (bucket_id = 'logos'
         and prive.a_permission(prive.organisation_du_chemin(name), 'administration.modifier'));

create policy df_photos_ecriture on storage.objects for insert to authenticated
  with check (bucket_id = 'produits'
              and prive.a_permission(prive.organisation_du_chemin(name), 'catalogue.modifier'));
create policy df_photos_modification on storage.objects for update to authenticated
  using (bucket_id = 'produits'
         and prive.a_permission(prive.organisation_du_chemin(name), 'catalogue.modifier'));
create policy df_photos_suppression on storage.objects for delete to authenticated
  using (bucket_id = 'produits'
         and prive.a_permission(prive.organisation_du_chemin(name), 'catalogue.modifier'));

revoke all on all functions in schema prive from public;
grant execute on function prive.organisation_du_chemin(text) to authenticated;
