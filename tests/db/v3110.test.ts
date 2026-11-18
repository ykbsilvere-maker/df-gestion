import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// v3.11 — Annulation d'une vente après la clôture de la caisse (gérant principal).

let pool: pg.Pool;
let alice: string; // propriétaire (gérant principal)
let carine: string; // caissière
let robert: string; // responsable de caisse
let org: string;
let mag: string;
let caisse: string;
let session: string;
let riz: string;
let especes: string;

const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const n = (v: unknown) => Number(v);

async function stockRiz() {
  const { rows } = await pool.query(`select quantite from stocks where magasin_id = $1 and produit_id = $2`, [mag, riz]);
  return n(rows[0]?.quantite ?? 0);
}

const venteRiz = () => ({
  id: randomUUID(),
  organisation_id: org,
  caisse_id: caisse,
  session_id: session,
  date_vente: new Date().toISOString(),
  lignes: [{ produit_id: riz, quantite: 2, prix_unitaire: 4500 }],
  reglements: [{ moyen_id: especes, montant: 9000 }],
});

beforeAll(async () => {
  pool = await preparerBase('v3110');
  alice = await creerCompte(pool, 'alice@v3110.ci');
  carine = await creerCompte(pool, 'carine@v3110.ci');
  robert = await creerCompte(pool, 'robert@v3110.ci');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Caisse 3.11') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    especes = (await un(q<{ id: string }>(`select id from moyens_paiement where organisation_id = $1 and code = 'especes'`, [org]))).id;
    riz = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Riz 5 kg', 4500) returning id`, [org]))).id;
    const r = await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]));
    await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 20, 3800)`, [org, r.id, riz]);
    await q(`select public.valider_reception($1)`, [r.id]);
    await q(`select public.inviter_membre($1, 'carine@v3110.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
    await q(`select public.inviter_membre($1, 'robert@v3110.ci', 'responsable_caisse', false, $2)`, [org, [mag]]);
    session = (await un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0, $3) id`, [org, caisse, carine]))).id;
  });
});

afterAll(async () => {
  await pool?.end();
});

describe('Annulation après clôture', () => {
  it('une vente saisie deux fois : seul le gérant principal l’annule, stock et espèces reviennent justes', async () => {
    const v1 = venteRiz();
    const v2 = venteRiz();
    await enTantQue(pool, carine, (q) => q(`select public.enregistrer_vente($1::jsonb)`, [JSON.stringify(v1)]));
    await enTantQue(pool, carine, (q) => q(`select public.enregistrer_vente($1::jsonb)`, [JSON.stringify(v2)]));
    expect(await stockRiz()).toBe(16);
    const z = await enTantQue(pool, carine, (q) =>
      un(q<{ r: { ecart: number } }>(`select public.cloturer_session($1, 9000, null, 'Double saisie ?') r`, [session])),
    ).then((x) => x.r);
    expect(n(z.ecart)).toBe(-9000);

    await expect(enTantQue(pool, carine, (q) => q(`select public.annuler_vente($1, 'Double saisie')`, [v2.id]))).rejects.toThrow(/ventes.annuler/);
    await expect(enTantQue(pool, robert, (q) => q(`select public.annuler_vente($1, 'Double saisie')`, [v2.id]))).rejects.toThrow(/gérant principal/);
    await enTantQue(pool, alice, (q) => q(`select public.annuler_vente($1, 'Double saisie par erreur')`, [v2.id]));

    expect(await stockRiz()).toBe(18);
    const { rows } = await pool.query(`select especes_attendues, especes_comptees, ecart, totaux from sessions_caisse where id = $1`, [session]);
    expect(n(rows[0].especes_attendues)).toBe(9000);
    expect(n(rows[0].ecart)).toBe(0);
    expect(n(rows[0].totaux.nombre_annulations)).toBe(1);
    const rg = await pool.query(`select statut from reglements where vente_id = $1`, [v2.id]);
    expect(rg.rows[0].statut).toBe('annule');
    const a = await pool.query(`select contexte from journal_audit where action = 'ventes.annulation_apres_cloture'`);
    expect(a.rows[0].contexte).toMatchObject({ motif: 'Double saisie par erreur', avant: { ecart: -9000, especes_attendues: 18000 } });
    await expect(enTantQue(pool, alice, (q) => q(`select public.annuler_vente($1, 'Encore')`, [v2.id]))).rejects.toThrow(/déjà annulée/);
  });
});
