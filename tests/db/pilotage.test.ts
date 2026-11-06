import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { creerCompte, devenir, enTantQue, ouvrirPourCaissier, preparerBase } from './helpers';

// v0.9 : coût de revient et dettes fournisseurs, budget du mois, trésorerie, droits du cahier des charges.
let pool: pg.Pool;
let alice: string; // propriétaire
let carine: string; // caissière
let gerard: string; // gestionnaire de stock
let org: string;
let mag: string;
let caisse: string;
let pagne: string;
let fournisseur: string;
let reception: string;
const comptes: Record<string, string> = {};

const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const n = (v: unknown) => Number(v);
const commeAlice = <R>(fn: (q: <T = Record<string, unknown>>(sql: string, p?: unknown[]) => Promise<T[]>) => Promise<R>) => enTantQue(pool, alice, fn);

beforeAll(async () => {
  pool = await preparerBase('pilotage');
  alice = await creerCompte(pool, 'alice@p.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@p.ci', 'Carine');
  gerard = await creerCompte(pool, 'gerard@p.ci', 'Gérard');
  org = (await commeAlice((q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique Pilotage') id`)))).id;
  await commeAlice(async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    for (const c of await q<{ type: string; nom: string; id: string }>(`select type, nom, id from comptes_tresorerie where organisation_id = $1`, [org]))
      comptes[c.type === 'mobile_money' ? c.nom : c.type] = c.id;
    await q(`update comptes_tresorerie set solde_initial = 100000 where id = $1`, [comptes.caisse]);
    fournisseur = (await un(q<{ id: string }>(`insert into fournisseurs (organisation_id, nom) values ($1, 'Grossiste Adjamé') returning id`, [org]))).id;
    pagne = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Pagne wax', 4500) returning id`, [org]))).id;
    await q(`select public.inviter_membre($1, 'carine@p.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
    await q(`select public.inviter_membre($1, 'gerard@p.ci', 'gestionnaire_stock', true)`, [org]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
  await enTantQue(pool, gerard, (q) => q(`select public.accepter_invitations()`));
});

afterAll(async () => {
  await pool?.end();
});

describe('Comptes de trésorerie par défaut', () => {
  it('crée Caisse, Banque et un compte par Mobile Money, reliés aux moyens de paiement', async () => {
    expect(Object.keys(comptes).sort()).toEqual(['MTN MoMo', 'Moov Money', 'Orange Money', 'Wave', 'banque', 'caisse']);
    const { rows } = await pool.query(
      `select m.code, c.type from moyens_paiement m join comptes_tresorerie c on c.id = m.compte_id where m.organisation_id = $1`, [org]);
    const parCode = Object.fromEntries(rows.map((r) => [r.code, r.type]));
    expect(parCode).toMatchObject({ especes: 'caisse', wave: 'mobile_money', carte: 'banque', virement: 'banque' });
  });
});

describe('Coût de revient et dettes fournisseurs', () => {
  it('exemple du cahier : 100 pagnes à 3 000 + 15 000 de transport + 5 000 de manutention = 3 200 l’unité', async () => {
    await commeAlice(async (q) => {
      reception = (await un(q<{ id: string }>(
        `insert into receptions (organisation_id, magasin_id, fournisseur_id, reglement, echeance) values ($1, $2, $3, 'credit', current_date + 15) returning id`,
        [org, mag, fournisseur]))).id;
      await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 100, 3000)`, [org, reception, pagne]);
      await q(`insert into receptions_frais (organisation_id, reception_id, nature, montant, compte_id) values ($1, $2, 'transport', 15000, $3), ($1, $2, 'manutention', 5000, $3)`,
        [org, reception, comptes.caisse]);
      await q(`select public.valider_reception($1)`, [reception]);
    });
    const { rows } = await pool.query(`select cout_unitaire from receptions_lignes where reception_id = $1`, [reception]);
    expect(n(rows[0].cout_unitaire)).toBe(3200);
    const couts = await commeAlice((q) => un(q<{ r: { dernier_cout: number; prix_vente: number }[] }>(`select public.couts_de_revient($1) r`, [org])));
    expect(couts.r[0]).toMatchObject({ dernier_cout: 3200, prix_vente: 4500 });
  });

  it('suit le reste dû, refuse un paiement supérieur et le diminue après paiement', async () => {
    const situation = async () =>
      (await commeAlice((q) => un(q<{ r: { reste_du: number; total_achats: number }[] }>(`select public.situation_fournisseurs($1) r`, [org])))).r[0]!;
    expect(await situation()).toMatchObject({ total_achats: 300000, reste_du: 300000 });
    await expect(commeAlice((q) => q(`select public.payer_fournisseur($1, $2, $3, 400000, $4)`, [org, fournisseur, reception, comptes.banque]))).rejects.toThrow(/reste dû/);
    await commeAlice((q) => q(`select public.payer_fournisseur($1, $2, $3, 100000, $4)`, [org, fournisseur, reception, comptes.banque]));
    expect((await situation()).reste_du).toBe(200000);
  });

  it('un achat à crédit doit indiquer le fournisseur', async () => {
    await commeAlice(async (q) => {
      const r = (await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id, reglement) values ($1, $2, 'credit') returning id`, [org, mag]))).id;
      await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 1, 3000)`, [org, r, pagne]);
      await expect(q(`select public.valider_reception($1)`, [r])).rejects.toThrow(/fournisseur/);
    });
  });
});

describe('Budget du mois', () => {
  let budget: string;
  let electricite: string;

  it('saisit, valide, fige, puis révise avec motif', async () => {
    await commeAlice(async (q) => {
      const postes = await q<{ id: string; libelle: string }>(`select id, libelle from postes_budget where organisation_id = $1`, [org]);
      expect(postes).toHaveLength(11);
      electricite = postes.find((p) => p.libelle.startsWith('Électricité'))!.id;
      const loyer = postes.find((p) => p.libelle === 'Loyer')!.id;
      budget = (await un(q<{ id: string }>(`select public.enregistrer_budget($1, current_date, $2::jsonb) id`, [
        org, JSON.stringify([{ poste_id: loyer, montant: 150000 }, { poste_id: electricite, montant: 30000 }])]))).id;
      await q(`select public.valider_budget($1)`, [budget]);
    });
    await expect(commeAlice((q) => q(`select public.enregistrer_budget($1, current_date, '[]'::jsonb)`, [org]))).rejects.toThrow(/révision/);
    await expect(commeAlice((q) => q(`select public.reviser_budget($1, '')`, [budget]))).rejects.toThrow(/motif/);
  });

  it('suit le réel face au prévu et alerte à 80 %', async () => {
    await commeAlice((q) => q(`select public.enregistrer_depense($1, current_date, $2, $3, 26000, 'Facture CIE')`, [org, electricite, comptes.Wave]));
    const s = await commeAlice((q) => un(q<{ r: { lignes: { poste_id: string; prevu: number; reel: number; alerte: string }[]; totaux: { prevu: number; reel: number } } }>(
      `select public.suivi_budget($1, current_date) r`, [org])));
    expect(s.r.lignes.find((l) => l.poste_id === electricite)).toMatchObject({ prevu: 30000, reel: 26000, alerte: 'attention' });
    expect(s.r.totaux).toMatchObject({ prevu: 180000, reel: 26000 });
  });
});

describe('Trésorerie', () => {
  it('calcule les soldes à partir des ventes, dépenses, frais, paiements et virements', async () => {
    await commeAlice(async (q) => {
      const session = await ouvrirPourCaissier(q, { org, caisse, gerant: alice, caissier: carine, email: 'carine@p.ci' });
      const moyen = async (code: string) => (await un(q<{ id: string }>(`select id from moyens_paiement where organisation_id = $1 and code = $2`, [org, code]))).id;
      await q(`select public.enregistrer_vente($1::jsonb)`, [JSON.stringify({
        id: randomUUID(), organisation_id: org, caisse_id: caisse, session_id: session, date_vente: new Date().toISOString(),
        lignes: [{ produit_id: pagne, quantite: 3, prix_unitaire: 4500 }],
        reglements: [{ moyen_id: await moyen('especes'), montant: 9000, montant_recu: 10000 }, { moyen_id: await moyen('wave'), montant: 4500, reference: 'W1' }],
      })]);
      await devenir(q, alice);
      await q(`select public.saisir_virement($1, $2, $3, 50000, 0, current_date, 'Versement')`, [org, comptes.caisse, comptes.banque]);
    });
    const t = await commeAlice((q) => un(q<{ r: { comptes: { id: string; solde: number }[]; dettes_30_jours: number; budget_restant: number; liquidite: number; total: number } }>(
      `select public.tresorerie($1) r`, [org])));
    const solde = (id: string) => t.r.comptes.find((c) => c.id === id)!.solde;
    expect(solde(comptes.caisse!)).toBe(100000 - 20000 + 9000 - 50000);
    expect(solde(comptes.Wave!)).toBe(4500 - 26000);
    expect(solde(comptes.banque!)).toBe(-100000 + 50000);
    expect(t.r.dettes_30_jours).toBe(200000);
    expect(t.r.budget_restant).toBe(150000 + 4000);
    expect(t.r.liquidite).toBe(t.r.total - 200000 - 154000);
  });

  it('rapprochement : un écart doit être justifié, puis il devient un ajustement', async () => {
    await expect(commeAlice((q) => q(`select public.rapprocher_compte($1, current_date, 38000)`, [comptes.caisse]))).rejects.toThrow(/justification/);
    await commeAlice((q) => q(`select public.rapprocher_compte($1, current_date, 38000, 'Pièce de 1 000 manquante')`, [comptes.caisse]));
    const t = await commeAlice((q) => un(q<{ r: { comptes: { id: string; solde: number }[] } }>(`select public.tresorerie($1) r`, [org])));
    expect(t.r.comptes.find((c) => c.id === comptes.caisse)!.solde).toBe(38000);
  });
});

describe('Droits du cahier des charges', () => {
  it('la caissière ne voit ni la trésorerie, ni le budget, ni les coûts', async () => {
    await expect(enTantQue(pool, carine, (q) => q(`select public.tresorerie($1)`, [org]))).rejects.toThrow(/tresorerie/);
    await expect(enTantQue(pool, carine, (q) => q(`select public.suivi_budget($1, current_date)`, [org]))).rejects.toThrow(/budget/);
    await expect(enTantQue(pool, carine, (q) => q(`select public.couts_de_revient($1)`, [org]))).rejects.toThrow(/fournisseurs/);
    const lignes = await enTantQue(pool, carine, (q) => q(`select * from comptes_tresorerie where organisation_id = $1`, [org]));
    expect(lignes).toHaveLength(0);
    const mouvements = await enTantQue(pool, carine, (q) => q(`select * from mouvements_stock where organisation_id = $1`, [org]));
    expect(mouvements).toHaveLength(0);
  });

  it('changer un prix de vente demande « catalogue.valider »', async () => {
    await enTantQue(pool, gerard, (q) => q(`update produits set prix_vente = 5000 where id = $1`, [pagne]));
    const membre = (await pool.query(`select id from membres where user_id = $1`, [gerard])).rows[0].id;
    await commeAlice((q) => q(`select public.definir_permission_membre($1, 'catalogue.valider', false)`, [membre]));
    await expect(enTantQue(pool, gerard, (q) => q(`update produits set prix_vente = 5500 where id = $1`, [pagne]))).rejects.toThrow(/catalogue.valider/);
    await enTantQue(pool, gerard, (q) => q(`update produits set designation = 'Pagne wax 6 yards' where id = $1`, [pagne]));
  });
});
