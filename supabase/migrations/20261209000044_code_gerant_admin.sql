-- 3.17 — L'administrateur général redonne un code d'entrée provisoire au gérant principal
-- (connexion « code établissement + matricule 0000 + code »), sans passer par l'e-mail.
-- Le gérant le remplace par le sien à la connexion suivante (code provisoire).

create or replace function public.admin_definir_pin_gerant(p_org uuid, p_email text, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
  v_code text;
begin
  perform prive.exiger(prive.est_admin_general(), 'Réservé à l''administrateur général');
  select code_acces into v_code from public.organisations where id = p_org;
  perform prive.exiger(v_code is not null, 'Entreprise introuvable');
  select u.id into v_user
    from public.membres m join auth.users u on u.id = m.user_id
   where m.organisation_id = p_org and m.role_code = 'proprietaire' and m.actif
     and lower(u.email) = lower(btrim(coalesce(p_email, '')));
  perform prive.exiger(v_user is not null, 'Ce compte n''est pas gérant principal actif de cette entreprise');
  perform prive.enregistrer_pin(v_user, p_pin, true);
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
  values (p_org, auth.uid(), 'admin.code_entree_gerant', 'utilisateur', lower(btrim(p_email)));
  return jsonb_build_object('code_acces', v_code, 'matricule', '0000');
end $$;

revoke all on function public.admin_definir_pin_gerant(uuid, text, text) from public, anon;
grant execute on function public.admin_definir_pin_gerant(uuid, text, text) to authenticated;
