import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, devenir, enTantQue, preparerBase, type Execution } from './helpers';

// 3.8 : comptes clients DF Marché, codes promo (pour tous ou pour un compte), espèces avec monnaie à préparer.
let pool: pg.Pool;
let alice: string; // gérante principale
let carine: string; // caissière
let org: string;
let mag: string;
let caisse: string;
let riz: string;
let awa: string; // cliente du site
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const anonyme = <R>(fn: (q: Execution) => Promise<R>) => enTantQue<R>(pool, null, fn);

beforeAll(async () => {
  pool = await preparerBase('v380');
  alice = await creerCompte(pool, 'alice@promo.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@promo.ci', 'Carine');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Chez Alice') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    riz = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Riz 5 kg', 4500) returning id`, [org]))).id;
    const r = await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]));
    await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 20, 3800)`, [org, r.id, riz]);
    await q(`select public.valider_reception($1)`, [r.id]);
    await q(`select public.inviter_membre($1, 'carine@promo.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
  awa = await creerCompte(pool, 'awa@client.ci', '');
  await enTantQue(pool, alice, async (q) => {
    await q(`select public.vitrine_enregistrer($1, $2)`, [org, JSON.stringify({
      slug: 'chez-alice', nom: 'Chez Alice', magasin_id: mag, publiee: true, telephone: '0757657055', retrait: true, livraison: false,
      paiement_livraison: true, numero_wave: '07 57 65 70 55', numero_orange: '07 57 65 70 55',
    })]);
    await q(`select public.publier_produits($1, $2, true)`, [org, [riz]]);
  });
});
afterAll(async () => {
  await pool?.end();
});

describe('Comptes clients et codes promo', () => {
  it('le client crée son compte ; la boutique lui réserve un code ; un code public est visible de tous', async () => {
    const c = await enTantQue(pool, awa, (q) => un(q<{ r: { email: string; nom: string } }>(
      `select public.compte_marche_enregistrer('{"nom":"Awa Koné","telephone":"05 05 05 05 05"}') r`)));
    expect(c.r.email).toBe('awa@client.ci');
    await enTantQue(pool, alice, async (q) => {
      await q(`select public.code_promo_enregistrer($1, '{"code":"bienvenue","type":"pourcent","valeur":10,"visible":true}')`, [org]);
      const k = await un(q<{ r: { compte_id: string } }>(`select public.code_promo_enregistrer($1, '{"code":"VIP-AWA","type":"montant","valeur":1000,"client":"0505050505"}') r`, [org]));
      expect(k.r.compte_id).toBe(awa);
      await q('savepoint a');
      await expect(q(`select public.code_promo_enregistrer($1, '{"code":"X1Y","type":"montant","valeur":500,"client":"inconnu@x.ci"}')`, [org])).rejects.toThrow(/Aucun compte/);
      await q('rollback to savepoint a');
    });
    const anon = await anonyme((q) => un(q<{ r: unknown[] }>(`select public.mes_bons_marche() r`)));
    expect(anon.r).toHaveLength(1);
    await expect(anonyme((q) => q(`select public.marche_code_promo('chez-alice', 'vip-awa')`))).rejects.toThrow(/réservé à un compte/);
    const bons = await enTantQue(pool, awa, (q) => un(q<{ r: unknown[] }>(`select public.mes_bons_marche() r`)));
    expect(bons.r).toHaveLength(2);
  });

  it('commande avec code et espèces : remise appliquée, monnaie à préparer, encaissement sans droit de remise', async () => {
    const cmd = (extra: object) => JSON.stringify({
      boutique: 'chez-alice', client_nom: 'Awa', client_telephone: '0505050505', mode: 'retrait', paiement: 'livraison',
      code_promo: 'VIP-AWA', lignes: [{ produit_id: riz, quantite: 2 }], ...extra,
    });
    await expect(enTantQue(pool, awa, (q) => q(`select public.passer_commande($1)`, [cmd({ especes_remis: 5000 })]))).rejects.toThrow(/espèces/);
    const c = await enTantQue(pool, awa, async (q) => {
      const r = (await un(q<{ r: { id: string; code_suivi: string; total: number; remise: number } }>(`select public.passer_commande($1) r`, [cmd({ especes_remis: 10000 })]))).r;
      const mes = await un(q<{ r: { total: number }[] }>(`select public.mes_commandes_marche() r`));
      expect(mes.r).toHaveLength(1);
      return r;
    });
    expect(Number(c.total)).toBe(8000);
    expect(Number(c.remise)).toBe(1000);
    const suivi = await anonyme((q) => un(q<{ r: { especes_remis: number; code_promo: string } }>(`select public.marche_suivi($1) r`, [c.code_suivi])));
    expect(Number(suivi.r.especes_remis)).toBe(10000);
    expect(suivi.r.code_promo).toBe('VIP-AWA');
    await enTantQue(pool, alice, async (q) => {
      expect(Number((await un(q<{ r: { a_affecter: number } }>(`select public.commandes_caisse_attente($1) r`, [org]))).r.a_affecter)).toBe(1);
      const s = (await un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0, $3) id`, [org, caisse, carine]))).id;
      // 3.9 : la gérante affecte d'abord la commande à la caissière.
      await q(`select public.affecter_commande_web($1, $2)`, [c.id, carine]);
      await devenir(q, carine);
      const v = (await un(q<{ r: { id: string; total: number } }>(`select public.encaisser_commande_web($1, $2) r`, [c.id, s]))).r;
      expect(Number(v.total)).toBe(8000);
      const reg = await un(q<{ montant: number }>(`select montant from reglements where vente_id = $1`, [v.id]));
      expect(Number(reg.montant)).toBe(8000);
    });
  });
});
