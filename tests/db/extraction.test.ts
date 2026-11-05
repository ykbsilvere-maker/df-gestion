import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// v0.8 : extraction des ventes (vues, droits, marges masquées) et grille d'habilitations.
let pool: pg.Pool;
let alice: string; // propriétaire
let carine: string; // caissière
let org: string;
let mag: string;
let caisse: string;
let session: string;
let riz: string;
let lait: string;
let especes: string;
let membreCarine: string;

const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const aujourdHui = new Date().toISOString().slice(0, 10);

type Extraction = {
  marges_visibles: boolean;
  lignes: Record<string, unknown>[];
  totaux: Record<string, number>;
};
const extraire = (uid: string, vue: string, extra: Record<string, unknown> = {}) =>
  enTantQue(pool, uid, (q) =>
    un(
      q<{ r: Extraction }>(
        `select public.extraction_ventes($1, $2::date, $3::date, $4, coalesce($5, 'jour'), null, null, null, null, coalesce($6, false)) r`,
        [org, aujourdHui, aujourdHui, vue, extra.frequence ?? null, extra.annulees ?? null],
      ),
    ),
  ).then((x) => x.r);

beforeAll(async () => {
  pool = await preparerBase('extraction');
  alice = await creerCompte(pool, 'alice@x.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@x.ci', 'Carine');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique Extraction') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    especes = (await un(q<{ id: string }>(`select id from moyens_paiement where organisation_id = $1 and code = 'especes'`, [org]))).id;
    const p = async (d: string, prix: number) =>
      (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, $2, $3) returning id`, [org, d, prix]))).id;
    riz = await p('Riz 5 kg', 4500);
    lait = await p('Lait concentré', 650);
    const r = await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]));
    await q(
      `insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 10, 3900), ($1, $2, $4, 24, 500)`,
      [org, r.id, riz, lait],
    );
    await q(`select public.valider_reception($1)`, [r.id]);
    await q(`select public.inviter_membre($1, 'carine@x.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
    session = (await un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0) id`, [org, caisse]))).id;
    const vendre = (lignes: { produit_id: string; quantite: number; prix_unitaire: number }[], total: number) =>
      q(`select public.enregistrer_vente($1::jsonb)`, [
        JSON.stringify({
          id: randomUUID(),
          organisation_id: org,
          caisse_id: caisse,
          session_id: session,
          date_vente: new Date().toISOString(),
          lignes,
          reglements: [{ moyen_id: especes, montant: total, montant_recu: total }],
        }),
      ]);
    await vendre([{ produit_id: riz, quantite: 2, prix_unitaire: 4500 }], 9000);
    await vendre([{ produit_id: riz, quantite: 1, prix_unitaire: 4500 }, { produit_id: lait, quantite: 3, prix_unitaire: 650 }], 6450);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
  membreCarine = (await pool.query(`select id from membres where user_id = $1`, [carine])).rows[0].id;
});

afterAll(async () => {
  await pool?.end();
});

describe('Extraction des ventes', () => {
  it('par produit : quantités, chiffre d’affaires, coût et marge', async () => {
    const r = await extraire(alice, 'produits');
    expect(r.marges_visibles).toBe(true);
    const parNom = Object.fromEntries(r.lignes.map((l) => [l.designation, l]));
    expect(Number(parNom['Riz 5 kg']!.quantite)).toBe(3);
    expect(Number(parNom['Riz 5 kg']!.chiffre_affaires)).toBe(13500);
    expect(Number(parNom['Riz 5 kg']!.cout)).toBe(11700);
    expect(Number(parNom['Lait concentré']!.marge)).toBe(1950 - 1500);
    expect(r.totaux).toMatchObject({ tickets: 2, chiffre_affaires: 15450, cout: 13200, marge: 2250 });
  });

  it('par ticket, par période et par paiement : mêmes totaux', async () => {
    const t = await extraire(alice, 'tickets');
    expect(t.lignes.map((l) => l.numero)).toEqual(['T-000001', 'T-000002']);
    const p = await extraire(alice, 'periodes', { frequence: 'mois' });
    expect(p.lignes).toHaveLength(1);
    expect(Number(p.lignes[0]!.chiffre_affaires)).toBe(15450);
    const pa = await extraire(alice, 'paiements');
    expect(Number(pa.lignes[0]!.net)).toBe(15450);
  });

  it('refuse l’extraction sans droit, et masque les marges sans « comptabilite.consulter »', async () => {
    await expect(extraire(carine, 'produits')).rejects.toThrow(/ventes.exporter/);
    const nouveaux = await enTantQue(pool, alice, (q) =>
      un(q<{ r: string[] }>(`select public.definir_permissions_membre($1, $2) r`, [membreCarine, ['caisse.consulter', 'caisse.creer', 'catalogue.consulter', 'ventes.exporter']])),
    );
    expect(nouveaux.r).toEqual(['caisse.consulter', 'caisse.creer', 'catalogue.consulter', 'ventes.exporter']);
    const r = await extraire(carine, 'produits');
    expect(r.marges_visibles).toBe(false);
    // Coût et marge ne sont jamais renvoyés (valeur vide) sans le droit.
    expect(r.lignes[0]!.cout ?? null).toBeNull();
    expect(r.lignes[0]!.marge ?? null).toBeNull();
    expect(r.lignes[0]!.taux_marge ?? null).toBeNull();
    expect(r.totaux).not.toHaveProperty('marge');
  });
});

describe('Grille d’habilitations', () => {
  it('ne garde comme exceptions que les écarts avec le rôle', async () => {
    const { rows } = await pool.query(`select permission_code, accorde from membre_permissions where membre_id = $1 order by 1`, [membreCarine]);
    const roleCaissier = (await pool.query(`select permission_code from role_permissions where role_code = 'caissier'`)).rows.map((x) => x.permission_code);
    for (const r of rows) expect(r.accorde).toBe(!roleCaissier.includes(r.permission_code));
    // Remettre exactement les droits du rôle efface toutes les exceptions.
    await enTantQue(pool, alice, (q) => q(`select public.definir_permissions_membre($1, $2)`, [membreCarine, roleCaissier]));
    const apres = await pool.query(`select count(*)::int n from membre_permissions where membre_id = $1`, [membreCarine]);
    expect(apres.rows[0].n).toBe(0);
  });

  it('une caissière ne peut pas modifier les droits, ni un propriétaire', async () => {
    await expect(enTantQue(pool, carine, (q) => q(`select public.definir_permissions_membre($1, $2)`, [membreCarine, []]))).rejects.toThrow();
    const membreAlice = (await pool.query(`select id from membres where user_id = $1`, [alice])).rows[0].id;
    await expect(enTantQue(pool, alice, (q) => q(`select public.definir_permissions_membre($1, $2)`, [membreAlice, []]))).rejects.toThrow();
  });

  it('refuse une permission inconnue', async () => {
    await expect(enTantQue(pool, alice, (q) => q(`select public.definir_permissions_membre($1, $2)`, [membreCarine, ['pirate.tout']]))).rejects.toThrow(/inconnue/);
  });
});
