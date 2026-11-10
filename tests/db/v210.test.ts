import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 2.1 : import en masse (catalogue, fournisseurs, approvisionnement) depuis un fichier Excel.
let pool: pg.Pool;
let alice: string;
let bintou: string;
let org: string;
let mag: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
interface Resultat { crees: number; mis_a_jour: number; erreurs: number; ignores?: number; lignes: { ligne: number; statut: string; message?: string; code?: string }[] }

beforeAll(async () => {
  pool = await preparerBase('v210');
  alice = await creerCompte(pool, 'alice@i.ci', 'Alice');
  bintou = await creerCompte(pool, 'bintou@i.ci', 'Bintou');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique I') id`)))).id;
  mag = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org])))).id;
  await enTantQue(pool, alice, (q) => q(`select public.inviter_membre($1, 'bintou@i.ci', 'caissier', false, $2, '{}')`, [org, [mag]]));
  await enTantQue(pool, bintou, (q) => q(`select public.accepter_invitations()`));
});

afterAll(async () => {
  await pool?.end();
});

const importer = (uid: string, lignes: unknown[], maj = true) =>
  enTantQue(pool, uid, (q) => un(q<{ r: Resultat }>(`select public.importer_catalogue($1, $2::jsonb, $3) r`, [org, JSON.stringify(lignes), maj]))).then((x) => x.r);

describe('Import du catalogue', () => {
  it('crée les articles, les catégories et les codes-barres ; une ligne fausse n’arrête pas les autres', async () => {
    const r = await importer(alice, [
      { designation: 'Riz parfumé 5 kg', categorie: 'Épicerie', prix_vente: '4 500', prix_achat: 3800, code_barres: '6151100000017', unite: 'sac' },
      { designation: 'Huile Dinor 1 L', categorie: 'epicerie', prix_vente: 1600, taux_tva: '0,18' },
      { designation: 'X' },
      { code: 'SAV-01', designation: 'Savon Omo 500 g', prix_vente: 900 },
    ]);
    expect([r.crees, r.erreurs]).toEqual([3, 1]);
    expect(r.lignes[2]).toMatchObject({ ligne: 3, statut: 'erreur', message: 'Désignation manquante' });
    expect(r.lignes[3]!.code).toBe('SAV-01');
    const cats = await enTantQue(pool, alice, (q) => q<{ nom: string }>(`select nom from categories where organisation_id = $1`, [org]));
    expect(cats).toHaveLength(1); // « Épicerie » et « epicerie » = même catégorie
    const huile = await enTantQue(pool, alice, (q) => un(q<{ taux_tva: string }>(`select taux_tva from produits where designation = 'Huile Dinor 1 L'`)));
    expect(Number(huile.taux_tva)).toBe(18);
  });
  it('retrouve l’article existant (code-barres, code ou désignation) et le met à jour', async () => {
    const r = await importer(alice, [
      { designation: 'Riz parfumé 5kg (sac)', code_barres: '6151100000017', prix_vente: 4700 },
      { designation: 'huile dinor 1 l', prix_vente: 1650 },
    ]);
    expect([r.crees, r.mis_a_jour]).toEqual([0, 2]);
    const riz = await enTantQue(pool, alice, (q) => un(q<{ prix_vente: string; prix_achat: string }>(`select prix_vente, prix_achat from produits where organisation_id = $1 and designation like 'Riz%'`, [org])));
    expect([Number(riz.prix_vente), Number(riz.prix_achat)]).toEqual([4700, 3800]);
  });
  it('sans mise à jour, les existants sont ignorés', async () => {
    const r = await importer(alice, [{ designation: 'Savon Omo 500 g', prix_vente: 1 }], false);
    expect(r.ignores).toBe(1);
  });
  it('un caissier ne peut pas importer', async () => {
    await expect(importer(bintou, [{ designation: 'Test', prix_vente: 1 }])).rejects.toThrow(/catalogue.creer/);
  });
});

describe('Import des fournisseurs', () => {
  it('crée puis complète sans doublon', async () => {
    const r1 = (await enTantQue(pool, alice, (q) => un(q<{ r: Resultat }>(`select public.importer_fournisseurs($1, $2::jsonb) r`, [org,
      JSON.stringify([{ nom: 'SOCOCE Distribution', telephone: '27 22 00 00 00' }, { nom: 'Prosuma' }, { nom: '' }])])))).r;
    expect([r1.crees, r1.erreurs]).toEqual([2, 1]);
    const r2 = (await enTantQue(pool, alice, (q) => un(q<{ r: Resultat }>(`select public.importer_fournisseurs($1, $2::jsonb) r`, [org,
      JSON.stringify([{ nom: 'sococe distribution', email: 'commandes@sococe.ci' }])])))).r;
    expect(r2.mis_a_jour).toBe(1);
  });
});

describe('Import d’un approvisionnement', () => {
  it('une réception brouillon par fournisseur ; articles absents créés ; rien n’entre en stock avant validation', async () => {
    const r = (await enTantQue(pool, alice, (q) => un(q<{ r: { lignes_ajoutees: number; erreurs: number; articles_crees: number; receptions: { id: string; fournisseur: string; lignes: number }[] } }>(
      `select public.importer_reception($1, $2::jsonb, $3::jsonb) r`, [org,
        JSON.stringify({ magasin_id: mag, fournisseur: 'Prosuma', reference: 'BL-2026-118' }),
        JSON.stringify([
          { code_barres: '6151100000017', quantite: 20, prix_achat: 3750 },
          { designation: 'Huile Dinor 1 L', quantite: '24' },
          { fournisseur: 'SOCOCE Distribution', designation: 'Lait Bonnet Rouge 400 g', quantite: 48, prix_achat: 600, prix_vente: 750, categorie: 'Épicerie' },
          { designation: 'Article inconnu sans quantité' },
        ])])))).r;
    expect([r.lignes_ajoutees, r.erreurs, r.articles_crees]).toEqual([3, 1, 1]);
    expect(r.receptions.map((x) => [x.fournisseur, Number(x.lignes)]).sort()).toEqual([['Prosuma', 2], ['SOCOCE Distribution', 1]]);
    const statuts = await enTantQue(pool, alice, (q) => q<{ statut: string }>(`select statut from receptions where organisation_id = $1`, [org]));
    expect(statuts.every((s) => s.statut === 'brouillon')).toBe(true);
    const stock = await enTantQue(pool, alice, (q) => q(`select * from stocks where organisation_id = $1 and quantite <> 0`, [org]));
    expect(stock).toHaveLength(0);
  });
});
