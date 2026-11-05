// Test de la fonction serveur « comptes » (supabase/functions/comptes) à travers
// supabase-js, comme l'application l'appelle.
// Prérequis : serveur simulé Supabase (auth + /rest/v1 + /functions/v1) sur API_URL,
// fonction lancée avec Deno et branchée sur ce serveur.
import { createClient } from '@supabase/supabase-js';

const API = process.env.API_URL ?? 'http://localhost:4800';
const s = Date.now();
let echecs = 0;
async function etape(nom, fn) {
  try {
    await fn();
    console.log(`  ✓ ${nom}`);
  } catch (e) {
    echecs++;
    console.log(`  ✗ ${nom} — ${e.message}`);
  }
}
const verifier = (c, m) => { if (!c) throw new Error(m); };
const sans = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
const client = () => createClient(API, 'cle-anon-e2e', { auth: { persistSession: false, autoRefreshToken: false } });

async function inscrire(email, mdp = 'motdepasse123') {
  const c = client();
  sans(await c.auth.signUp({ email, password: mdp }));
  return c;
}
async function connecter(email, mdp) {
  const c = client();
  const { error } = await c.auth.signInWithPassword({ email, password: mdp });
  return error ? null : c;
}
const appeler = async (c, corps) => sans(await c.functions.invoke('comptes', { body: corps }));

const admin = await inscrire(`admin.${s}@df.ci`);
const gerant = `gerant.${s}@boutique.ci`;
const caissier = `caissier.${s}@boutique.ci`;
let org, g, k;

console.log('Fonction « comptes »');
await etape('l’administrateur général crée l’entreprise puis l’accès du gérant (mot de passe provisoire)', async () => {
  const info = sans(await admin.rpc('plateforme_info'));
  if (!info.admin_existe) sans(await admin.rpc('devenir_admin_general'));
  verifier(sans(await admin.rpc('plateforme_info')).je_suis_admin, 'pas administrateur');
  org = sans(await admin.rpc('admin_creer_entreprise', { p_nom: `Boutique ${s}`, p_gerant_email: gerant }));
  const r = await appeler(admin, { action: 'creer', email: gerant, mot_de_passe: 'Provisoire-2026', nom: 'Awa Koné' });
  verifier(r.ok === true, JSON.stringify(r));
});
await etape('le gérant se connecte avec le mot de passe provisoire et devient propriétaire', async () => {
  g = await connecter(gerant, 'Provisoire-2026');
  verifier(g, 'connexion refusée');
  const { data: u } = await g.auth.getUser();
  verifier(u.user.user_metadata.mdp_provisoire === true, JSON.stringify(u.user.user_metadata));
  sans(await g.rpc('accepter_invitations'));
  const orgs = sans(await g.rpc('mes_organisations'));
  verifier(orgs.length === 1 && orgs[0].role_code === 'proprietaire', JSON.stringify(orgs));
});
await etape('il choisit son mot de passe : l’indicateur « provisoire » disparaît', async () => {
  sans(await g.auth.updateUser({ password: 'MonVraiMotDePasse', data: { mdp_provisoire: false } }));
  verifier(await connecter(gerant, 'MonVraiMotDePasse'), 'nouveau mot de passe refusé');
  verifier(!(await connecter(gerant, 'Provisoire-2026')), 'ancien mot de passe encore accepté');
});
await etape('créer deux fois le même accès : refus explicite', async () => {
  const r = await appeler(admin, { action: 'creer', email: gerant, mot_de_passe: 'Autre-motdepasse' });
  verifier(r.ok === false && r.statut === 'existe', JSON.stringify(r));
});
await etape('le gérant crée l’accès de son caissier', async () => {
  sans(await g.rpc('inviter_membre', { p_org: org, p_email: caissier, p_role: 'caissier', p_tous_magasins: true, p_magasins: [], p_caisses: [] }));
  const r = await appeler(g, { action: 'creer', email: caissier, mot_de_passe: 'Caisse-0001', nom: 'Koffi' });
  verifier(r.ok, JSON.stringify(r));
  k = await connecter(caissier, 'Caisse-0001');
  verifier(k, 'caissier non connecté');
  sans(await k.rpc('accepter_invitations'));
});
await etape('un compte quelconque ne peut créer aucun accès', async () => {
  const intrus = await inscrire(`intrus.${s}@x.ci`);
  sans(await g.rpc('inviter_membre', { p_org: org, p_email: `autre.${s}@boutique.ci`, p_role: 'vendeur', p_tous_magasins: true, p_magasins: [], p_caisses: [] }));
  const r = await appeler(intrus, { action: 'creer', email: `autre.${s}@boutique.ci`, mot_de_passe: 'Pirate-123' });
  verifier(r.ok === false && r.statut === 'refuse', JSON.stringify(r));
  verifier(!(await connecter(`autre.${s}@boutique.ci`, 'Pirate-123')), 'le compte a été créé');
});
await etape('réinitialisation : le gérant pour son caissier ; pas l’inverse', async () => {
  const r = await appeler(g, { action: 'reinitialiser', email: caissier, mot_de_passe: 'Nouveau-0002' });
  verifier(r.ok, JSON.stringify(r));
  verifier(await connecter(caissier, 'Nouveau-0002'), 'nouveau mot de passe refusé');
  verifier(!(await connecter(caissier, 'Caisse-0001')), 'ancien mot de passe encore accepté');
  const r2 = await appeler(k, { action: 'reinitialiser', email: gerant, mot_de_passe: 'Pirate-0003' });
  verifier(r2.ok === false, JSON.stringify(r2));
});
await etape('mot de passe trop court ou appel sans connexion : refusés', async () => {
  const r = await appeler(admin, { action: 'creer', email: `x.${s}@x.ci`, mot_de_passe: 'court' });
  verifier(r.ok === false && /8 caractères/.test(r.erreur), JSON.stringify(r));
  const res = await fetch(`${API}/functions/v1/comptes`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  verifier(res.status === 401, `statut ${res.status}`);
});
await etape('chaque création et réinitialisation est inscrite au journal, sans mot de passe', async () => {
  const lignes = sans(await admin.from('journal_audit').select('action, objet_id, user_id, apres, contexte').eq('organisation_id', org).like('action', 'compte.%').order('id'));
  verifier(lignes.map((l) => l.action).join() === 'compte.acces_cree,compte.acces_cree,compte.mot_de_passe_reinitialise', JSON.stringify(lignes));
  verifier(!JSON.stringify(lignes).match(/Provisoire|Caisse-0001|Nouveau-0002/), 'mot de passe dans le journal');
});

console.log(echecs ? `\n${echecs} échec(s)` : '\nLa fonction « comptes » se comporte comme prévu.');
process.exit(echecs ? 1 : 0);
