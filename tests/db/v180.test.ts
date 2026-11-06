import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 1.8 : le gérant principal se connecte par code établissement + matricule 0000 + son code d'entrée.
let pool: pg.Pool;
let alice: string;
let org: string;
let code: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const connexion = async (matricule: string, pin: string) => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role service_role');
    const r = (await c.query<{ r: { ok: boolean; email?: string; motif?: string; message?: string } }>(
      `select public.connexion_pin($1, $2, $3) r`, [code, matricule, pin])).rows[0]!.r;
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
};

beforeAll(async () => {
  pool = await preparerBase('v180');
  alice = await creerCompte(pool, 'alice@g.ci', 'Alice');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique G') id`)))).id;
  code = (await enTantQue(pool, alice, (q) => un(q<{ c: string }>(`select public.acces_employes($1) ->> 'code_acces' c`, [org])))).c;
});

afterAll(async () => {
  await pool?.end();
});

describe('Matricule 0000 du gérant principal', () => {
  it('sans code créé : message qui explique quoi faire', async () => {
    const r = await connexion('0000', '2580');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Mon compte/);
  });
  it('avec son code : connexion sur son propre compte', async () => {
    await enTantQue(pool, alice, (q) => q(`select public.changer_mon_pin('2580')`));
    const r = await connexion('0000', '2580');
    expect(r.ok).toBe(true);
    expect(r.email).toBe('alice@g.ci');
    expect((await connexion('0000', '1397')).ok).toBe(false);
  });
  it('0000 ne peut pas être donné à un employé', async () => {
    await expect(
      enTantQue(pool, alice, (q) => q(`select public.inviter_employe($1, '0000', 'caissier', true, '{}', '{}')`, [org])),
    ).rejects.toThrow(/réservé au gérant principal/);
  });
});
