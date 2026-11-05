import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// v1.0 : compte d'exploitation, SIG SYSCOHADA, seuil de rentabilité ; surstock, promotions appliquées en caisse.
let pool: pg.Pool;
let alice: string;
let carine: string;
let org: string;
let mag: string;
let caisse: string;
let pagne: string;
let session: string;
let especes: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const commeAlice = <R>(fn: (q: <T = Record<string, unknown>>(sql: string, p?: unknown[]) => Promise<T[]>) => Promise<R>) => enTantQue(pool, alice, fn);
const vente = (prix: number, qte: number) =>
  JSON.stringify({
    id: randomUUID(), organisation_id: org, caisse_id: caisse, session_id: session, date_vente: new Date().toISOString(),
    lignes: [{ produit_id: pagne, quantite: qte, prix_unitaire: prix }],
    reglements: [{ moyen_id: especes, montant: prix * qte, montant_recu: prix * qte }],
  });

beforeAll(async () => {
  pool = await preparerBase('v100');
  alice = await creerCompte(pool, 'alice@w.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@w.ci', 'Carine');
  org = (await commeAlice((q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique v1') id`)))).id;
  await commeAlice(async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    especes = (await un(q<{ id: string }>(`select id from moyens_paiement where organisation_id = $1 and code = 'especes'`, [org]))).id;
    pagne = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Pagne', 4500) returning id`, [org]))).id;
    const r = (await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]))).id;
    await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 100, 3000)`, [org, r, pagne]);
    await q(`insert into receptions_frais (organisation_id, reception_id, nature, montant) values ($1, $2, 'transport', 20000)`, [org, r]);
    await q(`select public.valider_reception($1)`, [r]);
    await q(`select public.inviter_membre($1, 'carine@w.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
    session = (await un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0) id`, [org, caisse]))).id;
    await q(`select public.enregistrer_vente($1::jsonb)`, [vente(4500, 10)]);
    const postes = await q<{ id: string; libelle: string }>(`select id, libelle from postes_budget where organisation_id = $1`, [org]);
    const b = (await un(q<{ id: string }>(`select public.enregistrer_budget($1, current_date, $2::jsonb) id`, [org,
      JSON.stringify(postes.map((p) => ({ poste_id: p.id, montant: p.libelle === 'Loyer' ? 30000 : p.libelle === 'Salaires' ? 50000 : 0 })))]))).id;
    await q(`select public.valider_budget($1)`, [b]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
});

afterAll(async () => {
  await pool?.end();
});

describe('Rentabilité', () => {
  it('marge, charges (budget validé à défaut de dépenses), résultat, seuil et SIG cohérents', async () => {
    const c = await commeAlice((q) => un(q<{ r: Record<string, unknown> & { sig: { repere: string; montant: number }[]; evolution: unknown[] } }>(
      `select public.compte_exploitation($1, current_date) r`, [org])));
    expect(Number(c.r.chiffre_affaires)).toBe(45000);
    expect(Number(c.r.cout_ventes)).toBe(32000);
    expect(Number(c.r.marge)).toBe(13000);
    expect(Number(c.r.charges)).toBe(80000);
    expect(Number(c.r.resultat)).toBe(-67000);
    expect(Number(c.r.seuil_rentabilite)).toBe(Math.ceil(80000 / (13000 / 45000)));
    const sig = Object.fromEntries(c.r.sig.map((s) => [s.repere, Number(s.montant)]));
    expect(sig.XA).toBe(13000);
    expect(sig.XD).toBe(13000 - 30000 - 50000);
    expect(sig.XI).toBe(-67000);
    expect(c.r.evolution).toHaveLength(12);
  });

  it('refusé au caissier', async () => {
    await expect(enTantQue(pool, carine, (q) => q(`select public.compte_exploitation($1)`, [org]))).rejects.toThrow(/rentabilite/);
  });
});

describe('Surstock et soldes', () => {
  it('détecte le surstock et propose une remise sans descendre sous le coût', async () => {
    const a = await commeAlice((q) => un(q<{ r: { lignes: { id: string; situation: string; prix_propose: number; cout: number }[] } }>(`select public.analyse_surstock($1) r`, [org])));
    const l = a.r.lignes.find((x) => x.id === pagne)!;
    expect(l.situation).toBe('surstock_fort');
    expect(Number(l.prix_propose)).toBeGreaterThanOrEqual(Number(l.cout));
  });

  it('prix plancher : sous le coût seulement avec motif du propriétaire', async () => {
    await expect(commeAlice((q) => q(`select public.creer_promotion($1, $2, 2000, current_date, current_date + 7, 'Trop bas')`, [org, pagne]))).rejects.toThrow(/coût de revient/);
    const ok = await commeAlice((q) => un(q<{ r: { statut: string } }>(`select public.creer_promotion($1, $2, 4000, current_date, current_date + 7, 'Fête') r`, [org, pagne])));
    expect(ok.r.statut).toBe('active');
  });

  it('la caisse vend au prix de la promotion, et refuse un autre prix', async () => {
    const cat = await enTantQue(pool, carine, (q) => q<{ prix_vente: number }>(`select prix_vente from public.catalogue_caisse($1, $2) where id = $3`, [org, mag, pagne]));
    expect(Number(cat[0]!.prix_vente)).toBe(4000);
    await enTantQue(pool, carine, (q) => q(`select public.enregistrer_vente($1::jsonb)`, [vente(4000, 2)]));
    await expect(enTantQue(pool, carine, (q) => q(`select public.enregistrer_vente($1::jsonb)`, [vente(3500, 1)]))).rejects.toThrow(/prix/);
    const b = await commeAlice((q) => un(q<{ r: { qte_pendant: number }[] }>(`select public.bilan_promotions($1) r`, [org])));
    expect(Number(b.r[0]!.qte_pendant)).toBeGreaterThanOrEqual(2);
  });
});
