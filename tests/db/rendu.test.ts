import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

let pool: pg.Pool;
let alice: string;
let org: string;
let caisse: string;
let session: string;
let riz: string;
let lait: string;
const moyens: Record<string, string> = {};

const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
type Reg = { moyen: string; montant: number; montant_recu?: number; reference?: string; sens?: string };

function vente(lignes: { produit_id: string; quantite: number }[], reglements: Reg[]) {
  return {
    id: randomUUID(),
    organisation_id: org,
    caisse_id: caisse,
    session_id: session,
    lignes,
    reglements: reglements.map((r) => ({ moyen_id: moyens[r.moyen], montant: r.montant, montant_recu: r.montant_recu, reference: r.reference, sens: r.sens })),
  };
}
const enregistrer = (v: object) =>
  enTantQue(pool, alice, (q) => un(q<{ r: { numero: string; total: number } }>(`select public.enregistrer_vente($1::jsonb) r`, [JSON.stringify(v)]))).then((x) => x.r);
const totaux = () =>
  enTantQue(pool, alice, (q) => un(q<{ t: Record<string, any> }>(`select public.rapport_session($1) t`, [session]))).then((x) => x.t);

beforeAll(async () => {
  pool = await preparerBase('rendu');
  alice = await creerCompte(pool, 'alice@r.ci');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique Rendu') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    const mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    for (const m of await q<{ code: string; id: string }>(`select code, id from moyens_paiement where organisation_id = $1`, [org])) moyens[m.code] = m.id;
    riz = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Riz', 4500) returning id`, [org]))).id;
    lait = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Lait', 650) returning id`, [org]))).id;
    const r = await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]));
    await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 50, 3900), ($1, $2, $4, 50, 500)`, [org, r.id, riz, lait]);
    await q(`select public.valider_reception($1)`, [r.id]);
    session = (await un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 20000) id`, [org, caisse]))).id;
  });
});

afterAll(async () => {
  await pool?.end();
});

describe('client qui paie avec deux moyens', () => {
  it('4 400 en espèces (5 000 reçus) + 4 600 par Wave pour un ticket de 9 000', async () => {
    const r = await enregistrer(vente([{ produit_id: riz, quantite: 2 }], [
      { moyen: 'especes', montant: 4400, montant_recu: 5000 },
      { moyen: 'wave', montant: 4600, reference: 'WV-1' },
    ]));
    expect(Number(r.total)).toBe(9000);
  });
});

describe('monnaie rendue en partie par un autre moyen', () => {
  it('ticket de 5 150 payé avec 10 000 en espèces : 3 850 rendus en espèces et 1 000 par Wave', async () => {
    // espèces gardées = 10 000 − 3 850 = 6 150 ; Wave : −1 000 ; 6 150 − 1 000 = 5 150
    const r = await enregistrer(vente([{ produit_id: riz, quantite: 1 }, { produit_id: lait, quantite: 1 }], [
      { moyen: 'especes', montant: 6150, montant_recu: 10000 },
      { moyen: 'wave', montant: 1000, sens: 'rendu', reference: 'WV-RENDU-7' },
    ]));
    expect(Number(r.total)).toBe(5150);
    const { rows } = await pool.query(
      `select nature, sens, montant::int, montant_recu::int, rendu::int, reference from reglements r join ventes v on v.id = r.vente_id where v.numero = $1 order by sens`, [r.numero]);
    expect(rows).toEqual([
      { nature: 'especes', sens: 'encaissement', montant: 6150, montant_recu: 10000, rendu: 3850, reference: null },
      { nature: 'mobile', sens: 'rendu', montant: 1000, montant_recu: null, rendu: 0, reference: 'WV-RENDU-7' },
    ]);
  });

  it('les totaux de session donnent l’encaissé, le rendu et le net à reverser par moyen', async () => {
    const t = await totaux();
    // tiroir : fond 20 000 + espèces gardées 4 400 + 6 150
    expect(Number(t.especes_attendues)).toBe(30550);
    expect(Number(t.rendus_autres_moyens)).toBe(1000);
    const wave = t.par_moyen.find((m: { libelle: string }) => m.libelle === 'Wave');
    expect(wave).toMatchObject({ encaisse: 4600, rendu: 1000, montant: 3600, nombre: 1 });
    const esp = t.par_moyen.find((m: { nature: string }) => m.nature === 'especes');
    expect(esp).toMatchObject({ encaisse: 10550, rendu: 0, montant: 10550, nombre: 2 });
    // net de tous les moyens = chiffre d'affaires
    expect(t.par_moyen.reduce((s: number, m: { montant: number }) => s + Number(m.montant), 0)).toBe(Number(t.total_ventes));
  });

  it('le rendu ne peut pas se faire « en espèces » par une ligne de rendu', async () => {
    await expect(enregistrer(vente([{ produit_id: lait, quantite: 1 }], [
      { moyen: 'especes', montant: 1150, montant_recu: 2000 },
      { moyen: 'especes', montant: 500, sens: 'rendu' },
    ]))).rejects.toThrow(/seul un autre moyen/);
  });

  it('pas de rendu par Wave sans espèces reçues en trop', async () => {
    await expect(enregistrer(vente([{ produit_id: lait, quantite: 1 }], [
      { moyen: 'orange_money', montant: 1650, reference: 'OM-1' },
      { moyen: 'wave', montant: 1000, sens: 'rendu', reference: 'WV-2' },
    ]))).rejects.toThrow(/ne peut pas dépasser les espèces/);
  });

  it('les comptes doivent tomber juste : encaissements − rendus = total', async () => {
    await expect(enregistrer(vente([{ produit_id: lait, quantite: 1 }], [
      { moyen: 'especes', montant: 2000, montant_recu: 2000 },
      { moyen: 'wave', montant: 1000, sens: 'rendu', reference: 'WV-3' },
    ]))).rejects.toThrow(/ne correspondent pas/);
  });

  it('un sens inconnu est refusé', async () => {
    await expect(enregistrer(vente([{ produit_id: lait, quantite: 1 }], [
      { moyen: 'especes', montant: 650, sens: 'cadeau' },
    ]))).rejects.toThrow(/Sens de règlement invalide/);
  });

  it('la clôture compare le tiroir aux espèces gardées (rendu Wave déjà déduit)', async () => {
    const z = await enTantQue(pool, alice, (q) => un(q<{ z: Record<string, any> }>(`select public.cloturer_session($1, 30550, null, null) z`, [session]))).then((x) => x.z);
    expect(Number(z.ecart)).toBe(0);
    expect(Number(z.rendus_autres_moyens)).toBe(1000);
  });
});
