import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 1.7 : le gérant principal suit le solde des ventes de chaque caisse et tire un rapport X provisoire.
let pool: pg.Pool;
let alice: string; // propriétaire
let bintou: string;
let koffi: string;
let org: string;
let caisse1: string;
let caisse2: string;
let savon: string;
let riz: string;
let especes: string;
let s1: string;
let s2: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const vendre = (uid: string, session: string, caisse: string, lignes: { produit_id: string; quantite: number; prix_unitaire: number }[]) => {
  const total = lignes.reduce((s, l) => s + l.quantite * l.prix_unitaire, 0);
  return enTantQue(pool, uid, (q) => q(`select public.enregistrer_vente($1::jsonb)`, [JSON.stringify({
    id: randomUUID(), organisation_id: org, caisse_id: caisse, session_id: session, date_vente: new Date().toISOString(),
    lignes, reglements: [{ moyen_id: especes, montant: total, montant_recu: total }],
  })]));
};

interface Etat { caisses: { id: string; session: { ventes?: { total: number; nombre: number } | null } | null }[] }

beforeAll(async () => {
  pool = await preparerBase('v170');
  alice = await creerCompte(pool, 'alice@r.ci', 'Alice');
  bintou = await creerCompte(pool, 'bintou@r.ci', 'Bintou');
  koffi = await creerCompte(pool, 'koffi@r.ci', 'Koffi');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique R') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    const mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse1 = (await un(q<{ id: string }>(`select id from caisses where organisation_id = $1`, [org]))).id;
    caisse2 = (await un(q<{ id: string }>(`insert into caisses (organisation_id, magasin_id, code, nom) values ($1, $2, 'CAISSE02', 'Caisse 2') returning id`, [org, mag]))).id;
    savon = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Savon', 1000) returning id`, [org]))).id;
    riz = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Riz 5 kg', 4000) returning id`, [org]))).id;
    especes = (await un(q<{ id: string }>(`select id from moyens_paiement where organisation_id = $1 and code = 'especes'`, [org]))).id;
    await q(`select public.inviter_membre($1, 'bintou@r.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse1]]);
    await q(`select public.inviter_membre($1, 'koffi@r.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse2]]);
  });
  await enTantQue(pool, bintou, (q) => q(`select public.accepter_invitations()`));
  await enTantQue(pool, koffi, (q) => q(`select public.accepter_invitations()`));
  s1 = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0, $3) id`, [org, caisse1, bintou])))).id;
  s2 = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0, $3) id`, [org, caisse2, koffi])))).id;
  await vendre(bintou, s1, caisse1, [{ produit_id: savon, quantite: 3, prix_unitaire: 1000 }, { produit_id: riz, quantite: 1, prix_unitaire: 4000 }]);
  await vendre(bintou, s1, caisse1, [{ produit_id: savon, quantite: 2, prix_unitaire: 1000 }]);
  await vendre(koffi, s2, caisse2, [{ produit_id: riz, quantite: 1, prix_unitaire: 4000 }]);
});

afterAll(async () => {
  await pool?.end();
});

describe('Suivi des ventes en cours', () => {
  it('le gérant voit le solde et le nombre de ventes de chaque caisse ouverte', async () => {
    const e = await enTantQue(pool, alice, (q) => un(q<{ r: Etat }>(`select public.mes_caisses($1) r`, [org]))).then((x) => x.r);
    const c1 = e.caisses.find((c) => c.id === caisse1)!;
    const c2 = e.caisses.find((c) => c.id === caisse2)!;
    expect(c1.session?.ventes).toEqual({ total: 9000, nombre: 2 });
    expect(c2.session?.ventes).toEqual({ total: 4000, nombre: 1 });
  });
  it('un caissier ne reçoit pas ces soldes', async () => {
    const e = await enTantQue(pool, bintou, (q) => un(q<{ r: Etat }>(`select public.mes_caisses($1) r`, [org]))).then((x) => x.r);
    expect(e.caisses.every((c) => c.session == null || c.session.ventes == null)).toBe(true);
  });
  it('rapport X provisoire : produits vendus, pour le gérant', async () => {
    const r = await enTantQue(pool, alice, (q) => un(q<{ r: { total_ventes: number; par_produit: { designation: string; quantite: number; montant: number }[] } }>(`select public.rapport_session($1) r`, [s1]))).then((x) => x.r);
    expect(Number(r.total_ventes)).toBe(9000);
    expect(r.par_produit.map((p) => [p.designation, Number(p.quantite), Number(p.montant)])).toEqual([
      ['Savon', 5, 5000],
      ['Riz 5 kg', 1, 4000],
    ]);
  });
  it('un caissier lit son rapport, pas celui d’un collègue', async () => {
    await expect(enTantQue(pool, bintou, (q) => q(`select public.rapport_session($1)`, [s1]))).resolves.toBeTruthy();
    await expect(enTantQue(pool, bintou, (q) => q(`select public.rapport_session($1)`, [s2]))).rejects.toThrow(/introuvable/);
  });
  it('le rapport Z garde le détail des produits', async () => {
    const z = await enTantQue(pool, alice, (q) => un(q<{ r: { numero_z: number; par_produit: unknown[] } }>(`select public.cloturer_session($1, 4000) r`, [s2]))).then((x) => x.r);
    expect(z.numero_z).toBe(1);
    expect(z.par_produit).toHaveLength(1);
  });
});
