import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 1.5 : le responsable ouvre la caisse (billetage) pour une personne ; chacun ne vend et ne voit que sa caisse.
let pool: pg.Pool;
let alice: string; // propriétaire
let bintou: string; // caissière, caisse 1
let koffi: string; // caissier, caisse 2
let org: string;
let caisse1: string;
let caisse2: string;
let produit: string;
let especes: string;
let s1: string;
let s2: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const vendre = (uid: string, session: string, caisse: string, qte = 1) =>
  enTantQue(pool, uid, (q) => q(`select public.enregistrer_vente($1::jsonb)`, [JSON.stringify({
    id: randomUUID(), organisation_id: org, caisse_id: caisse, session_id: session, date_vente: new Date().toISOString(),
    lignes: [{ produit_id: produit, quantite: qte, prix_unitaire: 1000 }],
    reglements: [{ moyen_id: especes, montant: 1000 * qte, montant_recu: 1000 * qte }],
  })]));

beforeAll(async () => {
  pool = await preparerBase('v150');
  alice = await creerCompte(pool, 'alice@q.ci', 'Alice');
  bintou = await creerCompte(pool, 'bintou@q.ci', 'Bintou');
  koffi = await creerCompte(pool, 'koffi@q.ci', 'Koffi');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique Q') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    const mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse1 = (await un(q<{ id: string }>(`select id from caisses where organisation_id = $1`, [org]))).id;
    caisse2 = (await un(q<{ id: string }>(`insert into caisses (organisation_id, magasin_id, code, nom) values ($1, $2, 'CAISSE02', 'Caisse 2') returning id`, [org, mag]))).id;
    produit = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Savon', 1000) returning id`, [org]))).id;
    especes = (await un(q<{ id: string }>(`select id from moyens_paiement where organisation_id = $1 and code = 'especes'`, [org]))).id;
    await q(`select public.inviter_membre($1, 'bintou@q.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse1]]);
    await q(`select public.inviter_membre($1, 'koffi@q.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse2]]);
  });
  await enTantQue(pool, bintou, (q) => q(`select public.accepter_invitations()`));
  await enTantQue(pool, koffi, (q) => q(`select public.accepter_invitations()`));
});

afterAll(async () => {
  await pool?.end();
});

describe('Ouverture par le responsable', () => {
  it('la caissière doit passer par le gérant', async () => {
    await expect(enTantQue(pool, bintou, (q) => q(`select public.ouvrir_session($1, $2, 0)`, [org, caisse1]))).rejects.toThrow(/gérant principal/);
  });
  it('le billetage doit correspondre au fond', async () => {
    await expect(enTantQue(pool, alice, (q) => q(`select public.ouvrir_session($1, $2, 15000, $3, $4::jsonb)`,
      [org, caisse1, bintou, JSON.stringify([{ valeur: 10000, nombre: 1 }, { valeur: 2000, nombre: 2 }])]))).rejects.toThrow(/billetage/);
  });
  it('ouvre pour Bintou avec 2 × 5 000 + 5 × 1 000, et pour Koffi', async () => {
    s1 = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 15000, $3, $4::jsonb) id`,
      [org, caisse1, bintou, JSON.stringify([{ valeur: 5000, nombre: 2 }, { valeur: 1000, nombre: 5 }])])))).id;
    s2 = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0, $3) id`, [org, caisse2, koffi])))).id;
  });
  it('refuse d’ouvrir pour une personne à qui la caisse n’est pas attribuée', async () => {
    await enTantQue(pool, alice, (q) => q(`select public.cloturer_session($1, 0)`, [s2]));
    await expect(enTantQue(pool, alice, (q) => q(`select public.ouvrir_session($1, $2, 0, $3)`, [org, caisse2, bintou]))).rejects.toThrow(/pas attribuée à cette personne/);
    s2 = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0, $3) id`, [org, caisse2, koffi])))).id;
  });
});

describe('Chacun vend et voit sa caisse', () => {
  it('Bintou vend dans sa caisse, pas dans celle de Koffi ; le gérant ne vend pas dans la caisse de Bintou', async () => {
    await vendre(bintou, s1, caisse1, 2);
    await vendre(koffi, s2, caisse2, 3);
    await expect(vendre(bintou, s2, caisse2)).rejects.toThrow();
    await expect(vendre(alice, s1, caisse1)).rejects.toThrow(/gérant principal ne vend pas/);
  });
  it('Bintou ne voit que ses ventes et sa session ; le gérant voit tout', async () => {
    const vb = await enTantQue(pool, bintou, (q) => q<{ total: string }>(`select total from ventes`));
    expect(vb.map((v) => Number(v.total))).toEqual([2000]);
    const sb = await enTantQue(pool, bintou, (q) => q<{ id: string }>(`select id from sessions_caisse`));
    expect(sb.map((s) => s.id)).toEqual([s1]);
    await expect(enTantQue(pool, bintou, (q) => q(`select public.journal_session($1)`, [s2]))).rejects.toThrow(/introuvable/);
    const va = await enTantQue(pool, alice, (q) => q(`select id from ventes`));
    expect(va).toHaveLength(2);
    const jour = await enTantQue(pool, bintou, (q) => un(q<{ total: string }>(`select total from public.ventes_du_jour($1)`, [org])));
    expect(Number(jour.total)).toBe(2000);
  });
  it('mes_caisses : le gérant voit qui tient chaque caisse et à qui il peut ouvrir', async () => {
    const e = await enTantQue(pool, alice, (q) => un(q<{ r: { responsable: boolean; caisses: { id: string; session: { par: string; mienne: boolean } | null; caissiers: { nom: string }[] }[] } }>(`select public.mes_caisses($1) r`, [org]))).then((x) => x.r);
    expect(e.responsable).toBe(true);
    const c1 = e.caisses.find((c) => c.id === caisse1)!;
    expect(c1.session).toMatchObject({ par: 'Bintou', mienne: false });
    expect(c1.caissiers.map((c) => c.nom)).toEqual(['Bintou']);
    const k = await enTantQue(pool, koffi, (q) => un(q<{ r: { responsable: boolean; caisses: { id: string }[] } }>(`select public.mes_caisses($1) r`, [org]))).then((x) => x.r);
    expect(k.responsable).toBe(false);
    expect(k.caisses.map((c) => c.id)).toEqual([caisse2]);
  });
  it('le gérant clôture la caisse de Bintou ; Bintou peut clôturer la sienne, pas celle de Koffi', async () => {
    await expect(enTantQue(pool, bintou, (q) => q(`select public.cloturer_session($1, 3000)`, [s2]))).rejects.toThrow();
    const z = await enTantQue(pool, alice, (q) => un(q<{ r: { numero_z: number } }>(`select public.cloturer_session($1, 17000) r`, [s1]))).then((x) => x.r);
    expect(z.numero_z).toBe(1);
  });
});
