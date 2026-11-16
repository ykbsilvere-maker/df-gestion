import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 3.4 : fichier clients (particulier / entreprise), créances réunies dans « Crédits clients »,
// exemples de test sans effet sur le stock, la trésorerie et la comptabilité, bilan avec
// l'ancienneté des créances clients.
let pool: pg.Pool;
let alice: string; // gérante principale
let gerard: string; // gérant de magasin : ventes.valider, pas de trésorerie
let org: string;
let mag: string;
let client: string;
let riz: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;

interface Fiche { id: string; nom: string; type_client: string; exemple: boolean; encours: number; etape: number; ncc: string | null; rccm: string | null }
interface Dossier { id: string; client: string; etape: number; statut: string }

beforeAll(async () => {
  pool = await preparerBase('v340');
  alice = await creerCompte(pool, 'alice@fc.ci', 'Alice');
  gerard = await creerCompte(pool, 'gerard@fc.ci', 'Gérard');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Fichier & Cie') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    riz = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Riz 25 kg', 18000) returning id`, [org]))).id;
    await q(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Huile 5 L', 7500), ($1, 'Sucre 1 kg', 900)`, [org]);
    const r = await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]));
    await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 10, 15000)`, [org, r.id, riz]);
    await q(`select public.valider_reception($1)`, [r.id]);
    client = (await un(q<{ id: string }>(`insert into clients (organisation_id, nom, telephone, delai_paiement, type_client, ncc, rccm)
      values ($1, 'Société Kadjo SARL', '0700000001', 30, 'entreprise', '1234567A', 'CI-ABJ-2020-B-1234') returning id`, [org]))).id;
    // Un vrai crédit validé.
    const d = (await un(q<{ id: string }>(`select public.enregistrer_credit($1::jsonb) id`, [
      JSON.stringify({ organisation_id: org, magasin_id: mag, client_id: client, duree_jours: 15, lignes: [{ produit_id: riz, quantite: 2 }] }),
    ]))).id;
    await q(`select public.valider_credit($1)`, [d]);
    await q(`select public.inviter_membre($1, 'gerard@fc.ci', 'gerant_magasin', false, $2)`, [org, [mag]]);
  });
  await enTantQue(pool, gerard, (q) => q(`select public.accepter_invitations()`));
});
afterAll(async () => {
  await pool?.end();
});

const stockRiz = () =>
  enTantQue(pool, alice, (q) => un(q<{ q: string }>(`select quantite q from stocks where magasin_id = $1 and produit_id = $2`, [mag, riz]))).then((x) => Number(x.q));

describe('Fichier clients et créances dans « Crédits clients »', () => {
  it('enregistre un particulier, avec ou sans NCC / RCCM', async () => {
    await enTantQue(pool, gerard, async (q) => {
      await q(`insert into clients (organisation_id, nom, type_client, piece_identite) values ($1, 'Mme Aya Koffi', 'particulier', 'CNI C00123456')`, [org]);
      await q(`insert into clients (organisation_id, nom, type_client, ncc) values ($1, 'M. Konan (commerçant)', 'particulier', '7654321B')`, [org]);
    });
    const f = await enTantQue(pool, gerard, (q) => un(q<{ f: Fiche[] }>(`select public.fichier_clients($1) f`, [org])));
    const aya = f.f.find((c) => c.nom === 'Mme Aya Koffi')!;
    expect(aya.type_client).toBe('particulier');
    expect(aya.ncc).toBeNull();
    expect(f.f.find((c) => c.nom === 'M. Konan (commerçant)')!.ncc).toBe('7654321B');
    const kadjo = f.f.find((c) => c.id === client)!;
    expect(kadjo.rccm).toBe('CI-ABJ-2020-B-1234');
    expect(Number(kadjo.encours)).toBe(36000);
    // Le type de client est contrôlé.
    await expect(enTantQue(pool, gerard, (q) => q(`insert into clients (organisation_id, nom, type_client) values ($1, 'X', 'association')`, [org]))).rejects.toThrow();
    // Le marqueur « exemple » reste réservé au serveur.
    await expect(enTantQue(pool, gerard, (q) => q(`insert into clients (organisation_id, nom, exemple) values ($1, 'Faux exemple', true)`, [org]))).rejects.toThrow(/permission/);
  });

  it('le gérant (sans droit trésorerie) lit la balance âgée et le relevé, et reprend une créance existante', async () => {
    await enTantQue(pool, gerard, async (q) => {
      const droits = await un(q<{ t: boolean; v: boolean }>(`select prive.a_permission($1, 'tresorerie.consulter') t, prive.a_permission($1, 'ventes.valider') v`, [org]));
      expect(droits).toEqual({ t: false, v: true });
      const b = (await un(q<{ b: { clients: { id: string; etape: number; type_client: string }[] } }>(`select public.balance_agee($1) b`, [org]))).b;
      const l = b.clients.find((c) => c.id === client)!;
      expect(l.etape).toBe(0);
      expect(l.type_client).toBe('entreprise');
      const r = (await un(q<{ r: { creances: { credit_id: string | null }[] } }>(`select public.releve_client($1) r`, [client]))).r;
      expect(r.creances[0]!.credit_id).toBeTruthy();
      await q(`select public.enregistrer_creance($1, $2, 12000, current_date - 40, current_date - 10, 'Reprise de l''ancien cahier', 'CAH-01')`, [org, client]);
      const r2 = (await un(q<{ r: { solde: number; creances: { credit_id: string | null }[] } }>(`select public.releve_client($1) r`, [client]))).r;
      expect(Number(r2.solde)).toBe(48000);
      expect(r2.creances.some((c) => c.credit_id === null)).toBe(true);
      // Les créances et relances se lisent aussi directement.
      expect((await q(`select id from creances where client_id = $1`, [client])).length).toBe(2);
      await q(`select public.enregistrer_relance($1, 1::smallint)`, [client]);
    });
  });

  it('crée des exemples à tous les stades, sans toucher au stock', async () => {
    const avant = await stockRiz();
    const ex = await enTantQue(pool, alice, (q) => un(q<{ r: { clients: number; credits: number } }>(`select public.creer_exemples_credits($1) r`, [org])));
    expect(ex.r).toEqual({ clients: 3, credits: 5 });
    expect(await stockRiz()).toBe(avant);
    await expect(enTantQue(pool, alice, (q) => q(`select public.creer_exemples_credits($1)`, [org]))).rejects.toThrow(/existent déjà/);
    const l = await enTantQue(pool, alice, (q) => un(q<{ l: { dossiers: Dossier[] } }>(`select public.credits_liste($1) l`, [org])));
    const etapes = l.l.dossiers.filter((d) => d.client.startsWith('[TEST]')).map((d) => d.etape).sort();
    expect(etapes).toEqual([0, 1, 2, 3, 4]);
    const f = await enTantQue(pool, alice, (q) => un(q<{ f: Fiche[] }>(`select public.fichier_clients($1) f`, [org])));
    const tests = f.f.filter((c) => c.exemple);
    expect(tests.map((c) => c.type_client).sort()).toEqual(['entreprise', 'particulier', 'particulier']);
    // Un caissier ou le gérant sans création de client ne peut pas en créer.
  });

  it('les exemples restent hors comptabilité et ne peuvent pas être accordés', async () => {
    await enTantQue(pool, alice, async (q) => {
      const b = (await un(q<{ b: { actif: { creances_clients: number }; balance_agee: { total: number; clients: number } } }>(`select public.bilan_simplifie($1) b`, [org]))).b;
      // 36 000 (crédit) + 12 000 (reprise) : les exemples sont exclus.
      expect(Number(b.balance_agee.total)).toBe(48000);
      expect(Number(b.balance_agee.clients)).toBe(1);
      expect(Number(b.actif.creances_clients)).toBe(48000);
      const ecr = await un(q<{ n: string }>(`select count(*) n from ecritures e where e.organisation_id = $1 and e.piece_type = 'creance'
        and e.piece_id in (select id from creances where exemple)`, [org]));
      expect(Number(ecr.n)).toBe(0);
      const cx = (await un(q<{ id: string }>(`select id from clients where organisation_id = $1 and exemple limit 1`, [org]))).id;
      const dx = (await un(q<{ id: string }>(`select public.enregistrer_credit($1::jsonb) id`, [
        JSON.stringify({ organisation_id: org, magasin_id: mag, client_id: cx, lignes: [{ produit_id: riz, quantite: 1 }] }),
      ]))).id;
      expect((await un(q<{ e: boolean }>(`select exemple e from credits where id = $1`, [dx]))).e).toBe(true);
    });
    const dx = await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select id from credits where exemple and statut = 'brouillon'`)));
    await expect(enTantQue(pool, alice, (q) => q(`select public.valider_credit($1, 'test')`, [dx.id]))).rejects.toThrow(/exemple/);
  });

  it('supprime les exemples d’un clic, les vrais dossiers restent', async () => {
    await expect(enTantQue(pool, gerard, (q) => q(`select public.supprimer_exemples_credits($1)`, [org]))).resolves.toBeTruthy();
    await enTantQue(pool, alice, async (q) => {
      expect((await q(`select id from clients where organisation_id = $1 and exemple`, [org])).length).toBe(0);
      expect((await q(`select id from credits where organisation_id = $1 and exemple`, [org])).length).toBe(0);
      expect((await q(`select id from creances where organisation_id = $1 and exemple`, [org])).length).toBe(0);
      expect((await q(`select id from credits where organisation_id = $1 and statut = 'valide'`, [org])).length).toBe(1);
    });
  });
});
