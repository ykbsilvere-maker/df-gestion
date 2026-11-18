// Fonction serveur « inscription » (Supabase Edge Function, Deno).
//
// Création d'un accès (nom, e-mail, mot de passe) depuis l'application, sans attendre d'e-mail
// de confirmation. Depuis la v3.14, quand l'inscription libre est fermée, une CLÉ D'ACCÈS
// personnelle (DFG-XXXX-XX, à usage unique, avec date d'expiration) est exigée : remise par la
// gérante principale (personne invitée) ou par l'administrateur général (futur gérant).
// La personne n'obtient AUCUN droit tant qu'elle n'est pas rattachée à une entreprise.
// Un quota horaire freine les créations en masse.
//
// Déploiement : Supabase > Edge Functions > « inscription », désactiver « Verify JWT ».

import { createClient } from 'npm:@supabase/supabase-js@2';

const ENTETES = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};
const reponse = (corps: Record<string, unknown>, statut = 200) =>
  new Response(JSON.stringify(corps), { status: statut, headers: ENTETES });

function cle(historique: string, dictionnaire: string): string | undefined {
  const v = Deno.env.get(historique);
  if (v) return v;
  try {
    const d = JSON.parse(Deno.env.get(dictionnaire) ?? '{}') as Record<string, string>;
    return d.default ?? Object.values(d)[0];
  } catch {
    return undefined;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: ENTETES });
  if (req.method !== 'POST') return reponse({ ok: false, message: 'Méthode non autorisée' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const secrete = cle('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS');
  if (!url || !secrete) return reponse({ ok: false, message: 'Fonction mal configurée (clés absentes)' }, 500);

  let corps: { email?: string; mot_de_passe?: string; nom?: string; cle?: string };
  try {
    corps = await req.json();
  } catch {
    return reponse({ ok: false, message: 'Requête illisible' }, 400);
  }
  const email = String(corps.email ?? '').trim().toLowerCase();
  const motDePasse = String(corps.mot_de_passe ?? '');
  const nom = String(corps.nom ?? '').trim().slice(0, 120);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email) || email.length > 200 || email.endsWith('@acces.dfgestion.app'))
    return reponse({ ok: false, message: 'Adresse e-mail invalide.' });
  if (motDePasse.length < 8 || motDePasse.length > 72) return reponse({ ok: false, message: 'Le mot de passe doit contenir au moins 8 caractères.' });
  if (nom.length < 2) return reponse({ ok: false, message: 'Indiquez vos nom et prénoms.' });

  const service = createClient(url, secrete, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: quota, error: eq } = await service.rpc('quota_inscriptions');
  if (eq) return reponse({ ok: false, message: 'Service indisponible, réessayez.' }, 500);
  if (quota !== true) return reponse({ ok: false, message: 'Beaucoup de demandes en ce moment : réessayez dans une heure.' });

  // Clé d'accès personnelle (exigée quand l'inscription libre est fermée).
  const { data: verif, error: ev } = await service.rpc('cle_inscription_verifier', { p_cle: String(corps.cle ?? ''), p_email: email });
  if (ev) return reponse({ ok: false, message: 'Service indisponible, réessayez.' }, 500);
  const v = (verif ?? {}) as { ok?: boolean; message?: string; cle_id?: string };
  if (!v.ok) return reponse({ ok: false, cle: true, message: v.message ?? 'Clé d’accès requise.' });

  const { data: cree, error } = await service.auth.admin.createUser({
    email,
    password: motDePasse,
    email_confirm: true,
    user_metadata: { nom_complet: nom },
  });
  if (error) {
    if (/already|registered|exists/i.test(error.message))
      return reponse({ ok: false, existe: true, message: 'Un compte existe déjà avec cette adresse : connectez-vous.' });
    return reponse({ ok: false, message: 'Création impossible, réessayez.' }, 500);
  }
  if (v.cle_id && cree?.user) await service.rpc('cle_inscription_utiliser', { p_cle_id: v.cle_id, p_user: cree.user.id });
  return reponse({ ok: true });
});
