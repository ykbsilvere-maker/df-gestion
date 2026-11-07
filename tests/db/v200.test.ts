import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 2.0 : ouverture et clôture de la journée.
let pool: pg.Pool;
let alice: string; // gérant principal
let bintou: string; // caissière
let org: string;
let mag: string;
let caisse: string;
let savon: string;
let especes: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
interface Journee { id: string; date: string; statut: string; totaux: { total_ventes: number; nombre_ventes: number; caisses: number } | null }
interface Etat { aujourdhui: string; suivie: boolean; ouverte: Journee | null; caisses_ouvertes: string[] }
const etat = (uid: string) => enTantQue(pool, uid, (q) => un(q<{ r: Etat }>(`select public.ma_journee($1) r`, [org]))).then((x) => x.r);
const perte = () => enTantQue(pool, alice, (q) => q(`select public.enregistrer_mouvement_manuel($1, $2, $3, 'perte', 1, 'Casse')`, [org, mag, savon]));

beforeAll(async () => {
  pool = await preparerBase('v200');
  alice = await creerCompte(pool, 'alice@j.ci', 'Alice');
  bintou = await creerCompte(pool, 'bintou@j.ci', 'Bintou');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique J') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where organisation_id = $1`, [org]))).id;
    savon = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Savon', 1000) returning id`, [org]))).id;
    especes = (await un(q<{ id: string }>(`select id from moyens_paiement where organisation_id = $1 and code = 'especes'`, [org]))).id;
    await q(`select public.enregistrer_mouvement_manuel($1, $2, $3, 'ajustement_plus', 50, 'Stock initial')`, [org, mag, savon]);
    await q(`select public.inviter_membre($1, 'bintou@j.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
  });
  await enTantQue(pool, bintou, (q) => q(`select public.accepter_invitations()`));
});

afterAll(async () => {
  await pool?.end();
});

describe('Journée', () => {
  it('avant la première ouverture, rien ne change (entreprise qui ne suit pas encore les journées)', async () => {
    const e = await etat(alice);
    expect(e.suivie).toBe(false);
    await expect(perte()).resolves.toBeTruthy();
  });
  it('seul le gérant ouvre la journée, à la date du serveur', async () => {
    await expect(enTantQue(pool, bintou, (q) => q(`select public.ouvrir_journee($1)`, [org]))).rejects.toThrow(/Seul le gérant/);
    const j = (await enTantQue(pool, alice, (q) => un(q<{ r: Journee }>(`select public.ouvrir_journee($1) r`, [org])))).r;
    const e = await etat(alice);
    expect(j.statut).toBe('ouverte');
    expect(j.date).toBe(e.aujourdhui);
    expect(e.ouverte?.id).toBe(j.id);
  });
  it('clôture refusée tant qu’une caisse est ouverte', async () => {
    const s = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0, $3) id`, [org, caisse, bintou])))).id;
    await enTantQue(pool, bintou, (q) => q(`select public.enregistrer_vente($1::jsonb)`, [JSON.stringify({
      id: randomUUID(), organisation_id: org, caisse_id: caisse, session_id: s, date_vente: new Date().toISOString(),
      lignes: [{ produit_id: savon, quantite: 2, prix_unitaire: 1000 }],
      reglements: [{ moyen_id: especes, montant: 2000, montant_recu: 2000 }],
    })]));
    expect((await etat(alice)).caisses_ouvertes).toHaveLength(1);
    await expect(enTantQue(pool, alice, (q) => q(`select public.cloturer_journee($1)`, [org]))).rejects.toThrow(/Clôturez d'abord les caisses/);
    await enTantQue(pool, alice, (q) => q(`select public.cloturer_session($1, 2000)`, [s]));
  });
  it('clôture : totaux de la journée, puis plus aucune opération', async () => {
    const j = (await enTantQue(pool, alice, (q) => un(q<{ r: Journee }>(`select public.cloturer_journee($1) r`, [org])))).r;
    expect(j.statut).toBe('cloturee');
    expect(Number(j.totaux?.total_ventes)).toBe(2000);
    expect(Number(j.totaux?.nombre_ventes)).toBe(1);
    expect(Number(j.totaux?.caisses)).toBe(1);
    await expect(perte()).rejects.toThrow(/journée est clôturée/);
    await expect(enTantQue(pool, alice, (q) => q(`select public.ouvrir_session($1, $2, 0, $3)`, [org, caisse, bintou]))).rejects.toThrow(/journée est clôturée/);
  });
  it('seul le gérant principal peut rouvrir la journée du jour', async () => {
    await enTantQue(pool, alice, (q) => q(`select public.ouvrir_journee($1)`, [org]));
    expect((await etat(alice)).ouverte?.statut).toBe('ouverte');
    await expect(perte()).resolves.toBeTruthy();
  });
});
