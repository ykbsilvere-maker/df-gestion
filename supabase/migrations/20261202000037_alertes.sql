-- =====================================================================
-- DF Gestion 3.10 — Alertes des commandes en ligne :
--   * la caissière est prévenue de chaque nouvelle commande (en attente d'affectation),
--   * le téléphone vérifie les commandes même application fermée (jeton d'appareil),
--   * WhatsApp automatique (CallMeBot) à la gérante et à la caissière affectée.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Compteurs d'une personne (gérante : à affecter ; caissière : affectées et en attente)
-- ---------------------------------------------------------------------
create function prive.attente_pour(p_org uuid, p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with m as (select * from public.membres where organisation_id = p_org and user_id = p_user and actif limit 1),
  d as (select m.*, prive.permission_du_membre(m, 'boutique.consulter') consulte,
               prive.permission_du_membre(m, 'boutique.valider') gerante from m),
  c as (select w.* from public.commandes_web w, d
         where w.organisation_id = p_org and w.vente_id is null and d.consulte
           and (d.role_code = 'proprietaire' or d.tous_magasins
                or exists (select 1 from public.membre_magasins mm where mm.membre_id = d.id and mm.magasin_id = w.magasin_id)))
  select coalesce((select jsonb_build_object(
    'nombre', (select count(*) from c where c.caissier_id = p_user and c.statut in ('confirmee','prete','en_livraison')),
    'a_affecter', case when d.gerante then (select count(*) from c where c.caissier_id is null and c.statut in ('nouvelle','confirmee','prete')) else 0 end,
    'en_attente', (select count(*) from c where c.caissier_id is null and c.statut in ('nouvelle','confirmee')),
    'gerante', d.gerante,
    'derniere', (select max(created_at) from c where c.statut = 'nouvelle'),
    'derniere_affectation', (select max(affectee_le) from c where c.caissier_id = p_user))
    from d where d.consulte), jsonb_build_object('nombre', 0, 'a_affecter', 0, 'en_attente', 0, 'gerante', false))
$$;

create or replace function public.commandes_caisse_attente(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select prive.attente_pour(p_org, auth.uid())
$$;

-- ---------------------------------------------------------------------
-- 2. Jeton d'appareil : le téléphone (APK) demande les compteurs toutes les 15 minutes,
--    même application fermée. Le jeton ne donne accès qu'aux nombres, rien d'autre.
-- ---------------------------------------------------------------------
create table prive.appareils (
  jeton_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  created_at timestamptz not null default now(),
  vu_le timestamptz
);
create index appareils_user_idx on prive.appareils (user_id);
alter table prive.appareils enable row level security;

create function public.enregistrer_appareil(p_org uuid, p_jeton text) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.consulter'), 'Droit « boutique.consulter » requis');
  perform prive.exiger(length(coalesce(p_jeton, '')) between 32 and 128, 'Jeton invalide');
  insert into prive.appareils (jeton_hash, user_id, organisation_id)
  values (encode(sha256(convert_to(p_jeton, 'UTF8')), 'hex'), auth.uid(), p_org)
  on conflict (jeton_hash) do update set user_id = excluded.user_id, organisation_id = excluded.organisation_id;
  -- Au plus 5 appareils par personne : les plus anciens sont oubliés.
  delete from prive.appareils a where a.user_id = auth.uid() and a.jeton_hash in (
    select jeton_hash from prive.appareils where user_id = auth.uid() order by coalesce(vu_le, created_at) desc offset 5);
  return true;
end $$;

create function public.oublier_appareil(p_jeton text) returns boolean
language sql security definer set search_path = '' as $$
  delete from prive.appareils where jeton_hash = encode(sha256(convert_to(coalesce(p_jeton, ''), 'UTF8')), 'hex') returning true
$$;

-- Appelée par l'application Android sans session (clé publique seulement).
create function public.appareil_attente(p_jeton text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a prive.appareils;
begin
  if length(coalesce(p_jeton, '')) < 32 then return null; end if;
  update prive.appareils set vu_le = now()
   where jeton_hash = encode(sha256(convert_to(p_jeton, 'UTF8')), 'hex') returning * into a;
  if not found then return null; end if;
  return prive.attente_pour(a.organisation_id, a.user_id);
end $$;

-- ---------------------------------------------------------------------
-- 3. WhatsApp automatique (CallMeBot) : chaque personne active ses alertes avec SA clé,
--    gardée côté serveur (jamais renvoyée à l'application).
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
end $$;

create table prive.alertes_whatsapp (
  user_id uuid not null references auth.users(id) on delete cascade,
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  telephone text not null check (telephone ~ '^\+[0-9]{8,15}$'),
  apikey text not null check (length(apikey) between 3 and 64),
  actif boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (user_id, organisation_id)
);
alter table prive.alertes_whatsapp enable row level security;

create function prive.envoyer_whatsapp(p_tel text, p_cle text, p_texte text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  execute 'select net.http_get(url := $1, params := $2, timeout_milliseconds := 8000)'
    using 'https://api.callmebot.com/whatsapp.php', jsonb_build_object('phone', p_tel, 'text', p_texte, 'apikey', p_cle);
exception when others then
  -- Une alerte qui échoue ne doit jamais bloquer une commande.
  raise warning 'WhatsApp non envoyé : %', sqlerrm;
end $$;

create function public.alerte_whatsapp_lire(p_org uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_build_object('telephone', a.telephone, 'actif', a.actif, 'configuree', true, 'updated_at', a.updated_at)
                     from prive.alertes_whatsapp a where a.user_id = auth.uid() and a.organisation_id = p_org),
                  jsonb_build_object('configuree', false))
$$;

create function public.alerte_whatsapp_enregistrer(p_org uuid, p_telephone text, p_cle text, p_actif boolean default true) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_chiffres text := regexp_replace(coalesce(p_telephone, ''), '[^0-9]', '', 'g');
  v_tel text;
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.consulter'), 'Droit « boutique.consulter » requis');
  v_tel := case when length(v_chiffres) = 10 then '+225' || v_chiffres
                when v_chiffres like '225%' then '+' || v_chiffres
                else '+' || v_chiffres end;
  perform prive.exiger(v_tel ~ '^\+[0-9]{8,15}$', 'Numéro WhatsApp invalide');
  if nullif(btrim(coalesce(p_cle, '')), '') is null then
    -- Sans nouvelle clé : on garde l'ancienne (changement de numéro ou pause).
    update prive.alertes_whatsapp set telephone = v_tel, actif = coalesce(p_actif, true), updated_at = now()
     where user_id = auth.uid() and organisation_id = p_org;
    perform prive.exiger(found, 'Collez la clé (apikey) reçue de CallMeBot sur WhatsApp');
  else
    insert into prive.alertes_whatsapp (user_id, organisation_id, telephone, apikey, actif)
    values (auth.uid(), p_org, v_tel, btrim(p_cle), coalesce(p_actif, true))
    on conflict (user_id, organisation_id) do update
      set telephone = excluded.telephone, apikey = excluded.apikey, actif = excluded.actif, updated_at = now();
  end if;
  return public.alerte_whatsapp_lire(p_org);
end $$;

create function public.alerte_whatsapp_supprimer(p_org uuid) returns boolean
language sql security definer set search_path = '' as $$
  delete from prive.alertes_whatsapp where user_id = auth.uid() and organisation_id = p_org returning true
$$;

create function public.alerte_whatsapp_tester(p_org uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare a prive.alertes_whatsapp;
begin
  select * into a from prive.alertes_whatsapp where user_id = auth.uid() and organisation_id = p_org;
  perform prive.exiger(found, 'Activez d''abord vos alertes WhatsApp');
  perform prive.envoyer_whatsapp(a.telephone, a.apikey,
    '✅ DF Gestion : vos alertes WhatsApp sont actives. Vous serez prévenu(e) de chaque commande en ligne.');
  return true;
end $$;

-- Texte court, sans le téléphone du client.
create function prive.texte_commande(c public.commandes_web) returns text
language sql stable security definer set search_path = '' as $$
  select format('%s %s · %s FCFA · %s · %s article(s)%s',
                c.numero, split_part(btrim(c.client_nom), ' ', 1),
                replace(to_char(c.total, 'FM999G999G999'), ',', ' '),
                case when c.mode = 'livraison' then 'livraison ' || coalesce(c.zone_nom, '') else 'retrait en boutique' end,
                (select coalesce(sum(quantite), 0)::int from public.commandes_web_lignes where commande_id = c.id),
                case c.paiement when 'livraison' then ' · paiement à la remise' when 'autre' then ' · ' || coalesce(c.paiement_libelle, 'autre')
                                else ' · ' || initcap(c.paiement) end)
$$;

-- Nouvelle commande → gérantes (droit boutique.valider) ; affectation → caissière choisie.
create function prive.alerter_commande_web() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  a record;
  c public.commandes_web;
begin
  -- Relue à la fin de la transaction : lignes et total sont alors complets.
  select * into c from public.commandes_web where id = new.id;
  if not found then return null; end if;
  if tg_op = 'INSERT' then
    for a in
      select w.* from prive.alertes_whatsapp w join public.membres m on m.user_id = w.user_id and m.organisation_id = w.organisation_id
       where w.organisation_id = new.organisation_id and w.actif and m.actif and prive.permission_du_membre(m, 'boutique.valider')
    loop
      perform prive.envoyer_whatsapp(a.telephone, a.apikey,
        '🛍️ Nouvelle commande en ligne : ' || prive.texte_commande(c) || E'.\nOuvrez DF Gestion pour l''affecter à une caissière.');
    end loop;
  elsif new.caissier_id is not null and new.caissier_id is distinct from old.caissier_id then
    for a in select * from prive.alertes_whatsapp where organisation_id = new.organisation_id and user_id = new.caissier_id and actif loop
      perform prive.envoyer_whatsapp(a.telephone, a.apikey,
        '🧺 Commande affectée à vous : ' || prive.texte_commande(c) || E'.\nVeuillez rassembler et vérifier les articles.');
    end loop;
  end if;
  return null;
end $$;

create constraint trigger commandes_web_alerte_nouvelle after insert on public.commandes_web
  deferrable initially deferred for each row execute function prive.alerter_commande_web();
create trigger commandes_web_alerte_affectation after update of caissier_id on public.commandes_web
  for each row execute function prive.alerter_commande_web();

-- ---------------------------------------------------------------------
-- Droits
-- ---------------------------------------------------------------------
revoke execute on function prive.attente_pour(uuid, uuid), prive.envoyer_whatsapp(text, text, text),
  prive.texte_commande(public.commandes_web), prive.alerter_commande_web() from public, anon, authenticated;
revoke execute on function public.enregistrer_appareil(uuid, text), public.oublier_appareil(text), public.alerte_whatsapp_lire(uuid),
  public.alerte_whatsapp_enregistrer(uuid, text, text, boolean), public.alerte_whatsapp_supprimer(uuid),
  public.alerte_whatsapp_tester(uuid) from public, anon;
grant execute on function public.enregistrer_appareil(uuid, text), public.oublier_appareil(text), public.alerte_whatsapp_lire(uuid),
  public.alerte_whatsapp_enregistrer(uuid, text, text, boolean), public.alerte_whatsapp_supprimer(uuid),
  public.alerte_whatsapp_tester(uuid) to authenticated;
revoke execute on function public.appareil_attente(text) from public;
grant execute on function public.appareil_attente(text) to anon, authenticated;
