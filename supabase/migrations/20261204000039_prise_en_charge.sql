-- v3.12 — Circuit des commandes en ligne : la caissière accepte, la gérante confirme les livraisons.
--
--   1. La gérante reçoit la commande et l'affecte à une caissière.
--   2. La caissière est prévenue ; tant qu'elle n'a pas ACCEPTÉ, l'alerte revient toutes les 2 minutes.
--   3. Elle rassemble les articles et marque la commande « prête ».
--   4. Retrait : la caissière remet au client et encaisse.
--      Livraison : la gérante est prévenue que c'est prêt et confirme l'envoi ; ensuite seulement la caisse
--      encaisse l'argent rapporté (la caissière ne peut pas « livrer » seule).

alter table public.commandes_web add column if not exists prise_en_charge_le timestamptz;

-- Accepter une commande affectée.
create or replace function public.accepter_commande_web(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare c public.commandes_web;
begin
  select * into c from public.commandes_web where id = p_id for update;
  perform prive.exiger(found and c.caissier_id = auth.uid(), 'Cette commande ne vous est pas affectée');
  perform prive.exiger(c.statut in ('confirmee','prete','en_livraison') and c.vente_id is null, 'Cette commande est terminée');
  update public.commandes_web set prise_en_charge_le = coalesce(prise_en_charge_le, now())
   where id = p_id returning * into c;
  return to_jsonb(c);
end $$;
revoke execute on function public.accepter_commande_web(uuid) from public, anon;
grant execute on function public.accepter_commande_web(uuid) to authenticated;

-- Une nouvelle affectation doit être acceptée à nouveau.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.affecter_commande_web(uuid,uuid)'::regprocedure);
  if position('prise_en_charge_le' in d) = 0 then
    if position('     set caissier_id = p_caissier,' in d) = 0 then raise exception 'affecter_commande_web : ancre introuvable'; end if;
    d := replace(d, '     set caissier_id = p_caissier,',
      '     set prise_en_charge_le = case when p_caissier is distinct from caissier_id then null else prise_en_charge_le end,' || chr(10) ||
      '         caissier_id = p_caissier,');
    execute d;
  end if;
end $$;

-- « Prête » par la caissière : vaut acceptation.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.avancer_commande_web(uuid,text,text)'::regprocedure);
  if position('prise_en_charge_le' in d) = 0 then
    if position('           prete_le = case when p_statut = ''prete'' then now() else prete_le end,' in d) = 0 then
      raise exception 'avancer_commande_web : ancre introuvable';
    end if;
    d := replace(d, '           prete_le = case when p_statut = ''prete'' then now() else prete_le end,',
      '           prete_le = case when p_statut = ''prete'' then now() else prete_le end,' || chr(10) ||
      '           prise_en_charge_le = case when p_statut = ''prete'' and caissier_id = auth.uid() then coalesce(prise_en_charge_le, now()) else prise_en_charge_le end,');
    execute d;
  end if;
end $$;

-- Livraison : c'est la gérante qui la confirme ; avant cela, la caissière ne remet que les retraits.
do $$
declare d text;
begin
  d := pg_get_functiondef('public.encaisser_commande_web(uuid,uuid,uuid,text)'::regprocedure);
  if position('confirmer la livraison' in d) = 0 then
    if position('  perform prive.exiger(c.vente_id is null, ''Commande déjà encaissée'');' in d) = 0 then
      raise exception 'encaisser_commande_web : ancre introuvable';
    end if;
    d := replace(d, '  perform prive.exiger(c.vente_id is null, ''Commande déjà encaissée'');',
      '  perform prive.exiger(c.mode = ''retrait'' or c.statut = ''en_livraison'' or prive.a_permission(c.organisation_id, ''boutique.valider''),' || chr(10) ||
      '                       ''La gérante doit d''''abord confirmer la livraison : marquez la commande « prête », elle est prévenue'');' || chr(10) ||
      '  perform prive.exiger(c.vente_id is null, ''Commande déjà encaissée'');');
    execute d;
  end if;
end $$;

-- Ce que chacun doit voir : à accepter (caissière), prêtes à livrer (gérante).
create or replace function prive.attente_pour(p_org uuid, p_user uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
    'a_accepter', (select count(*) from c where c.caissier_id = p_user and c.prise_en_charge_le is null
                                         and c.statut in ('confirmee','prete','en_livraison')),
    'a_accepter_liste', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'numero', c.numero, 'mode', c.mode,
                                                                      'client', c.client_nom) order by c.affectee_le)
                                  from c where c.caissier_id = p_user and c.prise_en_charge_le is null
                                           and c.statut in ('confirmee','prete','en_livraison')), '[]'::jsonb),
    'a_livrer', case when d.gerante then (select count(*) from c where c.mode = 'livraison' and c.statut = 'prete') else 0 end,
    'gerante', d.gerante,
    'derniere', (select max(created_at) from c where c.statut = 'nouvelle'),
    'derniere_affectation', (select max(affectee_le) from c where c.caissier_id = p_user),
    'derniere_prete', case when d.gerante then (select max(prete_le) from c where c.mode = 'livraison' and c.statut = 'prete') end)
    from d where d.consulte),
    jsonb_build_object('nombre', 0, 'a_affecter', 0, 'en_attente', 0, 'a_accepter', 0, 'a_accepter_liste', '[]'::jsonb,
                       'a_livrer', 0, 'gerante', false))
$$;

-- Commandes à la caisse : avec la date d'acceptation.
create or replace function public.commandes_caisse(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_resp boolean := prive.a_permission(p_org, 'boutique.valider');
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.consulter'), 'Droit « boutique.consulter » requis');
  return jsonb_build_object('commandes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'numero', c.numero, 'client_nom', c.client_nom, 'client_telephone', c.client_telephone, 'mode', c.mode,
        'zone', c.zone_nom, 'souhaite_le', c.souhaite_le, 'total', c.total, 'paiement', c.paiement, 'paiement_statut', c.paiement_statut,
        'justificatif', c.justificatif_path is not null, 'statut', c.statut, 'created_at', c.created_at,
        'caissier_id', c.caissier_id, 'affectee_le', c.affectee_le, 'a_moi', c.caissier_id = auth.uid(),
        'prise_en_charge_le', c.prise_en_charge_le,
        'caissier_nom', (select coalesce(nullif(btrim(pr.nom_complet), ''), pr.email) from public.profils pr where pr.id = c.caissier_id),
        'articles', (select coalesce(sum(quantite), 0) from public.commandes_web_lignes where commande_id = c.id))
        order by (c.caissier_id = auth.uid()) desc, (c.prise_en_charge_le is null) desc, c.affectee_le desc nulls last)
      from public.commandes_web c
     where c.organisation_id = p_org and c.vente_id is null and c.statut in ('confirmee','prete','en_livraison')
       and (c.caissier_id = auth.uid() or (v_resp and c.caissier_id is not null and prive.acces_magasin(p_org, c.magasin_id)))),
     '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------------------------
-- Alertes : WhatsApp (CallMeBot) OU Telegram (CallMeBot, sans clé), et un vrai résultat d'essai.
-- Le robot WhatsApp de CallMeBot n'accepte plus de nouvelles inscriptions pour l'instant
-- (« bot plein ») : Telegram prend le relais, il suffit d'envoyer /start au robot.
-- ---------------------------------------------------------------------------------------------
alter table prive.alertes_whatsapp alter column telephone drop not null;
alter table prive.alertes_whatsapp alter column apikey drop not null;
alter table prive.alertes_whatsapp add column if not exists telegram text;
alter table prive.alertes_whatsapp add column if not exists essais bigint[];
alter table prive.alertes_whatsapp drop constraint if exists alertes_un_canal;
alter table prive.alertes_whatsapp add constraint alertes_un_canal
  check ((telephone is not null and apikey is not null) or telegram is not null);

-- Envoie sur chaque canal configuré ; renvoie les numéros de requête (pour vérifier l'essai).
create or replace function prive.envoyer_alerte(a prive.alertes_whatsapp, p_texte text)
returns bigint[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  ids bigint[] := '{}';
  i bigint;
begin
  if a.telephone is not null and a.apikey is not null then
    begin
      execute 'select net.http_get(url := $1, params := $2, timeout_milliseconds := 8000)' into i
        using 'https://api.callmebot.com/whatsapp.php', jsonb_build_object('phone', a.telephone, 'text', p_texte, 'apikey', a.apikey);
      ids := ids || i;
    exception when others then
      raise warning 'WhatsApp non envoyé : %', sqlerrm;
    end;
  end if;
  if a.telegram is not null then
    begin
      execute 'select net.http_get(url := $1, params := $2, timeout_milliseconds := 8000)' into i
        using 'https://api.callmebot.com/text.php', jsonb_build_object('user', a.telegram, 'text', p_texte);
      ids := ids || i;
    exception when others then
      raise warning 'Telegram non envoyé : %', sqlerrm;
    end;
  end if;
  return ids;
end $$;

drop function if exists public.alerte_whatsapp_enregistrer(uuid, text, text, boolean);
create or replace function public.alerte_whatsapp_enregistrer(p_org uuid, p_telephone text, p_cle text,
                                                              p_actif boolean default true, p_telegram text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_chiffres text := regexp_replace(coalesce(p_telephone, ''), '[^0-9]', '', 'g');
  v_tel text;
  v_cle text := nullif(btrim(coalesce(p_cle, '')), '');
  v_tg text := nullif(regexp_replace(btrim(coalesce(p_telegram, '')), '^@*', ''), '');
  a prive.alertes_whatsapp;
begin
  perform prive.exiger(prive.a_permission(p_org, 'boutique.consulter'), 'Droit « boutique.consulter » requis');
  if v_chiffres <> '' then
    v_tel := case when length(v_chiffres) = 10 then '+225' || v_chiffres
                  when v_chiffres like '225%' then '+' || v_chiffres
                  else '+' || v_chiffres end;
    perform prive.exiger(v_tel ~ '^\+[0-9]{8,15}$', 'Numéro WhatsApp invalide');
  end if;
  if v_tg is not null then
    perform prive.exiger(v_tg ~ '^[A-Za-z0-9_]{5,32}$', 'Nom Telegram invalide : 5 à 32 lettres, chiffres ou _ (ex. @awa_kone)');
    v_tg := '@' || v_tg;
  end if;
  select * into a from prive.alertes_whatsapp where user_id = auth.uid() and organisation_id = p_org;
  -- Sans nouvelle clé : on garde l'ancienne (changement de numéro ou pause).
  v_cle := coalesce(v_cle, case when v_tel is not null then a.apikey end);
  if v_tel is not null and v_cle is null then v_tel := null; end if;
  perform prive.exiger(v_tel is not null or v_tg is not null,
    'Indiquez votre nom Telegram, ou votre numéro WhatsApp avec la clé (apikey) reçue de CallMeBot');
  insert into prive.alertes_whatsapp (user_id, organisation_id, telephone, apikey, telegram, actif)
  values (auth.uid(), p_org, v_tel, case when v_tel is not null then v_cle end, v_tg, coalesce(p_actif, true))
  on conflict (user_id, organisation_id) do update
    set telephone = excluded.telephone, apikey = excluded.apikey, telegram = excluded.telegram,
        actif = excluded.actif, updated_at = now();
  return public.alerte_whatsapp_lire(p_org);
end $$;

create or replace function public.alerte_whatsapp_lire(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select jsonb_build_object('telephone', a.telephone, 'whatsapp', a.telephone is not null and a.apikey is not null,
                                             'telegram', a.telegram, 'actif', a.actif, 'configuree', true, 'updated_at', a.updated_at)
                     from prive.alertes_whatsapp a where a.user_id = auth.uid() and a.organisation_id = p_org),
                  jsonb_build_object('configuree', false))
$$;

create or replace function public.alerte_whatsapp_tester(p_org uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare a prive.alertes_whatsapp;
begin
  select * into a from prive.alertes_whatsapp where user_id = auth.uid() and organisation_id = p_org;
  perform prive.exiger(found, 'Activez d''abord vos alertes');
  update prive.alertes_whatsapp
     set essais = prive.envoyer_alerte(a, '✅ DF Gestion : vos alertes de commandes sont actives. Vous serez prévenu(e) de chaque commande en ligne.')
   where user_id = a.user_id and organisation_id = a.organisation_id;
  return true;
end $$;

-- Résultat réel du dernier essai : réponse du service (ou erreur réseau).
create or replace function public.alerte_resultat(p_org uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  a prive.alertes_whatsapp;
  r jsonb;
begin
  select * into a from prive.alertes_whatsapp where user_id = auth.uid() and organisation_id = p_org;
  if not found or a.essais is null or cardinality(a.essais) = 0 then return '[]'::jsonb; end if;
  begin
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', e.id, 'recu', r.id is not null, 'statut', r.status_code, 'erreur', r.error_msg,
               'texte', left(btrim(regexp_replace(regexp_replace(coalesce(r.content, ''), '<[^>]*>', ' ', 'g'), '\s+', ' ', 'g')), 240))
             order by e.id), '[]'::jsonb)
        from unnest($1) e(id) left join net._http_response r on r.id = e.id $q$
      into r using a.essais;
  exception when others then
    r := jsonb_build_array(jsonb_build_object('recu', false, 'erreur', 'Envoi indisponible sur ce serveur'));
  end;
  return r;
end $$;

revoke execute on function public.alerte_whatsapp_enregistrer(uuid, text, text, boolean, text), public.alerte_resultat(uuid) from public, anon;
grant execute on function public.alerte_whatsapp_enregistrer(uuid, text, text, boolean, text), public.alerte_resultat(uuid) to authenticated;

-- Alertes : la gérante est aussi prévenue quand une livraison est prête.
create or replace function prive.alerter_commande_web()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  a prive.alertes_whatsapp;
  c public.commandes_web;
begin
  select * into c from public.commandes_web where id = new.id;
  if not found then return null; end if;
  if tg_op = 'INSERT' then
    for a in
      select w.* from prive.alertes_whatsapp w join public.membres m on m.user_id = w.user_id and m.organisation_id = w.organisation_id
       where w.organisation_id = new.organisation_id and w.actif and m.actif and prive.permission_du_membre(m, 'boutique.valider')
    loop
      perform prive.envoyer_alerte(a,
        '🛍️ Nouvelle commande en ligne : ' || prive.texte_commande(c) || E'.\nOuvrez DF Gestion pour l''affecter à une caissière.');
    end loop;
  elsif tg_name = 'commandes_web_alerte_prete' then
    if new.statut = 'prete' and old.statut is distinct from 'prete' and new.mode = 'livraison' then
      for a in
        select w.* from prive.alertes_whatsapp w join public.membres m on m.user_id = w.user_id and m.organisation_id = w.organisation_id
         where w.organisation_id = new.organisation_id and w.actif and m.actif and prive.permission_du_membre(m, 'boutique.valider')
      loop
        perform prive.envoyer_alerte(a,
          '🛵 Commande prête à livrer : ' || prive.texte_commande(c) || E'.\nConfirmez l''envoi dans DF Gestion.');
      end loop;
    end if;
  elsif new.caissier_id is not null and new.caissier_id is distinct from old.caissier_id then
    for a in select * from prive.alertes_whatsapp where organisation_id = new.organisation_id and user_id = new.caissier_id and actif loop
      perform prive.envoyer_alerte(a,
        '🧺 Commande affectée à vous : ' || prive.texte_commande(c) || E'.\nOuvrez DF Gestion et touchez « Accepter », puis rassemblez les articles.');
    end loop;
  end if;
  return null;
end $$;

drop trigger if exists commandes_web_alerte_prete on public.commandes_web;
create trigger commandes_web_alerte_prete after update of statut on public.commandes_web
  for each row execute function prive.alerter_commande_web();
