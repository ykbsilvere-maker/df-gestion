import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, devenir, enTantQue, preparerBase } from './helpers';

// 3.3 : crédits clients structurés (articles, durée ⇄ échéance, responsable du suivi,
// procédure de recouvrement, encaissement à la caisse).
let pool: pg.Pool;
let alice: string; // gérante principale
let carine: string; // caissière chargée du suivi
let paul: string; // caissier d'un autre magasin
let org: string;
let mag: string;
let mag2: string;
let caisse: string;
let client: string;
let riz: string;
let huile: string;
const moyens: Record<string, string> = {};
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const jour = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
interface Dossier { id: string; numero: string; statut: string; reste: number; paye: number; jours_retard: number; etape: number; moi: boolean; duree_jours: number; echeance: string }
interface Liste { dossiers: Dossier[]; tout_voir: boolean; procedure: Record<string, number> }

beforeAll(async () => {
  pool = await preparerBase('v330');
  alice = await creerCompte(pool, 'alice@cr.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@cr.ci', 'Carine');
  paul = await creerCompte(pool, 'paul@cr.ci', 'Paul');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Crédits & Cie') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    mag2 = (await un(q<{ id: string }>(`insert into magasins (organisation_id, code, nom) values ($1, 'MAG02', 'Cocody') returning id`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    for (const m of await q<{ code: string; id: string }>(`select code, id from moyens_paiement where organisation_id = $1`, [org])) moyens[m.code] = m.id;
    const p = async (d: string, prix: number) =>
      (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, $2, $3) returning id`, [org, d, prix]))).id;
    riz = await p('Riz 25 kg', 18000);
    huile = await p('Huile 5 L', 7500);
    const r = await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]));
    await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values
      ($1, $2, $3, 10, 15000), ($1, $2, $4, 20, 6000)`, [org, r.id, riz, huile]);
    await q(`select public.valider_reception($1)`, [r.id]);
    client = (await un(q<{ id: string }>(`insert into clients (organisation_id, nom, telephone, plafond_credit, delai_paiement)
      values ($1, 'Restaurant Le Bon Goût', '0700000000', 50000, 30) returning id`, [org]))).id;
    await q(`select public.inviter_membre($1, 'carine@cr.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
    await q(`select public.inviter_membre($1, 'paul@cr.ci', 'caissier', false, $2, '{}')`, [org, [mag2]]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
  await enTantQue(pool, paul, (q) => q(`select public.accepter_invitations()`));
});
afterAll(async () => {
  await pool?.end();
});

const preparer = (lignes: object[], extra: object = {}) =>
  enTantQue(pool, alice, (q) =>
    un(q<{ id: string }>(`select public.enregistrer_credit($1::jsonb) id`, [
      JSON.stringify({ organisation_id: org, magasin_id: mag, client_id: client, lignes, ...extra }),
    ]))).then((x) => x.id);

describe('Crédits clients', () => {
  let dossier: string;

  it('prépare un dossier : la durée donne l’échéance, l’échéance donne la durée', async () => {
    dossier = await preparer([{ produit_id: riz, quantite: 2 }, { produit_id: huile, quantite: 4, remise: 1000 }], { duree_jours: 15 });
    const c = await enTantQue(pool, alice, (q) => un(q<Dossier & { total: number; total_remises: number }>(`select * from credits where id = $1`, [dossier])));
    expect(c.numero).toMatch(/^CR-0000\d\d$/);
    expect(c.statut).toBe('brouillon');
    expect(Number(c.total)).toBe(2 * 18000 + 4 * 7500 - 1000);
    expect(Number(c.duree_jours)).toBe(15);
    // Choisir la date de paiement recalcule le délai.
    await preparer([{ produit_id: riz, quantite: 2 }, { produit_id: huile, quantite: 4, remise: 1000 }], { id: dossier, echeance: jour(21), duree_jours: 15 });
    const c2 = await enTantQue(pool, alice, (q) => un(q<{ duree_jours: number; echeance: Date }>(`select duree_jours, echeance::text echeance from credits where id = $1`, [dossier])));
    expect(Number(c2.duree_jours)).toBe(21);
    expect(String(c2.echeance)).toBe(jour(21));
    // Sans durée ni date : le délai habituel du client (30 jours).
    const d3 = await preparer([{ produit_id: huile, quantite: 1 }]);
    expect(Number((await enTantQue(pool, alice, (q) => un(q<{ d: number }>(`select duree_jours d from credits where id = $1`, [d3])))).d)).toBe(30);
    await enTantQue(pool, alice, (q) => q(`select public.annuler_credit($1, 'Doublon de test')`, [d3]));
  });

  it('refuse un caissier qui prépare un crédit et un responsable sans accès au magasin', async () => {
    await expect(enTantQue(pool, carine, (q) => q(`select public.enregistrer_credit($1::jsonb)`, [
      JSON.stringify({ organisation_id: org, magasin_id: mag, client_id: client, lignes: [{ produit_id: riz, quantite: 1 }] }),
    ]))).rejects.toThrow(/responsable/);
    await expect(preparer([{ produit_id: riz, quantite: 1 }], { responsable_id: paul })).rejects.toThrow(/accès à ce magasin/);
  });

  it('valide : plafond dépassé → motif exigé ; stock sorti et créance ouverte', async () => {
    await expect(enTantQue(pool, alice, (q) => q(`select public.valider_credit($1)`, [dossier]))).rejects.toThrow(/Plafond dépassé/);
    const r = await enTantQue(pool, alice, (q) => un(q<{ r: { numero: string; total: number } }>(`select public.valider_credit($1, 'Client fidèle depuis 5 ans') r`, [dossier])));
    expect(Number(r.r.total)).toBe(65000);
    const etat = await enTantQue(pool, alice, async (q) => ({
      stock: await q<{ produit_id: string; quantite: string }>(`select produit_id, quantite from stocks where magasin_id = $1`, [mag]),
      creance: await un(q<{ montant: string; piece: string; credit_id: string }>(`select montant, piece, credit_id from creances where credit_id = $1`, [dossier])),
    }));
    expect(Number(etat.stock.find((s) => s.produit_id === riz)!.quantite)).toBe(8);
    expect(Number(etat.stock.find((s) => s.produit_id === huile)!.quantite)).toBe(16);
    expect(Number(etat.creance.montant)).toBe(65000);
    await expect(preparer([{ produit_id: riz, quantite: 1 }], { id: dossier })).rejects.toThrow(/déjà validé/);
  });

  it('refuse un crédit au-delà du stock disponible', async () => {
    const d = await preparer([{ produit_id: riz, quantite: 50 }]);
    await expect(enTantQue(pool, alice, (q) => q(`select public.valider_credit($1, 'test')`, [d]))).rejects.toThrow(/Stock insuffisant/);
    await enTantQue(pool, alice, (q) => q(`select public.annuler_credit($1, 'Erreur de quantité')`, [d]));
  });

  it('confie le dossier à la caissière : elle ne voit que ses dossiers', async () => {
    await enTantQue(pool, alice, (q) => q(`select public.confier_credit($1, $2)`, [dossier, carine]));
    const vue = await enTantQue(pool, carine, (q) => un(q<{ r: Liste }>(`select public.credits_liste($1) r`, [org])));
    expect(vue.r.tout_voir).toBe(false);
    expect(vue.r.dossiers.map((d) => d.id)).toEqual([dossier]);
    expect(vue.r.dossiers[0]!.moi).toBe(true);
    const vuePaul = await enTantQue(pool, paul, (q) => un(q<{ r: Liste }>(`select public.credits_liste($1) r`, [org])));
    expect(vuePaul.r.dossiers).toHaveLength(0);
    await expect(enTantQue(pool, paul, (q) => q(`select public.credit_detail($1)`, [dossier]))).rejects.toThrow(/introuvable/);
    await expect(enTantQue(pool, alice, (q) => q(`select public.confier_credit($1, $2)`, [dossier, paul]))).rejects.toThrow(/accès à ce magasin/);
  });

  it('la caissière encaisse à sa caisse : les espèces entrent dans le tiroir', async () => {
    const r = await enTantQue(pool, alice, async (q) => {
      const s = (await un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 10000, $3) id`, [org, caisse, carine]))).id;
      await devenir(q, carine);
      // Hors caisse, une caissière ne peut pas encaisser.
      await q('savepoint a');
      await expect(q(`select public.encaisser_credit($1, 5000, $2)`, [dossier, moyens.especes])).rejects.toThrow(/caisse ouverte/);
      await q('rollback to savepoint a');
      const e = await un(q<{ r: { reste: number } }>(`select public.encaisser_credit($1, 20000, $2, $3) r`, [dossier, moyens.especes, s]));
      await q('savepoint b');
      await expect(q(`select public.encaisser_credit($1, 5000, $2, $3)`, [dossier, moyens.wave, s])).rejects.toThrow(/référence/);
      await q('rollback to savepoint b');
      await q(`select public.encaisser_credit($1, 5000, $2, $3, null, 'WV-123')`, [dossier, moyens.wave, s]);
      await q('savepoint c');
      await expect(q(`select public.encaisser_credit($1, 999999, $2, $3)`, [dossier, moyens.especes, s])).rejects.toThrow(/reste dû/);
      await q('rollback to savepoint c');
      const totaux = await un(q<{ t: { especes_attendues: number; credits_especes: number; credits_encaisses: number } }>(`select prive.calculer_totaux_session($1) t`, [s]));
      return { e: e.r, t: totaux.t };
    });
    expect(Number(r.e.reste)).toBe(45000);
    expect(Number(r.t.credits_especes)).toBe(20000);
    expect(Number(r.t.credits_encaisses)).toBe(25000);
    expect(Number(r.t.especes_attendues)).toBe(30000);
  });

  it('suit la procédure : étape selon le retard, relance inscrite, blocage des nouveaux crédits', async () => {
    // Le dossier passe 35 jours en retard (échéance reculée pour le test).
    await pool.query(`update creances set date_creance = current_date - 60, echeance = current_date - 35 where credit_id = $1`, [dossier]);
    await pool.query(`update credits set date_credit = current_date - 60, duree_jours = 25, echeance = current_date - 35 where id = $1`, [dossier]);
    const d = await enTantQue(pool, carine, (q) => un(q<{ r: { dossier: Dossier } }>(`select public.credit_detail($1) r`, [dossier])));
    expect(Number(d.r.dossier.jours_retard)).toBe(35);
    expect(Number(d.r.dossier.etape)).toBe(3);
    await enTantQue(pool, carine, async (q) => {
      await q(`select public.suivre_credit($1, 'relance', 3::smallint, 'Mise en demeure remise en main propre')`, [dossier]);
      await q(`select public.suivre_credit($1, 'promesse', 0::smallint, 'Paiera la moitié', current_date + 5, 20000)`, [dossier]);
    });
    const apres = await enTantQue(pool, alice, async (q) => ({
      relances: await q<{ niveau: number }>(`select niveau from relances where client_id = $1`, [client]),
      liste: (await un(q<{ r: Liste }>(`select public.credits_liste($1) r`, [org]))).r,
    }));
    expect(apres.relances.map((x) => Number(x.niveau))).toEqual([3]);
    expect(apres.liste.dossiers.find((x) => x.id === dossier)).toMatchObject({ etape: 3 });
    // Nouveau crédit pour ce client : bloqué par la procédure (palier 3), possible avec un motif.
    await enTantQue(pool, alice, (q) => q(`update clients set plafond_credit = null where id = $1`, [client]));
    const d2 = await preparer([{ produit_id: huile, quantite: 1 }]);
    await expect(enTantQue(pool, alice, (q) => q(`select public.valider_credit($1)`, [d2]))).rejects.toThrow(/bloque les nouveaux crédits/);
    await enTantQue(pool, alice, (q) => q(`select public.regler_procedure_credit($1, $2::jsonb)`, [org, JSON.stringify({ palier_1: 1, palier_2: 15, palier_3: 30, palier_4: 60, blocage_palier: 4 })]));
    await enTantQue(pool, alice, (q) => q(`select public.valider_credit($1)`, [d2]));
    await expect(enTantQue(pool, alice, (q) => q(`select public.regler_procedure_credit($1, $2::jsonb)`, [org, JSON.stringify({ palier_1: 10, palier_2: 5, palier_3: 30, palier_4: 60 })]))).rejects.toThrow(/se suivre/);
    await expect(enTantQue(pool, carine, (q) => q(`select public.regler_procedure_credit($1, $2::jsonb)`, [org, JSON.stringify({ palier_1: 1, palier_2: 5, palier_3: 30, palier_4: 60 })]))).rejects.toThrow(/responsable/);
  });

  it('annule un crédit validé sans règlement : les articles reviennent en stock', async () => {
    const d = await preparer([{ produit_id: riz, quantite: 3 }]);
    await enTantQue(pool, alice, (q) => q(`select public.valider_credit($1, 'test')`, [d]));
    const avant = Number((await pool.query(`select quantite from stocks where magasin_id = $1 and produit_id = $2`, [mag, riz])).rows[0].quantite);
    await enTantQue(pool, alice, (q) => q(`select public.annuler_credit($1, 'Client a rendu la marchandise')`, [d]));
    const apres = Number((await pool.query(`select quantite from stocks where magasin_id = $1 and produit_id = $2`, [mag, riz])).rows[0].quantite);
    expect(apres).toBe(avant + 3);
    const cr = (await pool.query(`select statut from creances where credit_id = $1`, [d])).rows[0];
    expect(cr.statut).toBe('annulee');
    await expect(enTantQue(pool, alice, (q) => q(`select public.annuler_credit($1, 'motif')`, [dossier]))).rejects.toThrow(/règlements/);
  });
});
