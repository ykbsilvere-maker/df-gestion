import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 3.21 : zones de livraison modifiables et supprimables (journalisé).
let pool: pg.Pool;
let alice: string;
let intrus: string;
let org: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;

beforeAll(async () => {
  pool = await preparerBase('v3210');
  alice = await creerCompte(pool, 'alice@v321.ci', 'Alice');
  intrus = await creerCompte(pool, 'intrus@v321.ci', 'Intrus');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Chez Alice') id`)))).id;
});
afterAll(async () => {
  await pool?.end();
});

describe('Zones de livraison', () => {
  it('modifier puis supprimer une zone', async () => {
    const id = await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.zone_livraison_enregistrer($1, $2) id`, [org, JSON.stringify({ nom: 'Koumass', frais: 1500 })]))).then((x) => x.id);
    await enTantQue(pool, alice, (q) => q(`select public.zone_livraison_enregistrer($1, $2)`, [org, JSON.stringify({ id, nom: 'Koumassi', frais: 2000, delai: '3 h' })]));
    expect((await pool.query(`select nom, frais, delai from zones_livraison where id = $1`, [id])).rows[0]).toMatchObject({ nom: 'Koumassi', frais: '2000', delai: '3 h' });
    await expect(enTantQue(pool, intrus, (q) => q(`select public.zone_livraison_supprimer($1, $2)`, [org, id]))).rejects.toThrow(/boutique.modifier/);
    await enTantQue(pool, alice, (q) => q(`select public.zone_livraison_supprimer($1, $2)`, [org, id]));
    expect((await pool.query(`select count(*)::int n from zones_livraison where id = $1`, [id])).rows[0].n).toBe(0);
    expect((await pool.query(`select count(*)::int n from journal_audit where action = 'boutique.zone_supprimee'`)).rows[0].n).toBe(1);
  });
});
