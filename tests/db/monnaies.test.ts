import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

let pool: pg.Pool;
let admin: string;
let gerant: string;
let caissier: string;
let orgXof: string;
let orgEur: string;

const un = async <T>(p: Promise<T[]>) => (await p)[0]!;

beforeAll(async () => {
  pool = await preparerBase('monnaies');
  admin = await creerCompte(pool, 'admin@df.ci', 'Administrateur');
  gerant = await creerCompte(pool, 'gerant@boutique.fr', 'Gérant');
  caissier = await creerCompte(pool, 'caisse@boutique.fr', 'Caissier');
  await enTantQue(pool, admin, (q) => q(`select public.devenir_admin_general()`));
});

afterAll(async () => {
  await pool?.end();
});

describe('monnaie de l’entreprise', () => {
  it('XOF par défaut, sans rien préciser', async () => {
    orgXof = (await enTantQue(pool, admin, (q) => un(q<{ id: string }>(
      `select public.admin_creer_entreprise('Boutique Abidjan', 'awa@x.ci') id`)))).id;
    const { rows } = await pool.query(`select devise from organisations where id = $1`, [orgXof]);
    expect(rows[0].devise).toBe('XOF');
  });

  it('l’administrateur peut créer une entreprise en euros', async () => {
    orgEur = (await enTantQue(pool, admin, (q) => un(q<{ id: string }>(
      `select public.admin_creer_entreprise('Boutique Paris', 'gerant@boutique.fr', null, 'non_precise', null, null, 'Paris', 'Magasin', 'eur') id`)))).id;
    const { rows } = await pool.query(`select devise from organisations where id = $1`, [orgEur]);
    expect(rows[0].devise).toBe('EUR');
  });

  it('une monnaie inconnue est refusée', async () => {
    await expect(enTantQue(pool, admin, (q) => q(
      `select public.admin_creer_entreprise('Boutique X', 'x@x.ci', null, 'non_precise', null, null, null, 'M', 'BTC')`))).rejects.toThrow(/organisations_devise_check/);
  });

  it('la monnaie est renvoyée avec la liste des entreprises du gérant', async () => {
    await enTantQue(pool, gerant, (q) => q(`select public.accepter_invitations()`));
    const orgs = await enTantQue(pool, gerant, (q) => q<{ nom: string; devise: string }>(`select nom, devise from public.mes_organisations()`));
    expect(orgs).toEqual([{ nom: 'Boutique Paris', devise: 'EUR' }]);
  });

  it('la console de l’administrateur indique la monnaie de chaque entreprise', async () => {
    const t = await enTantQue(pool, admin, (q) => q<{ nom: string; devise: string }>(`select nom, devise from public.admin_tableau_de_bord() order by nom`));
    expect(t).toEqual([{ nom: 'Boutique Abidjan', devise: 'XOF' }, { nom: 'Boutique Paris', devise: 'EUR' }]);
  });

  it('le gérant peut changer la monnaie tant que rien n’est enregistré', async () => {
    expect(await enTantQue(pool, gerant, (q) => un(q<{ m: boolean }>(`select public.devise_modifiable($1) m`, [orgEur])))).toEqual({ m: true });
    await enTantQue(pool, gerant, (q) => q(`update organisations set devise = 'USD' where id = $1`, [orgEur]));
    await enTantQue(pool, gerant, (q) => q(`update organisations set devise = 'EUR' where id = $1`, [orgEur]));
    const { rows } = await pool.query(`select devise from organisations where id = $1`, [orgEur]);
    expect(rows[0].devise).toBe('EUR');
  });

  it('les montants sont des centimes : 12,50 € = 1250', async () => {
    await enTantQue(pool, gerant, (q) => q(
      `insert into produits (organisation_id, designation, prix_vente) values ($1, 'Baguette', 1250)`, [orgEur]));
    const { rows } = await pool.query(`select prix_vente from produits where organisation_id = $1`, [orgEur]);
    expect(Number(rows[0].prix_vente)).toBe(1250);
  });

  it('dès qu’un article existe, la monnaie est verrouillée (les prix seraient relus dans une autre monnaie)', async () => {
    expect(await enTantQue(pool, gerant, (q) => un(q<{ m: boolean }>(`select public.devise_modifiable($1) m`, [orgEur])))).toEqual({ m: false });
    await expect(enTantQue(pool, gerant, (q) => q(`update organisations set devise = 'XOF' where id = $1`, [orgEur])))
      .rejects.toThrow(/ne peut plus être changée/);
  });

  it('une personne extérieure ne peut ni lire ni changer la monnaie', async () => {
    await expect(enTantQue(pool, caissier, (q) => q(`select public.devise_modifiable($1)`, [orgXof]))).rejects.toThrow(/Accès refusé/);
    await enTantQue(pool, caissier, (q) => q(`update organisations set devise = 'EUR' where id = $1`, [orgXof]));
    const { rows } = await pool.query(`select devise from organisations where id = $1`, [orgXof]);
    expect(rows[0].devise).toBe('XOF');
  });
});
