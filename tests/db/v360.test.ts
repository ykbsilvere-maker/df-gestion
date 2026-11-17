import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, devenir, enTantQue, preparerBase, type Execution } from './helpers';

// 3.6 : paiement en ligne Mobile Money (Orange, Moov… sur les numéros de la boutique), vérification par la
// caissière pour un retrait, encaissement direct, reçu avec références ; ventes et arrivages sur DF Marché.
let pool: pg.Pool;
let alice: string; // gérante principale
let carine: string; // caissière
let org: string;
let mag: string;
let caisse: string;
let riz: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const anonyme = <R>(fn: (q: Execution) => Promise<R>) => enTantQue<R>(pool, null, fn);
const commande = (extra: object = {}) =>
  JSON.stringify({
    boutique: 'chez-alice', client_nom: 'Awa Koné', client_telephone: '05 05 05 05 05', mode: 'retrait', paiement: 'orange_money',
    numero_payeur: '0505050505', reference_paiement: 'MP231117.1234.A56789', lignes: [{ produit_id: riz, quantite: 2 }], ...extra,
  });

beforeAll(async () => {
  pool = await preparerBase('v360');
  alice = await creerCompte(pool, 'alice@paiement.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@paiement.ci', 'Carine');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Chez Alice') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    riz = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Riz 5 kg', 4500) returning id`, [org]))).id;
    const r = await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]));
    await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 20, 3800)`, [org, r.id, riz]);
    await q(`select public.valider_reception($1)`, [r.id]);
    await q(`select public.inviter_membre($1, 'carine@paiement.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
});
afterAll(async () => {
  await pool?.end();
});

describe('Paiement en ligne et reçu', () => {
  it('la vitrine n’accepte que ses numéros ; lien Wave contrôlé ; conditions publiées', async () => {
    const vitrine = {
      slug: 'chez-alice', nom: 'Chez Alice', magasin_id: mag, publiee: true, telephone: '0757657055', retrait: true, livraison: false, paiement_livraison: true,
      numero_orange: '07 57 65 70 55', numero_moov: '07 57 65 70 55', conditions: 'Échange sous 48 h avec le reçu.',
    };
    await enTantQue(pool, alice, async (q) => {
      await q('savepoint a');
      await expect(q(`select public.vitrine_enregistrer($1, $2)`, [org, JSON.stringify({ ...vitrine, lien_wave: 'https://exemple.com/payer' })])).rejects.toThrow(/lien Wave/);
      await q('rollback to savepoint a');
      await q(`select public.vitrine_enregistrer($1, $2)`, [org, JSON.stringify(vitrine)]);
      await q(`select public.publier_produits($1, $2, true)`, [org, [riz]]);
    });
    const b = await anonyme((q) => un(q<{ r: { numero_orange: string; numero_moov: string; numero_wave: string | null; conditions: string } }>(
      `select public.marche_boutique('chez-alice') r`)));
    expect(b.r.numero_orange).toBe('07 57 65 70 55');
    expect(b.r.numero_moov).toBe('07 57 65 70 55');
    expect(b.r.numero_wave).toBeNull();
    expect(b.r.conditions).toMatch(/48 h/);
    // Wave et Djamo ne sont pas proposés tant que la boutique n'a pas donné de numéro.
    await expect(anonyme((q) => q(`select public.passer_commande($1)`, [commande({ paiement: 'wave' })]))).rejects.toThrow(/pas proposé/);
    await expect(anonyme((q) => q(`select public.passer_commande($1)`, [commande({ paiement: 'djamo' })]))).rejects.toThrow(/pas proposé/);
  });

  it('le site montre l’arrivage du jour', async () => {
    const p = await anonyme((q) => un(q<{ r: { arrivage: string | null; vendus: number } }>(`select public.marche_produit($1) r`, [riz])));
    expect(p.r.arrivage).toBeTruthy();
    expect(Number(p.r.vendus)).toBe(0);
    const a = await anonyme((q) => un(q<{ r: { arrivages: unknown[] } }>(`select public.marche_accueil() r`)));
    expect(a.r.arrivages).toHaveLength(1);
  });

  it('retrait payé par Orange Money : la caissière vérifie, encaisse, le reçu porte les références', async () => {
    const c = (await anonyme((q) => un(q<{ r: { id: string; code_suivi: string } }>(`select public.passer_commande($1) r`, [commande()])))).r;
    const avant = await anonyme((q) => un(q<{ r: { paiement_statut: string; reference_paiement: string; boutique: { numero_paiement: string } } }>(
      `select public.marche_suivi($1) r`, [c.code_suivi])));
    expect(avant.r.paiement_statut).toBe('a_verifier');
    expect(avant.r.reference_paiement).toBe('MP231117.1234.A56789');
    expect(avant.r.boutique.numero_paiement).toBe('07 57 65 70 55');

    const vente = await enTantQue(pool, alice, async (q) => {
      const s = (await un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0, $3) id`, [org, caisse, carine]))).id;
      await devenir(q, carine);
      // Pas d'encaissement avant la vérification du paiement.
      await q('savepoint a');
      await expect(q(`select public.encaisser_commande_web($1, $2)`, [c.id, s])).rejects.toThrow(/pas encore confirmé/);
      await q('rollback to savepoint a');
      // La caissière confirme elle-même un retrait, sans passer par le responsable.
      await q(`select public.verifier_paiement_commande($1, true)`, [c.id]);
      return (await un(q<{ r: { id: string; numero: string; total: number } }>(`select public.encaisser_commande_web($1, $2) r`, [c.id, s]))).r;
    });
    expect(Number(vente.total)).toBe(9000);

    const apres = await anonyme((q) => un(q<{ r: { statut: string; paiement_statut: string; paiement_confirme_le: string; vente: string } }>(
      `select public.marche_suivi($1) r`, [c.code_suivi])));
    expect(apres.r.statut).toBe('livree');
    expect(apres.r.paiement_statut).toBe('confirme');
    expect(apres.r.paiement_confirme_le).toBeTruthy();
    expect(apres.r.vente).toBe(vente.numero);

    await enTantQue(pool, alice, async (q) => {
      const d = await un(q<{ r: { confirme_par: string; numero_boutique: string } }>(`select public.commande_web_detail($1) r`, [c.id]));
      expect(d.r.confirme_par).toBe('Carine');
      expect(d.r.numero_boutique).toBe('07 57 65 70 55');
      const reg = await un(q<{ libelle: string; reference: string }>(`select libelle, reference from reglements where vente_id = $1`, [vente.id]));
      expect(reg.libelle).toBe('Orange Money');
      expect(reg.reference).toBe('MP231117.1234.A56789');
    });
    // Les ventes de la caisse alimentent « X vendus ce mois » sur le site.
    const p = await anonyme((q) => un(q<{ r: { vendus: number } }>(`select public.marche_produit($1) r`, [riz])));
    expect(Number(p.r.vendus)).toBe(2);
  });
});
