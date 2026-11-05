-- =====================================================================
-- 1.3 : code d'entrée à 4 chiffres (comme Wave)
-- =====================================================================
-- Connexion des employés : code établissement + matricule + code d'entrée
-- de 4 chiffres. La fonction serveur « connexion » (clé secrète, côté
-- serveur uniquement) appelle public.connexion_pin puis ouvre la session.
-- Le même code déverrouille l'application après 5 minutes d'inactivité.
-- Protection : 5 erreurs => blocage 5 minutes ; 15 erreurs sans succès =>
-- code bloqué jusqu'à ce que le gérant en donne un nouveau.
-- Remplace le code de caisse séparé (prive.codes_caisse n'est plus utilisé).

create table prive.pins_acces (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  sel            text not null,
  empreinte      text not null,
  provisoire     boolean not null default true,
  essais         smallint not null default 0,
  echecs_cumules smallint not null default 0,
  bloque_jusqu   timestamptz,
  defini_le      timestamptz not null default now()
);

create function prive.pin_valide(p_pin text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_pin, '') ~ '^[0-9]{4}$'
     and p_pin !~ '^(\d)\1{3}$'
     and p_pin not in ('1234', '2345', '3456', '4567', '5678', '6789', '0123', '9876', '8765', '7654', '6543', '5432', '4321', '3210')
$$;

-- Vérifie un code et tient les compteurs. Résultat : ok, ou motif du refus.
create function prive.controler_pin(p_user uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare c prive.pins_acces;
begin
  select * into c from prive.pins_acces where user_id = p_user for update;
  if not found then
    return jsonb_build_object('ok', false, 'motif', 'sans_code',
      'message', 'Aucun code d''entrée : demandez-en un à votre gérant.');
  end if;
  if c.echecs_cumules >= 15 then
    return jsonb_build_object('ok', false, 'motif', 'bloque',
      'message', 'Code bloqué après trop d''erreurs : demandez un nouveau code à votre gérant.');
  end if;
  if c.bloque_jusqu is not null and c.bloque_jusqu > now() then
    return jsonb_build_object('ok', false, 'motif', 'attente', 'bloque_jusqu', c.bloque_jusqu,
      'message', 'Trop d''essais : réessayez dans quelques minutes.');
  end if;
  if prive.empreinte_code(c.sel, coalesce(p_pin, '')) = c.empreinte then
    update prive.pins_acces set essais = 0, echecs_cumules = 0, bloque_jusqu = null where user_id = p_user;
    return jsonb_build_object('ok', true, 'provisoire', c.provisoire);
  end if;
  update prive.pins_acces
     set essais = case when essais + 1 >= 5 then 0 else essais + 1 end,
         echecs_cumules = echecs_cumules + 1,
         bloque_jusqu = case when essais + 1 >= 5 then now() + interval '5 minutes' end
   where user_id = p_user
  returning * into c;
  return jsonb_build_object('ok', false, 'motif', 'incorrect',
    'essais_restants', case when c.bloque_jusqu is null then 5 - c.essais else 0 end,
    'bloque_jusqu', c.bloque_jusqu,
    'message', case when c.echecs_cumules >= 15 then 'Code bloqué : demandez un nouveau code à votre gérant.'
                    when c.bloque_jusqu is not null then 'Code incorrect. Trop d''essais : patientez 5 minutes.'
                    else 'Code incorrect.' end);
end $$;

create function prive.enregistrer_pin(p_user uuid, p_pin text, p_provisoire boolean) returns void
language plpgsql security definer set search_path = '' as $$
declare v_sel text := replace(gen_random_uuid()::text, '-', '');
begin
  perform prive.exiger(prive.pin_valide(p_pin),
    'Le code d''entrée fait 4 chiffres, sans chiffres tous identiques ni suite (1234, 4321…)');
  insert into prive.pins_acces (user_id, sel, empreinte, provisoire)
  values (p_user, v_sel, prive.empreinte_code(v_sel, p_pin), p_provisoire)
  on conflict (user_id) do update set sel = excluded.sel, empreinte = excluded.empreinte, provisoire = excluded.provisoire,
    essais = 0, echecs_cumules = 0, bloque_jusqu = null, defini_le = now();
end $$;

-- Connexion (appelée UNIQUEMENT par la fonction serveur « connexion », clé secrète).
create function public.connexion_pin(p_code text, p_matricule text, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  o public.organisations;
  v_email text;
  v_user uuid;
  r jsonb;
  v_generique constant text := 'Code établissement, matricule ou code d''entrée incorrect.';
begin
  select * into o from public.organisations where code_acces = upper(btrim(coalesce(p_code, '')));
  if not found or btrim(coalesce(p_matricule, '')) !~ '^[A-Za-z0-9-]{1,12}$' then
    return jsonb_build_object('ok', false, 'message', v_generique);
  end if;
  if not o.actif then
    return jsonb_build_object('ok', false, 'message', 'Cet établissement est suspendu : contactez Décodeur Financier.');
  end if;
  v_email := prive.email_employe(o.code_acces, p_matricule);
  select id into v_user from auth.users where lower(email) = v_email;
  if v_user is null then return jsonb_build_object('ok', false, 'message', v_generique); end if;
  if exists (select 1 from public.membres where user_id = v_user and organisation_id = o.id and not actif) then
    return jsonb_build_object('ok', false, 'message', 'Votre accès a été désactivé par votre gérant.');
  end if;
  r := prive.controler_pin(v_user, p_pin);
  if (r ->> 'ok')::boolean then
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
    values (o.id, v_user, 'connexion.code_entree', 'utilisateur', v_email);
    return r || jsonb_build_object('email', v_email);
  end if;
  if r ->> 'motif' = 'incorrect' and (r ->> 'essais_restants')::int <= 2 then
    insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
    values (o.id, v_user, 'connexion.code_entree_refuse', 'utilisateur', v_email);
  end if;
  return r;
end $$;

-- Le gérant donne (ou redonne) un code provisoire à un employé.
create function public.definir_pin_employe(p_org uuid, p_matricule text, p_pin text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
  v_email text;
  v_user uuid;
begin
  perform prive.exiger(prive.a_permission(p_org, 'utilisateurs.creer') or prive.a_permission(p_org, 'utilisateurs.modifier'),
                       'Droit « utilisateurs.modifier » requis');
  select code_acces into v_code from public.organisations where id = p_org;
  v_email := prive.email_employe(v_code, p_matricule);
  select id into v_user from auth.users where lower(email) = v_email;
  perform prive.exiger(v_user is not null, 'Aucun accès pour ce matricule : créez-le d''abord');
  perform prive.exiger(v_user <> auth.uid(), 'Changez votre propre code depuis « Mon compte »');
  perform prive.exiger(
    exists (select 1 from public.membres where user_id = v_user and organisation_id = p_org)
    or exists (select 1 from public.invitations where email = v_email and organisation_id = p_org and statut <> 'annulee'),
    'Ce matricule n''appartient pas à votre entreprise');
  perform prive.enregistrer_pin(v_user, p_pin, true);
  insert into public.journal_audit (organisation_id, user_id, action, objet_type, objet_id)
  values (p_org, auth.uid(), 'utilisateurs.code_entree_donne', 'utilisateur', v_email);
end $$;

-- Chacun choisit son code (obligatoire après un code provisoire ; l'ancien est demandé sinon).
create function public.changer_mon_pin(p_nouveau text, p_ancien text default null) returns void
language plpgsql security definer set search_path = '' as $$
declare c prive.pins_acces;
begin
  perform prive.exiger(auth.uid() is not null, 'Connexion requise');
  select * into c from prive.pins_acces where user_id = auth.uid();
  if found and not c.provisoire then
    perform prive.exiger(p_ancien is not null and prive.empreinte_code(c.sel, p_ancien) = c.empreinte, 'Ancien code incorrect');
  end if;
  perform prive.enregistrer_pin(auth.uid(), p_nouveau, false);
end $$;

create function public.mon_pin() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('defini', c.user_id is not null, 'provisoire', coalesce(c.provisoire, false))
  from (select 1) x left join prive.pins_acces c on c.user_id = auth.uid()
$$;

-- Déverrouillage après inactivité (session encore ouverte).
create function public.verifier_mon_pin(p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform prive.exiger(auth.uid() is not null, 'Connexion requise');
  return prive.controler_pin(auth.uid(), p_pin);
end $$;

revoke all on table prive.pins_acces from public, anon, authenticated;
revoke all on function prive.pin_valide(text), prive.controler_pin(uuid, text), prive.enregistrer_pin(uuid, text, boolean)
  from public, anon, authenticated;
revoke all on function public.connexion_pin(text, text, text) from public, anon, authenticated;
grant execute on function public.connexion_pin(text, text, text) to service_role;
revoke all on function public.definir_pin_employe(uuid, text, text), public.changer_mon_pin(text, text), public.mon_pin(),
  public.verifier_mon_pin(text) from public, anon;
grant execute on function public.definir_pin_employe(uuid, text, text), public.changer_mon_pin(text, text), public.mon_pin(),
  public.verifier_mon_pin(text) to authenticated;
