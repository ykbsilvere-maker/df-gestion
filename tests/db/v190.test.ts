import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 1.9 : demandes de création d'entreprise validées, refusées ou ajournées par l'administrateur général.
let pool: pg.Pool;
let admin: string;
let awa: string;
let kone: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const fiche = {
  nom_entreprise: 'Supérette Akwaba',
  activite: 'Alimentation générale',
  date_creation: '2021-03-15',
  rccm: 'CI-ABJ-2021-B-12345',
  ncc: '2103456A',
  regime_fiscal: 'micro',
  nom_gerant: 'Awa Koné',
  telephone: '07 07 07 07 07',
  ville: 'Abidjan',
  modules_desactives: ['comptabilite'],
  logo: 'data:image/png;base64,iVBORw0KGgo=',
};
interface Fiche { id: string; statut: string; motif: string | null; organisation_id: string | null; logo: string | null; a_logo: boolean }

beforeAll(async () => {
  pool = await preparerBase('v190');
  admin = await creerCompte(pool, 'admin@df.ci', 'Admin');
  awa = await creerCompte(pool, 'awa@akwaba.ci', '');
  kone = await creerCompte(pool, 'kone@x.ci', 'Koné');
  await enTantQue(pool, admin, (q) => q(`select public.devenir_admin_general()`));
});

afterAll(async () => {
  await pool?.end();
});

describe('Demande de création d’entreprise', () => {
  it('le demandeur envoie sa fiche et la retrouve en attente', async () => {
    await enTantQue(pool, awa, (q) => q(`select public.soumettre_demande($1::jsonb)`, [JSON.stringify(fiche)]));
    const d = (await enTantQue(pool, awa, (q) => un(q<{ r: Fiche }>(`select public.ma_demande() r`)))).r;
    expect(d.statut).toBe('en_attente');
    expect(d.logo).toMatch(/^data:image/);
  });
  it('sans téléphone, la demande est refusée par la base', async () => {
    await expect(
      enTantQue(pool, kone, (q) => q(`select public.soumettre_demande($1::jsonb)`, [JSON.stringify({ ...fiche, telephone: '12' })])),
    ).rejects.toThrow(/téléphone/);
  });
  it('seul l’administrateur général voit et traite les demandes', async () => {
    await expect(enTantQue(pool, kone, (q) => q(`select public.admin_demandes()`))).rejects.toThrow(/administrateur général/);
    const info = await enTantQue(pool, admin, (q) => un(q<{ r: { demandes_en_attente: number } }>(`select public.plateforme_info() r`)));
    expect(Number(info.r.demandes_en_attente)).toBe(1);
    const liste = (await enTantQue(pool, admin, (q) => un(q<{ r: (Fiche & { compte: string })[] }>(`select public.admin_demandes() r`)))).r;
    expect(liste).toHaveLength(1);
    expect(liste[0]!.compte).toBe('awa@akwaba.ci');
    expect(liste[0]!.logo).toBeNull(); // la liste ne transporte pas les logos
  });
  it('ajourner exige un motif, que le demandeur voit ; il corrige et renvoie', async () => {
    const id = (await enTantQue(pool, awa, (q) => un(q<{ r: Fiche }>(`select public.ma_demande() r`)))).r.id;
    await expect(enTantQue(pool, admin, (q) => q(`select public.admin_traiter_demande($1, 'ajourner', '')`, [id]))).rejects.toThrow(/raison/);
    await enTantQue(pool, admin, (q) => q(`select public.admin_traiter_demande($1, 'ajourner', 'Le RCCM ne correspond pas')`, [id]));
    let d = (await enTantQue(pool, awa, (q) => un(q<{ r: Fiche }>(`select public.ma_demande() r`)))).r;
    expect(d.statut).toBe('ajournee');
    expect(d.motif).toBe('Le RCCM ne correspond pas');
    const id2 = (await enTantQue(pool, awa, (q) => un(q<{ id: string }>(`select public.soumettre_demande($1::jsonb) id`, [JSON.stringify({ ...fiche, rccm: 'CI-ABJ-2021-B-54321' })])))).id;
    expect(id2).toBe(id); // même demande, renvoyée
    d = (await enTantQue(pool, awa, (q) => un(q<{ r: Fiche }>(`select public.ma_demande() r`)))).r;
    expect(d.statut).toBe('en_attente');
  });
  it('valider crée l’entreprise : le demandeur en est aussitôt gérant principal', async () => {
    const id = (await enTantQue(pool, awa, (q) => un(q<{ r: Fiche }>(`select public.ma_demande() r`)))).r.id;
    const r = (await enTantQue(pool, admin, (q) => un(q<{ r: { statut: string; organisation_id: string } }>(`select public.admin_traiter_demande($1, 'valider') r`, [id])))).r;
    expect(r.statut).toBe('validee');
    const orgs = (await enTantQue(pool, awa, (q) => q<{ nom: string; role_code: string }>(`select * from public.mes_organisations()`)));
    expect(orgs.map((o) => [o.nom, o.role_code])).toEqual([['Supérette Akwaba', 'proprietaire']]);
    const o = await enTantQue(pool, awa, (q) => un(q<{ rccm: string; activite: string; modules_desactives: string[] }>(
      `select rccm, activite, modules_desactives from public.organisations where id = $1`, [r.organisation_id])));
    expect(o.rccm).toBe('CI-ABJ-2021-B-54321');
    expect(o.activite).toBe('Alimentation générale');
    expect(o.modules_desactives).toContain('comptabilite');
    const nom = await enTantQue(pool, awa, (q) => un(q<{ nom_complet: string }>(`select nom_complet from public.profils where id = $1`, [awa])));
    expect(nom.nom_complet).toBe('Awa Koné');
    await expect(enTantQue(pool, admin, (q) => q(`select public.admin_traiter_demande($1, 'refuser', 'Trop tard')`, [id]))).rejects.toThrow(/déjà été traitée/);
  });
  it('après transfert du logo, la copie de la demande est effacée', async () => {
    const id = (await enTantQue(pool, awa, (q) => un(q<{ r: Fiche }>(`select public.ma_demande() r`)))).r.id;
    await enTantQue(pool, awa, (q) => q(`select public.demande_logo_transfere($1)`, [id]));
    const d = (await enTantQue(pool, awa, (q) => un(q<{ r: Fiche }>(`select public.ma_demande() r`)))).r;
    expect(d.a_logo).toBe(false);
  });
  it('refuser : le demandeur voit le motif', async () => {
    await enTantQue(pool, kone, (q) => q(`select public.soumettre_demande($1::jsonb)`, [JSON.stringify({ ...fiche, nom_entreprise: 'Koné Shop', logo: null })]));
    const id = (await enTantQue(pool, kone, (q) => un(q<{ r: Fiche }>(`select public.ma_demande() r`)))).r.id;
    await enTantQue(pool, admin, (q) => q(`select public.admin_traiter_demande($1, 'refuser', 'Activité non couverte')`, [id]));
    const d = (await enTantQue(pool, kone, (q) => un(q<{ r: Fiche }>(`select public.ma_demande() r`)))).r;
    expect([d.statut, d.motif]).toEqual(['refusee', 'Activité non couverte']);
  });
});
