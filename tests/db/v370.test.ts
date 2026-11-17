import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, devenir, enTantQue, preparerBase, type Execution } from './helpers';

// 3.7 : moyens de paiement ajoutés par la boutique (nom + numéro) et galerie de photos des produits.
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
  pool = await preparerBase('v370');
  alice = await creerCompte(pool, 'alice@galerie.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@galerie.ci', 'Carine');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Chez Alice') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    riz = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Riz 5 kg', 4500) returning id`, [org]))).id;
    const r = await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]));
    await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 20, 3800)`, [org, r.id, riz]);
    await q(`select public.valider_reception($1)`, [r.id]);
    await q(`select public.inviter_membre($1, 'carine@galerie.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
});
afterAll(async () => {
  await pool?.end();
});

describe('Moyens de paiement ajoutés et galerie', () => {
  it('la boutique ajoute un moyen ; le client paie avec ; la caisse encaisse avec la référence', async () => {
    const vitrine = {
      slug: 'chez-alice', nom: 'Chez Alice', magasin_id: mag, publiee: true, telephone: '0757657055', retrait: true, livraison: false,
      paiement_livraison: true, numero_wave: '07 57 65 70 55', numero_orange: '07 57 65 70 55',
      autres_paiements: [{ libelle: 'MTN MoMo', numero: '05 44 33 22 11' }],
    };
    await enTantQue(pool, alice, async (q) => {
      await q('savepoint a');
      await expect(q(`select public.vitrine_enregistrer($1, $2)`, [org, JSON.stringify({ ...vitrine, autres_paiements: [{ libelle: 'x', numero: '12' }] })]))
        .rejects.toThrow(/Moyen de paiement ajouté/);
      await q('rollback to savepoint a');
      await q(`select public.vitrine_enregistrer($1, $2)`, [org, JSON.stringify(vitrine)]);
      await q(`select public.publier_produits($1, $2, true)`, [org, [riz]]);
    });
    const b = await anonyme((q) => un(q<{ r: { autres_paiements: { id: string; libelle: string; numero: string }[] } }>(`select public.marche_boutique('chez-alice') r`)));
    expect(b.r.autres_paiements).toHaveLength(1);
    const autre = b.r.autres_paiements[0]!;
    expect(autre.libelle).toBe('MTN MoMo');
    await expect(anonyme((q) => q(`select public.passer_commande($1)`, [commande({ paiement: 'autre', paiement_autre: 'inconnu' })]))).rejects.toThrow(/pas proposé/);
    const c = (await anonyme((q) => un(q<{ r: { id: string; code_suivi: string } }>(`select public.passer_commande($1) r`, [commande({ paiement: 'autre', paiement_autre: autre.id })])))).r;
    const suivi = await anonyme((q) => un(q<{ r: { paiement_libelle: string; boutique: { numero_paiement: string } } }>(`select public.marche_suivi($1) r`, [c.code_suivi])));
    expect(suivi.r.paiement_libelle).toBe('MTN MoMo');
    expect(suivi.r.boutique.numero_paiement).toBe('05 44 33 22 11');
    await enTantQue(pool, alice, async (q) => {
      const s = (await un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0, $3) id`, [org, caisse, carine]))).id;
      await devenir(q, carine);
      await q(`select public.verifier_paiement_commande($1, true)`, [c.id]);
      const moyen = (await un(q<{ id: string }>(`select id from moyens_paiement where organisation_id = $1 and code = 'mtn_momo'`, [org]))).id;
      const v = (await un(q<{ r: { id: string } }>(`select public.encaisser_commande_web($1, $2, $3) r`, [c.id, s, moyen]))).r;
      const reg = await un(q<{ reference: string }>(`select reference from reglements where vente_id = $1`, [v.id]));
      expect(reg.reference).toBe('MP231117.1234.A56789');
    });
  });

  it('les photos de la galerie d’un produit publié sont visibles sur le site', async () => {
    await enTantQue(pool, alice, (q) => q(`update produits set photos = array[$1 || '/g1.jpg', $1 || '/g2.jpg'] where id = $2`, [org, riz]));
    const p = await anonyme((q) => un(q<{ r: { photos: string[] } }>(`select public.marche_produit($1) r`, [riz])));
    expect(p.r.photos).toEqual([`${org}/g1.jpg`, `${org}/g2.jpg`]);
    const vus = await un(pool.query(`select prive.photo_publique($1) a, prive.photo_publique($2) b`, [`${org}/g2.jpg`, `${org}/autre.jpg`]).then((r) => r.rows as { a: boolean; b: boolean }[]));
    expect(vus).toEqual({ a: true, b: false });
  });
});
