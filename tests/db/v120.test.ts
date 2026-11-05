import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 1.2 : connexion des employés par code entreprise + matricule.
let pool: pg.Pool;
let alice: string;
let org: string;
let code: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;

beforeAll(async () => {
  pool = await preparerBase('v120');
  alice = await creerCompte(pool, 'alice@m.ci', 'Alice');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique Awa') id`)))).id;
});

afterAll(async () => {
  await pool?.end();
});

describe('Code entreprise', () => {
  it('est créé à la création de l’entreprise, à partir du nom', async () => {
    const a = await enTantQue(pool, alice, (q) => un(q<{ r: { code_acces: string; matricule_suivant: string } }>(`select public.acces_employes($1) r`, [org])));
    code = a.r.code_acces;
    expect(code).toMatch(/^BOUT\d{2}$/);
    expect(a.r.matricule_suivant).toBe('0001');
  });

  it('ne peut pas être modifié', async () => {
    await expect(pool.query(`update public.organisations set code_acces = 'AUTRE01' where id = $1`, [org])).rejects.toThrow(/ne peut pas être modifié/);
  });
});

describe('Employé par matricule', () => {
  it('invite un employé, qui rejoint l’entreprise à sa première connexion', async () => {
    const email = (await enTantQue(pool, alice, (q) => un(q<{ e: string }>(`select public.inviter_employe($1, '0001', 'caissier', true, '{}', '{}') e`, [org])))).e;
    expect(email).toBe(`0001.${code.toLowerCase()}@acces.dfgestion.app`);
    const ctrl = await enTantQue(pool, alice, (q) => un(q<{ r: { statut: string } }>(`select public.controle_creation_compte($1) r`, [email])));
    expect(ctrl.r.statut).toBe('ok');
    const bintou = await creerCompte(pool, email, 'Bintou');
    await enTantQue(pool, bintou, (q) => q(`select public.accepter_invitations()`));
    const orgs = await enTantQue(pool, bintou, (q) => q<{ organisation_id: string; role_code: string }>(`select organisation_id, role_code from public.mes_organisations()`));
    expect(orgs).toEqual([{ organisation_id: org, role_code: 'caissier' }]);
    const suivant = await enTantQue(pool, alice, (q) => un(q<{ m: string }>(`select public.acces_employes($1) ->> 'matricule_suivant' m`, [org])));
    expect(suivant.m).toBe('0002');
  });

  it('refuse un matricule déjà pris, invalide, ou un propriétaire par matricule', async () => {
    await expect(enTantQue(pool, alice, (q) => q(`select public.inviter_employe($1, '0001', 'vendeur', true, '{}', '{}')`, [org]))).rejects.toThrow(/déjà utilisé/);
    await expect(enTantQue(pool, alice, (q) => q(`select public.inviter_employe($1, 'A B', 'vendeur', true, '{}', '{}')`, [org]))).rejects.toThrow(/Matricule/);
    await expect(enTantQue(pool, alice, (q) => q(`select public.inviter_employe($1, '0009', 'proprietaire', true, '{}', '{}')`, [org]))).rejects.toThrow(/e-mail/);
  });

  it('refuse à qui n’a pas le droit de créer des utilisateurs', async () => {
    const intrus = await creerCompte(pool, 'intrus@m.ci');
    await expect(enTantQue(pool, intrus, (q) => q(`select public.inviter_employe($1, '0010', 'vendeur', true, '{}', '{}')`, [org]))).rejects.toThrow();
  });
});
