// Fonction serveur « connexion » (Supabase Edge Function, Deno).
//
// Connexion d'un employé avec code établissement + matricule + code d'entrée
// de 4 chiffres. La base vérifie le code et tient les compteurs d'essais
// (public.connexion_pin, exécutable seulement avec la clé secrète). Si le code
// est bon, la fonction ouvre une session pour cet employé et renvoie ses jetons.
// La clé secrète ne quitte jamais le serveur.
//
// Déploiement sans ligne de commande : Supabase > Edge Functions > Deploy a new
// function > Via Editor, nom « connexion », coller ce fichier, désactiver
// « Verify JWT » (la personne n'est pas encore connectée), Deploy.

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
  const publique = cle('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEYS');
  const secrete = cle('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS');
  if (!url || !publique || !secrete) return reponse({ ok: false, message: 'Fonction mal configurée (clés absentes)' }, 500);

  let corps: { code?: string; matricule?: string; pin?: string };
  try {
    corps = await req.json();
  } catch {
    return reponse({ ok: false, message: 'Requête illisible' }, 400);
  }
  const code = String(corps.code ?? '').trim().toUpperCase();
  const matricule = String(corps.matricule ?? '').trim();
  const pin = String(corps.pin ?? '');
  if (!/^[A-Z0-9]{4,10}$/.test(code) || !/^[A-Za-z0-9-]{1,12}$/.test(matricule) || !/^\d{4}$/.test(pin))
    return reponse({ ok: false, message: 'Code établissement, matricule ou code d’entrée incorrect.' });

  const service = createClient(url, secrete, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await service.rpc('connexion_pin', { p_code: code, p_matricule: matricule, p_pin: pin });
  if (error) return reponse({ ok: false, message: 'Service indisponible, réessayez.' }, 500);
  const r = data as { ok: boolean; email?: string; provisoire?: boolean; message?: string; bloque_jusqu?: string; essais_restants?: number };
  if (!r.ok || !r.email) return reponse({ ok: false, message: r.message, bloque_jusqu: r.bloque_jusqu, essais_restants: r.essais_restants });

  // Session de l'employé : lien de connexion généré côté serveur (aucun e-mail envoyé), échangé aussitôt.
  const { data: lien, error: e1 } = await service.auth.admin.generateLink({ type: 'magiclink', email: r.email });
  const jeton = lien?.properties?.hashed_token;
  if (e1 || !jeton) return reponse({ ok: false, message: 'Ouverture de session impossible, réessayez.' }, 500);
  const anonyme = createClient(url, publique, { auth: { persistSession: false, autoRefreshToken: false } });
  let { data: s, error: e2 } = await anonyme.auth.verifyOtp({ type: 'magiclink', token_hash: jeton });
  if (e2 || !s.session) ({ data: s, error: e2 } = await anonyme.auth.verifyOtp({ type: 'email', token_hash: jeton }));
  if (e2 || !s.session) return reponse({ ok: false, message: 'Ouverture de session impossible, réessayez.' }, 500);

  return reponse({
    ok: true,
    provisoire: !!r.provisoire,
    access_token: s.session.access_token,
    refresh_token: s.session.refresh_token,
  });
});
