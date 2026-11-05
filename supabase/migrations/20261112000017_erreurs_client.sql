-- =====================================================================
-- 1.3.1 : journal des erreurs de l'application (filet de sécurité)
-- =====================================================================
-- Quand un écran plante, l'application l'affiche proprement et signale l'erreur
-- ici (page, message, version, appareil ; aucune donnée de vente).
-- Lecture : administrateur général (console), propriétaire pour son entreprise.

create table public.erreurs_client (
  id              bigint generated always as identity primary key,
  organisation_id uuid references public.organisations(id) on delete set null,
  user_id         uuid default auth.uid(),
  page            text check (length(page) <= 200),
  message         text not null check (length(message) <= 500),
  pile            text check (length(pile) <= 3000),
  version         text check (length(version) <= 20),
  appareil        text check (length(appareil) <= 300),
  created_at      timestamptz not null default now()
);
create index erreurs_client_date_idx on public.erreurs_client (created_at desc);

create function public.signaler_erreur(
  p_org uuid, p_page text, p_message text, p_pile text, p_version text, p_appareil text
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then return; end if;
  -- Au plus 50 signalements par personne et par jour.
  if (select count(*) from public.erreurs_client where user_id = auth.uid() and created_at > now() - interval '1 day') >= 50 then
    return;
  end if;
  insert into public.erreurs_client (organisation_id, page, message, pile, version, appareil)
  values (case when p_org is not null and prive.est_membre(p_org) then p_org end,
          left(p_page, 200), left(coalesce(p_message, '?'), 500), left(p_pile, 3000), left(p_version, 20), left(p_appareil, 300));
end $$;

create function public.erreurs_recentes(p_jours int default 7) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.dernier desc) from (
      select e.message, e.page, e.version, max(e.created_at) dernier, count(*)::int nombre,
             count(distinct e.user_id)::int personnes, max(o.nom) entreprise, (array_agg(e.pile order by e.created_at desc))[1] pile
      from public.erreurs_client e left join public.organisations o on o.id = e.organisation_id
      where e.created_at > now() - make_interval(days => greatest(1, least(coalesce(p_jours, 7), 90)))
        and (prive.est_admin_general()
             or (e.organisation_id is not null and (prive.membre_courant(e.organisation_id)).role_code = 'proprietaire'))
      group by e.message, e.page, e.version
      limit 200) x), '[]'::jsonb);
end $$;

alter table public.erreurs_client enable row level security;
revoke all on public.erreurs_client from anon, authenticated;
revoke all on function public.signaler_erreur(uuid, text, text, text, text, text), public.erreurs_recentes(int) from public, anon;
grant execute on function public.signaler_erreur(uuid, text, text, text, text, text), public.erreurs_recentes(int) to authenticated;
