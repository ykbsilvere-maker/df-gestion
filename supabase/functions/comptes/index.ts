// Fonction serveur « comptes » (Supabase Edge Function, Deno).
//
// Crée l'accès d'une personne invitée avec un mot de passe provisoire, ou
// réinitialise le mot de passe d'une personne placée sous la responsabilité
// de l'appelant. Aucun e-mail n'est envoyé.
//
// Sécurité : c'est la base qui décide. La fonction interroge d'abord la base
// AVEC LE JETON DE L'APPELANT (controle_creation_compte / controle_reinitialisation) ;
// elle n'utilise la clé secrète de service que si la base a répondu « ok ».
//
// Déploiement sans ligne de commande : Supabase > Edge Functions > Deploy a new
// function > Via Editor, nom « comptes », coller ce fichier, Deploy.

import { createClient } from 'npm:@supabase/supabase-js@2';

const ENTETES = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

const reponse = (corps: Record<string, unknown>, statut = 200) =>
  new Response(JSON.stringify(corps), { status: statut, headers: ENTETES });

/** Clé d'environnement : variable historique, sinon première clé du dictionnaire JSON récent. */
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

/** Identifiant de l'appelant, lu dans son jeton (déjà vérifié par la base lors du contrôle). */
function appelantDe(autorisation: string): string | null {
  try {
    const charge = autorisation.replace(/^Bearer\s+/i, '').split('.')[1] ?? '';
    const json = atob(charge.replace(/-/g, '+').replace(/_/g, '/'));
    return (JSON.parse(json) as { sub?: string }).sub ?? null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: ENTETES });
  if (req.method !== 'POST') return reponse({ ok: false, erreur: 'Méthode non autorisée' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const publique = cle('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEYS');
  const secrete = cle('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS');
  if (!url || !publique || !secrete) return reponse({ ok: false, erreur: 'Fonction mal configurée (clés absentes)' }, 500);

  const autorisation = req.headers.get('Authorization') ?? '';
  if (!autorisation) return reponse({ ok: false, erreur: 'Connexion requise' }, 401);

  let corps: { action?: string; email?: string; mot_de_passe?: string; nom?: string };
  try {
    corps = await req.json();
  } catch {
    return reponse({ ok: false, erreur: 'Requête illisible' }, 400);
  }
  const email = String(corps.email ?? '').trim().toLowerCase();
  const motDePasse = String(corps.mot_de_passe ?? '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reponse({ ok: false, erreur: 'Adresse e-mail invalide' });
  // Employés connectés par matricule : ils entrent avec leur code d'entrée ; autres comptes : 8 caractères.
  const employe = email.endsWith('@acces.dfgestion.app');
  if (!employe && motDePasse.length < 8)
    return reponse({ ok: false, erreur: 'Le mot de passe provisoire doit contenir au moins 8 caractères' });

  const appelant = createClient(url, publique, {
    global: { headers: { Authorization: autorisation } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const service = createClient(url, secrete, { auth: { persistSession: false, autoRefreshToken: false } });

  const action = corps.action === 'reinitialiser' ? 'reinitialiser' : corps.action === 'creer' ? 'creer' : null;
  if (!action) return reponse({ ok: false, erreur: 'Action inconnue' }, 400);

  const { data: controle, error: erreurControle } = await appelant.rpc(
    action === 'creer' ? 'controle_creation_compte' : 'controle_reinitialisation',
    { p_email: email },
  );
  if (erreurControle) return reponse({ ok: false, erreur: erreurControle.message }, 403);
  const c = controle as { statut: string; message?: string; user_id?: string; organisations?: string[] };
  if (c.statut !== 'ok') return reponse({ ok: false, statut: c.statut, erreur: c.message ?? 'Refusé' });

  // Employé par matricule : il se connecte avec son code d'entrée (4 chiffres) ; son mot de passe technique
  // est long, aléatoire et jamais montré.
  const motDePasseFinal = employe
    ? Array.from(crypto.getRandomValues(new Uint8Array(24)), (o) => o.toString(16).padStart(2, '0')).join('')
    : motDePasse;

  if (action === 'creer') {
    const { error } = await service.auth.admin.createUser({
      email,
      password: motDePasseFinal,
      email_confirm: true,
      user_metadata: { nom_complet: String(corps.nom ?? '').trim() || null, mdp_provisoire: !employe },
    });
    if (error) return reponse({ ok: false, erreur: error.message });
  } else {
    const { error } = await service.auth.admin.updateUserById(c.user_id!, {
      password: motDePasseFinal,
      user_metadata: { mdp_provisoire: !employe },
    });
    if (error) return reponse({ ok: false, erreur: error.message });
  }

  // Trace dans le journal de chaque entreprise concernée (sans le mot de passe).
  const auteur = appelantDe(autorisation);
  const lignes = (c.organisations ?? []).map((organisation_id) => ({
    organisation_id,
    user_id: auteur,
    action: action === 'creer' ? 'compte.acces_cree' : 'compte.mot_de_passe_reinitialise',
    objet_type: 'utilisateur',
    objet_id: email,
  }));
  if (lignes.length) await service.from('journal_audit').insert(lignes);

  return reponse({
    ok: true,
    message:
      action === 'creer'
        ? 'Accès créé : la personne se connecte avec ce mot de passe provisoire et en choisit un nouveau.'
        : 'Mot de passe réinitialisé : la personne en choisira un nouveau à sa prochaine connexion.',
  });
});
