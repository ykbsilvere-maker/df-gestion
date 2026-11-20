-- v3.20 — Notifications et code OTP, suite
-- * Caissiers prévenus sur Telegram de chaque nouvelle commande en ligne (en plus des affectations).
-- * Code OTP : un nouveau code ne peut être demandé qu'au bout de 2 minutes (durée de validité du code).
-- * Même appareil, moins de 4 heures sans activité : se déconnecter puis se reconnecter ne redemande pas de code OTP.
-- * « Mes alertes » : chacun voit l'état de son Telegram (relié par l'administrateur ou la gérante).

alter table prive.sessions_otp drop constraint if exists sessions_otp_via_check;
alter table prive.sessions_otp add constraint sessions_otp_via_check check (via in ('telegram', 'gerante', 'activation', 'appareil'));

-- ---------------------------------------------------------------- Reprise sur le même appareil
create or replace function prive.otp_reprendre(p_org uuid, p_appareil uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare s uuid := prive.session_courante();
begin
  if s is null or p_appareil is null or not prive.otp_exige(p_org, auth.uid()) or prive.session_otp_ok(p_org) then return; end if;
  if exists (select 1 from prive.sessions_otp so
               join prive.sessions_approuvees sa on sa.session_id = so.session_id and sa.organisation_id = so.organisation_id
              where so.organisation_id = p_org and so.user_id = auth.uid() and sa.appareil_id = p_appareil
                and so.session_id <> s and so.vu_le > now() - interval '4 hours') then
    insert into prive.sessions_otp (session_id, organisation_id, user_id, via)
    values (s, p_org, auth.uid(), 'appareil')
    on conflict (session_id, organisation_id) do update set verifie_le = now(), vu_le = now(), via = excluded.via;
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
    values (p_org, auth.uid(), 'otp.reprise_appareil', 'membres', auth.uid()::text, jsonb_build_object('nom', prive.nom_de(auth.uid())));
  end if;
end $$;

do $$
declare d text;
begin
  d := pg_get_functiondef('public.appareil_ouvrir(uuid,text,text)'::regprocedure);
  if position('otp_reprendre' in d) = 0 then
    d := replace(d, 'perform prive.approuver_session(a);', 'perform prive.approuver_session(a);
    perform prive.otp_reprendre(p_org, a.id);');
    if position('otp_reprendre' in d) = 0 then raise exception 'appareil_ouvrir : ancre introuvable'; end if;
    execute d;
  end if;
end $$;

-- ---------------------------------------------------------------- Renvoi du code : 2 minutes
do $$
declare d text;
begin
  d := pg_get_functiondef('public.otp_envoyer(uuid)'::regprocedure);
  if position('Patientez 2 minutes' in d) = 0 then
    d := replace(d, $r$envoye_le > now() - interval '30 seconds'),$r$, $r$envoye_le > now() - interval '115 seconds'),$r$);
    d := replace(d, 'Patientez 30 secondes avant de demander un nouveau code', 'Patientez 2 minutes avant de demander un nouveau code');
    d := replace(d, $r$where organisation_id = p_org and user_id = auth.uid() and actif
     and (chat_id is not null$r$, $r$where organisation_id = p_org and user_id = auth.uid() and actif and otp
     and (chat_id is not null$r$);
    if position('Patientez 2 minutes' in d) = 0 or position('115 seconds' in d) = 0 then raise exception 'otp_envoyer : ancre introuvable'; end if;
    execute d;
  end if;
end $$;

-- ---------------------------------------------------------------- Mon Telegram (page « Mes alertes »)
create or replace function public.mon_telegram(p_org uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'robot', (select '@' || nom_utilisateur from prive.telegram_robot where nom_utilisateur is not null limit 1),
    'relie', o.chat_id is not null and coalesce(o.actif, false),
    'telegram', o.nom_telegram,
    'otp', coalesce(o.otp and o.actif and o.chat_id is not null, false),
    'en_attente', o.chat_id is null and o.liaison_code is not null and o.liaison_expire > now(),
    'ancienne_alerte', exists (select 1 from prive.alertes_whatsapp a where a.organisation_id = p_org and a.user_id = auth.uid() and a.actif),
    'gerant', exists (select 1 from public.membres m where m.organisation_id = p_org and m.user_id = auth.uid() and m.actif and m.role_code = 'proprietaire'))
  from (select 1) x
  left join prive.otp_membres o on o.organisation_id = p_org and o.user_id = auth.uid()
$$;
revoke all on function public.mon_telegram(uuid) from public, anon;
grant execute on function public.mon_telegram(uuid) to authenticated;

-- ---------------------------------------------------------------- Notifications des commandes
create or replace function prive.alerter_commande_web()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  c public.commandes_web;
  u uuid;
  v_txt text;
  v_qui text;
begin
  select * into c from public.commandes_web where id = new.id;
  if not found then return null; end if;

  if tg_op = 'INSERT' then
    for u in
      select m.user_id from public.membres m
       where m.organisation_id = new.organisation_id and m.actif
         and (prive.permission_du_membre(m, 'boutique.administrer') or prive.permission_du_membre(m, 'boutique.affecter'))
    loop
      perform prive.notifier(new.organisation_id, u,
        '🛍️ Nouvelle commande en ligne : ' || prive.texte_commande(c) || E'\nOuvrez DF Gestion pour l''affecter à une caissière.');
    end loop;
    -- Les caissiers du magasin sont prévenus aussi (la gérante va affecter la commande).
    for u in
      select m.user_id from public.membres m
       where m.organisation_id = new.organisation_id and m.actif and m.role_code in ('caissier', 'responsable_caisse')
         and prive.peut_encaisser_magasin(new.organisation_id, m.user_id, new.magasin_id)
         and not prive.permission_du_membre(m, 'boutique.affecter')
    loop
      perform prive.notifier(new.organisation_id, u,
        '🛍️ Nouvelle commande en ligne : ' || prive.texte_commande(c) || E'\nLa gérante va l''affecter ; vous serez prévenu(e) si elle est pour vous.');
    end loop;
    return null;
  end if;

  -- Affectation : la caissière choisie.
  if new.caissier_id is not null and new.caissier_id is distinct from old.caissier_id then
    perform prive.notifier(new.organisation_id, new.caissier_id,
      '🧺 Commande affectée à vous : ' || prive.texte_commande(c) || E'\nOuvrez DF Gestion et touchez « Accepter », puis rassemblez les articles.');
  end if;

  -- Suivi pour la gérante principale (et la personne qui a affecté) : chaque étape.
  v_qui := coalesce(prive.nom_de(new.caissier_id), 'La caissière');
  v_txt := null;
  if new.prise_en_charge_le is not null and old.prise_en_charge_le is null then
    v_txt := '✅ ' || v_qui || ' a accepté la commande ' || c.numero || '.';
  end if;
  if new.statut is distinct from old.statut then
    v_txt := case new.statut
      when 'prete' then '📦 Commande prête : ' || prive.texte_commande(c)
                        || case when new.mode = 'livraison' then E'\nConfirmez l''envoi dans DF Gestion.' else E'\nLe client peut venir la retirer.' end
      when 'en_livraison' then '🛵 Commande partie en livraison : ' || c.numero || '.'
      when 'livree' then '🎉 Commande ' || c.numero || case when new.mode = 'livraison' then ' livrée' else ' remise au client' end
                         || ' et encaissée (' || replace(to_char(c.total, 'FM999G999G999'), ',', ' ') || ' FCFA).'
      when 'annulee' then '❌ Commande ' || c.numero || ' annulée' || coalesce(' : ' || nullif(btrim(c.motif), ''), '') || '.'
      else v_txt end;
  end if;
  if v_txt is not null then
    for u in
      select distinct x.user_id from (
        select m.user_id from public.membres m
         where m.organisation_id = new.organisation_id and m.actif and prive.permission_du_membre(m, 'boutique.administrer')
        union select new.affectee_par) x
       where x.user_id is not null and x.user_id is distinct from auth.uid() and x.user_id is distinct from new.caissier_id
    loop
      perform prive.notifier(new.organisation_id, u, v_txt);
    end loop;
  end if;
  return null;
end $$;


-- Message d'essai sur mon Telegram (au plus un par minute).
create or replace function public.mon_telegram_essai(p_org uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform prive.exiger(exists (select 1 from public.membres where organisation_id = p_org and user_id = auth.uid() and actif), 'Accès refusé');
  perform prive.exiger(exists (select 1 from prive.otp_membres where organisation_id = p_org and user_id = auth.uid() and actif and chat_id is not null),
                       'Votre Telegram n''est pas encore relié au robot');
  perform prive.exiger(not exists (select 1 from public.journal_audit where organisation_id = p_org and user_id = auth.uid()
                                      and action = 'notification.essai' and created_at > now() - interval '1 minute'),
                       'Patientez une minute avant un nouvel essai');
  perform prive.notifier(p_org, auth.uid(), '🔔 DF Gestion : vos notifications fonctionnent. Vous serez prévenu(e) ici des commandes en ligne.');
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
  values (p_org, auth.uid(), 'notification.essai', 'membres', auth.uid()::text);
  return true;
end $$;
revoke all on function public.mon_telegram_essai(uuid) from public, anon;
grant execute on function public.mon_telegram_essai(uuid) to authenticated;
