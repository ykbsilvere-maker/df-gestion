-- v3.11 — Annulation d'une opération de caisse par le gérant principal.
--
-- Avant : une vente ne pouvait être annulée que tant que sa session de caisse
-- était ouverte. Une erreur découverte après la clôture obligeait à saisir un
-- retour à la main.
--
-- Désormais :
--   * session ouverte  → inchangé : droit « ventes.annuler » ;
--   * session clôturée → réservé au gérant principal (droit « ventes.administrer »,
--     propriétaire par défaut). Les articles reviennent en stock, les règlements
--     sont annulés, puis les totaux de la session (espèces attendues, écart, Z)
--     sont recalculés pour que la liquidité reste juste. La comptabilité suit
--     d'elle-même (régénération ; extourne si le mois est déjà clôturé).
--   * une vente qui règle une commande en ligne ne s'annule pas ici : la commande
--     a sa propre fiche.

create or replace function public.annuler_vente(p_vente uuid, p_motif text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.ventes;
  s public.sessions_caisse;
  m record;
  t jsonb;
  v_cmd text;
  v_avant jsonb;
begin
  select * into v from public.ventes where id = p_vente for update;
  perform prive.exiger(found, 'Vente introuvable');
  perform prive.exiger(prive.a_permission(v.organisation_id, 'ventes.annuler') and prive.acces_magasin(v.organisation_id, v.magasin_id),
                       'Droit « ventes.annuler » requis');
  perform prive.exiger(v.statut = 'validee', 'Cette vente est déjà annulée');
  perform prive.exiger(length(btrim(coalesce(p_motif, ''))) >= 3, 'Un motif d''annulation est obligatoire');
  select * into s from public.sessions_caisse where id = v.session_id for update;
  perform prive.exiger(s.statut = 'ouverte' or prive.a_permission(v.organisation_id, 'ventes.administrer'),
                       'La caisse de cette vente est clôturée : seul le gérant principal peut l''annuler');
  select numero into v_cmd from public.commandes_web where vente_id = v.id limit 1;
  perform prive.exiger(v_cmd is null,
                       'Cette vente règle la commande en ligne ' || coalesce(v_cmd, '') || ' : traitez-la depuis la fiche de la commande');

  for m in select * from public.mouvements_stock where piece_type = 'vente' and piece_id = v.id and type = 'vente' loop
    insert into public.mouvements_stock (organisation_id, magasin_id, produit_id, lot_id, type, quantite, cout_unitaire,
                                         motif, piece_type, piece_id)
    values (m.organisation_id, m.magasin_id, m.produit_id, m.lot_id, 'retour_client', -m.quantite, m.cout_unitaire,
            'Annulation ' || v.numero, 'vente', v.id);
  end loop;
  update public.reglements set statut = 'annule' where vente_id = v.id;
  update public.creances set statut = 'annulee', motif_annulation = left('Annulation ' || v.numero || ' : ' || btrim(p_motif), 300)
   where vente_id = v.id and statut = 'ouverte';
  update public.ventes set statut = 'annulee', annulee_par = auth.uid(), annulee_le = now(), motif_annulation = btrim(p_motif)
   where id = v.id;

  if s.statut = 'cloturee' then
    -- La liquidité de la session est recalculée : l'argent de la vente annulée
    -- n'est plus attendu au tiroir, l'écart de clôture est mis à jour.
    v_avant := jsonb_build_object('especes_attendues', s.especes_attendues, 'ecart', s.ecart);
    t := prive.calculer_totaux_session(s.id);
    perform set_config('app.motif', 'Annulation ' || v.numero || ' après clôture : ' || btrim(p_motif), true);
    update public.sessions_caisse
       set totaux = t,
           especes_attendues = (t ->> 'especes_attendues')::bigint,
           ecart = coalesce(especes_comptees, 0) - (t ->> 'especes_attendues')::bigint
     where id = s.id;
    perform set_config('app.motif', '', true);
  end if;

  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id, contexte)
  values (v.organisation_id, auth.uid(),
          case when s.statut = 'cloturee' then 'ventes.annulation_apres_cloture' else 'ventes.annulation' end,
          'ventes', v.id::text,
          jsonb_build_object('motif', btrim(p_motif), 'numero', v.numero, 'total', v.total, 'session', s.id,
                             'numero_z', s.numero_z, 'avant', v_avant));
end $$;

-- Mouvements stock de type « retour_client » rattachés à une vente : déjà
-- admis hors journée par prive.tg_exiger_journee (couverts par la caisse).
