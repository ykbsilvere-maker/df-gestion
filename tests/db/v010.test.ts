import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// v0.10 : code de caisse, tiroir (dépenses, sorties, apports), arrivages comptés, créances, devis, tableau de bord.
let pool: pg.Pool;
let alice: string;
let carine: string;
let org: string;
let mag: string;
let caisse: string;
let riz: string;
let huile: string;
let banque: string;
let wave: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const commeAlice = <R>(fn: (q: <T = Record<string, unknown>>(sql: string, p?: unknown[]) => Promise<T[]>) => Promise<R>) => enTantQue(pool, alice, fn);

beforeAll(async () => {
  pool = await preparerBase('v010');
  alice = await creerCompte(pool, 'alice@v.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@v.ci', 'Carine');
  org = (await commeAlice((q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique v0.10') id`)))).id;
  await commeAlice(async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    banque = (await un(q<{ id: string }>(`select id from comptes_tresorerie where organisation_id = $1 and type = 'banque'`, [org]))).id;
    wave = (await un(q<{ id: string }>(`select id from comptes_tresorerie where organisation_id = $1 and nom = 'Wave'`, [org]))).id;
    riz = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Riz 25 kg', 18000) returning id`, [org]))).id;
    huile = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Huile 5 L', 6500) returning id`, [org]))).id;
    await q(`select public.inviter_membre($1, 'carine@v.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
});

afterAll(async () => {
  await pool?.end();
});

describe('Code de caisse', () => {
  it('refuse les codes trop simples, vérifie et bloque après 5 essais', async () => {
    await expect(enTantQue(pool, carine, (q) => q(`select public.definir_code_caisse($1, '1111')`, [org]))).rejects.toThrow(/simple/);
    await enTantQue(pool, carine, (q) => q(`select public.definir_code_caisse($1, '2580')`, [org]));
    const ok = await enTantQue(pool, carine, (q) => un(q<{ r: { ok: boolean } }>(`select public.verifier_code_caisse($1, '2580') r`, [org])));
    expect(ok.r.ok).toBe(true);
    let dernier: { ok: boolean; bloque_jusqu?: string | null } = { ok: true };
    for (let i = 0; i < 5; i++)
      dernier = (await enTantQue(pool, carine, (q) => un(q<{ r: typeof dernier }>(`select public.verifier_code_caisse($1, '0000') r`, [org])))).r;
    expect(dernier.ok).toBe(false);
    expect(dernier.bloque_jusqu).toBeTruthy();
    const bloque = await enTantQue(pool, carine, (q) => un(q<{ r: { ok: boolean } }>(`select public.verifier_code_caisse($1, '2580') r`, [org])));
    expect(bloque.r.ok).toBe(false);
    // L'empreinte n'est jamais lisible par l'application.
    await expect(enTantQue(pool, carine, (q) => q(`select * from prive.codes_caisse`))).rejects.toThrow();
  });
});

describe('Arrivage annoncé puis compté', () => {
  it('garde les écarts et retient les quantités comptées', async () => {
    const r = await commeAlice(async (q) => {
      const id = (await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]))).id;
      await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 20, 15000), ($1, $2, $4, 10, 5000)`, [org, id, riz, huile]);
      await q(`select public.annoncer_reception($1)`, [id]);
      return id;
    });
    await expect(commeAlice((q) => q(`select public.valider_reception($1)`, [r]))).rejects.toThrow(/Comptage incomplet/);
    await commeAlice(async (q) => {
      const id = r;
      await q(`update receptions_lignes set quantite_comptee = 18 where reception_id = $1 and produit_id = $2`, [id, riz]);
      await q(`update receptions_lignes set quantite_comptee = 0 where reception_id = $1 and produit_id = $2`, [id, huile]);
      await q(`select public.valider_reception($1)`, [id]);
    });
    const { rows } = await pool.query(`select ecarts_controle from receptions where id = $1`, [r]);
    expect(rows[0].ecarts_controle).toHaveLength(2);
    const lignes = await pool.query(`select produit_id, quantite from receptions_lignes where reception_id = $1`, [r]);
    expect(lignes.rows).toHaveLength(1);
    expect(Number(lignes.rows[0].quantite)).toBe(18);
  });
});

describe('Tiroir-caisse', () => {
  it('dépenses, sorties et apports changent les espèces attendues ; historique des clôtures', async () => {
    const ouverte = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 10000, $3) id`, [org, caisse, carine])))).id;
    const session = await enTantQue(pool, carine, async (q) => {
      const s = ouverte;
      const especes = (await un(q<{ id: string }>(`select id from moyens_paiement where organisation_id = $1 and code = 'especes'`, [org]))).id;
      await q(`select public.enregistrer_vente($1::jsonb)`, [JSON.stringify({
        id: randomUUID(), organisation_id: org, caisse_id: caisse, session_id: s, date_vente: new Date().toISOString(),
        lignes: [{ produit_id: riz, quantite: 2, prix_unitaire: 18000 }],
        reglements: [{ moyen_id: especes, montant: 36000, montant_recu: 40000 }],
      })]);
      await q(`select public.mouvement_caisse($1, 'depense', 2000, 'Sachets')`, [s]);
      await q(`select public.mouvement_caisse($1, 'sortie', 20000, 'Versement banque', null, $2)`, [s, banque]);
      await q(`select public.mouvement_caisse($1, 'apport', 5000, 'Monnaie', null, $2)`, [s, wave]);
      return s;
    });
    const t = await enTantQue(pool, carine, (q) => un(q<{ r: Record<string, number> }>(`select public.rapport_session($1) r`, [session])));
    expect(Number(t.r.especes_attendues)).toBe(10000 + 36000 - 2000 - 20000 + 5000);
    const z = await enTantQue(pool, carine, (q) => un(q<{ r: { ecart: number } }>(`select public.cloturer_session($1, 29000) r`, [session])));
    expect(Number(z.r.ecart)).toBe(0);
    const h = await enTantQue(pool, carine, (q) => un(q<{ r: unknown[] }>(`select public.historique_clotures($1) r`, [org])));
    expect(h.r).toHaveLength(1);
  });
});

describe('Créances clients', () => {
  it('balance âgée, imputation des paiements aux plus anciennes, relance, trésorerie', async () => {
    const cl = await commeAlice(async (q) => {
      const c = (await un(q<{ id: string }>(`insert into clients (organisation_id, nom) values ($1, 'Boutique Awa') returning id`, [org]))).id;
      await q(`select public.enregistrer_creance($1, $2, 100000, current_date - 75, current_date - 45, 'Facture 12', 'F-12')`, [org, c]);
      await q(`select public.enregistrer_creance($1, $2, 50000, current_date - 10, current_date + 20, 'Facture 30', 'F-30')`, [org, c]);
      await q(`select public.encaisser_creance($1, $2, null, 30000, $3, current_date, 'W123')`, [org, c, wave]);
      return c;
    });
    await expect(commeAlice((q) => q(`select public.encaisser_creance($1, $2, null, 500000, $3)`, [org, cl, wave]))).rejects.toThrow(/ne doit que/);
    const b = await commeAlice((q) => un(q<{ r: { clients: Record<string, number>[] } }>(`select public.balance_agee($1) r`, [org])));
    expect(b.r.clients[0]).toMatchObject({ total: 120000, non_echu: 50000, j60: 70000 });
    const rel = await commeAlice((q) => un(q<{ r: { montant_echu: number } }>(`select public.enregistrer_relance($1, 1::smallint) r`, [cl])));
    expect(Number(rel.r.montant_echu)).toBe(70000);
    await expect(enTantQue(pool, carine, (q) => q(`select public.balance_agee($1)`, [org]))).rejects.toThrow(/tresorerie/);
  });
});

describe('Devis', () => {
  it('numérote et calcule les totaux, sans saisie possible du total', async () => {
    const d = await commeAlice(async (q) => {
      const id = (await un(q<{ id: string }>(`insert into devis (organisation_id, magasin_id, client_nom) values ($1, $2, 'Mairie') returning id`, [org, mag]))).id;
      await q(`insert into devis_lignes (organisation_id, devis_id, produit_id, designation, quantite, prix_unitaire, remise) values ($1, $2, $3, 'Riz 25 kg', 10, 18000, 5000)`, [org, id, riz]);
      return id;
    });
    await expect(commeAlice((q) => q(`update devis set total = 1 where id = $1`, [d]))).rejects.toThrow(/permission/);
    const { rows } = await pool.query(`select numero, total, total_remises from devis where id = $1`, [d]);
    expect(rows[0]).toMatchObject({ numero: 'D-000001' });
    expect(Number(rows[0].total)).toBe(175000);
    await expect(enTantQue(pool, carine, (q) => q(`insert into devis (organisation_id, magasin_id) values ($1, $2)`, [org, mag]))).rejects.toThrow(/row-level/);
  });
});

describe('Tableau de bord', () => {
  it('donne le chiffre d’affaires et une série complète selon la période', async () => {
    const m = await commeAlice((q) => un(q<{ r: { ca: number; serie: unknown[] } }>(`select public.tableau_de_bord($1, 'mois') r`, [org])));
    expect(Number(m.r.ca)).toBe(36000);
    const j = await commeAlice((q) => un(q<{ r: { serie: unknown[] } }>(`select public.tableau_de_bord($1, 'jour') r`, [org])));
    expect(j.r.serie).toHaveLength(24);
    const a = await commeAlice((q) => un(q<{ r: { serie: unknown[] } }>(`select public.tableau_de_bord($1, 'annee') r`, [org])));
    expect(a.r.serie).toHaveLength(12);
  });
});
