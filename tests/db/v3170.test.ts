import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 3.17 : l'administrateur général redonne un code d'entrée provisoire (matricule 0000) au gérant principal.
let pool: pg.Pool;
let admin: string;
let alice: string;
let intrus: string;
let org: string;

beforeAll(async () => {
  pool = await preparerBase('v3170');
  admin = await creerCompte(pool, 'admin@v317.ci', 'Bérenger');
  alice = await creerCompte(pool, 'alice@v317.ci', 'Alice');
  intrus = await creerCompte(pool, 'intrus@v317.ci', 'Intrus');
  org = (await enTantQue(pool, alice, (q) => q<{ id: string }>(`select public.creer_organisation('Chez Alice') id`)))[0]!.id;
  await enTantQue(pool, admin, (q) => q(`select public.devenir_admin_general()`));
});
afterAll(async () => {
  await pool?.end();
});

describe('Code d’entrée du gérant principal par l’administrateur', () => {
  it('seul l’administrateur général le redonne ; le code est provisoire et journalisé', async () => {
    await expect(enTantQue(pool, intrus, (q) => q(`select public.admin_definir_pin_gerant($1, 'alice@v317.ci', '2580')`, [org]))).rejects.toThrow(/administrateur général/);
    await expect(enTantQue(pool, admin, (q) => q(`select public.admin_definir_pin_gerant($1, 'intrus@v317.ci', '2580')`, [org]))).rejects.toThrow(/gérant principal/);
    await expect(enTantQue(pool, admin, (q) => q(`select public.admin_definir_pin_gerant($1, 'alice@v317.ci', '1234')`, [org]))).rejects.toThrow(/4 chiffres/);
    const r = (await enTantQue(pool, admin, (q) => q<{ r: { code_acces: string; matricule: string } }>(`select public.admin_definir_pin_gerant($1, 'Alice@v317.ci', '2580') r`, [org])))[0]!.r;
    expect(r.matricule).toBe('0000');
    const code = (await pool.query(`select code_acces from organisations where id = $1`, [org])).rows[0].code_acces;
    expect(r.code_acces).toBe(code);
    const c = await pool.query(`select public.connexion_pin($1, '0000', '2580') r`, [code]);
    expect(c.rows[0].r).toMatchObject({ ok: true, provisoire: true });
    const j = await pool.query(`select count(*)::int n from journal_audit where action = 'admin.code_entree_gerant' and organisation_id = $1`, [org]);
    expect(j.rows[0].n).toBe(1);
  });
});
