import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 1.3 : code d'entrée de 4 chiffres (connexion des employés et déverrouillage).
let pool: pg.Pool;
let alice: string;
let bintou: string;
let org: string;
let code: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;

async function commeService<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role service_role');
    const r = await c.query(sql, params);
    await c.query('commit');
    return r.rows as T[];
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
const connexion = async (pin: string) =>
  (await commeService<{ r: { ok: boolean; motif?: string; provisoire?: boolean; email?: string; essais_restants?: number } }>(
    `select public.connexion_pin($1, '0001', $2) r`, [code, pin]))[0]!.r;

beforeAll(async () => {
  pool = await preparerBase('v130');
  alice = await creerCompte(pool, 'alice@p.ci', 'Alice');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique Pin') id`)))).id;
  code = (await enTantQue(pool, alice, (q) => un(q<{ c: string }>(`select public.acces_employes($1) ->> 'code_acces' c`, [org])))).c;
  const email = (await enTantQue(pool, alice, (q) => un(q<{ e: string }>(`select public.inviter_employe($1, '0001', 'caissier', true, '{}', '{}') e`, [org])))).e;
  bintou = await creerCompte(pool, email, 'Bintou');
});

afterAll(async () => {
  await pool?.end();
});

describe('Code provisoire donné par le gérant', () => {
  it('refuse un code trop simple', async () => {
    for (const pin of ['1111', '1234', '4321', '12345', 'abcd'])
      await expect(enTantQue(pool, alice, (q) => q(`select public.definir_pin_employe($1, '0001', $2)`, [org, pin]))).rejects.toThrow(/4 chiffres/);
  });
  it('enregistre un code valide', async () => {
    await enTantQue(pool, alice, (q) => q(`select public.definir_pin_employe($1, '0001', '2580')`, [org]));
  });
  it('refuse un intrus', async () => {
    const intrus = await creerCompte(pool, 'intrus@p.ci');
    await expect(enTantQue(pool, intrus, (q) => q(`select public.definir_pin_employe($1, '0001', '9182')`, [org]))).rejects.toThrow();
  });
});

describe('Connexion par code (fonction serveur)', () => {
  it('n’est pas appelable par l’application elle-même', async () => {
    await expect(enTantQue(pool, null, (q) => q(`select public.connexion_pin($1, '0001', '2580')`, [code]))).rejects.toThrow(/permission/);
    await expect(enTantQue(pool, alice, (q) => q(`select public.connexion_pin($1, '0001', '2580')`, [code]))).rejects.toThrow(/permission/);
  });
  it('refuse un mauvais code, accepte le bon (provisoire)', async () => {
    const faux = await connexion('0000');
    expect(faux.ok).toBe(false);
    expect(faux.essais_restants).toBe(4);
    const bon = await connexion('2580');
    expect(bon.ok).toBe(true);
    expect(bon.provisoire).toBe(true);
    expect(bon.email).toBe(`0001.${code.toLowerCase()}@acces.dfgestion.app`);
  });
  it('bloque après 5 erreurs, même avec le bon code', async () => {
    for (let i = 0; i < 5; i++) await connexion('0000');
    const r = await connexion('2580');
    expect(r.ok).toBe(false);
    expect(r.motif).toBe('attente');
  });
  it('le gérant débloque en redonnant un code', async () => {
    await enTantQue(pool, alice, (q) => q(`select public.definir_pin_employe($1, '0001', '3691')`, [org]));
    expect((await connexion('3691')).ok).toBe(true);
  });
});

describe('Code choisi par l’employé', () => {
  it('remplace le provisoire, puis sert au déverrouillage', async () => {
    await enTantQue(pool, bintou, (q) => q(`select public.changer_mon_pin('7391')`));
    const etat = await enTantQue(pool, bintou, (q) => un(q<{ r: { defini: boolean; provisoire: boolean } }>(`select public.mon_pin() r`)));
    expect(etat.r).toEqual({ defini: true, provisoire: false });
    await expect(enTantQue(pool, bintou, (q) => q(`select public.changer_mon_pin('8402')`))).rejects.toThrow(/Ancien code/);
    const v = await enTantQue(pool, bintou, (q) => un(q<{ r: { ok: boolean } }>(`select public.verifier_mon_pin('7391') r`)));
    expect(v.r.ok).toBe(true);
    expect((await connexion('7391')).provisoire).toBe(false);
  });
  it('un employé désactivé ne peut plus entrer', async () => {
    await enTantQue(pool, bintou, (q) => q(`select public.accepter_invitations()`));
    const m = await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select id from membres where user_id = $1`, [bintou])));
    await enTantQue(pool, alice, (q) => q(`select public.desactiver_membre($1, 'Départ de l''entreprise')`, [m.id]));
    const r = await connexion('7391');
    expect(r.ok).toBe(false);
  });
});
