-- 2.9 — Piste d'audit complète : en plus des opérations sur les données (déjà tracées par la base),
-- l'application consigne l'activité de chaque personne : module ouvert, fenêtre fermée,
-- impression, export, verrouillage. Seules des actions « activite.* » peuvent être écrites ainsi,
-- par un membre de l'entreprise, sous son propre nom ; le journal reste non modifiable.
create function public.tracer(p_org uuid, p_action text, p_contexte jsonb default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.exiger(auth.uid() is not null and prive.est_membre(p_org), 'Accès refusé');
  perform prive.exiger(p_action ~ '^activite\.[a-z_]{2,40}$', 'Action inconnue');
  -- Garde-fou : au plus 400 traces d'activité par personne et par heure.
  if (select count(*) from public.journal_audit
       where organisation_id = p_org and user_id = auth.uid() and action like 'activite.%'
         and created_at > now() - interval '1 hour') >= 400 then
    return;
  end if;
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, contexte)
  values (p_org, auth.uid(), p_action, 'activite',
          case when p_contexte is not null and jsonb_typeof(p_contexte) = 'object' and length(p_contexte::text) <= 1500 then p_contexte end);
end $$;
revoke all on function public.tracer(uuid, text, jsonb) from public, anon;
grant execute on function public.tracer(uuid, text, jsonb) to authenticated;
