import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { creerCompte, devenir, enTantQue, ouvrirPourCaissier, preparerBase } from './helpers';

// v1.1 : comptabilité SYSCOHADA générée depuis les opérations ; journal, balance, bilan, clôture, écritures manuelles, extourne.
let pool: pg.Pool;
let alice: string;
let carine: string;
let org: string;
const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
type Q = <T = Record<string, unknown>>(sql: string, p?: unknown[]) => Promise<T[]>;
const commeAlice = <R>(fn: (q: Q) => Promise<R>) => enTantQue(pool, alice, fn);
const moisPrecedent = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getFullYear(), d.getMonth() - 1, 15)).toISOString().slice(0, 10);
};

beforeAll(async () => {
  pool = await preparerBase('v110');
  alice = await creerCompte(pool, 'alice@x.ci', 'Alice');
  carine = await creerCompte(pool, 'carine@x.ci', 'Carine');
  org = (await commeAlice((q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique compta') id`)))).id;
  await commeAlice(async (q) => {
    const mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    const caisse = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    const especes = (await un(q<{ id: string }>(`select id from moyens_paiement where organisation_id = $1 and code = 'especes'`, [org]))).id;
    const cpt = (await un(q<{ id: string }>(`select id from comptes_tresorerie where organisation_id = $1 and type = 'caisse'`, [org]))).id;
    const banque = (await un(q<{ id: string }>(`select id from comptes_tresorerie where organisation_id = $1 and type = 'banque'`, [org]))).id;
    await q(`update comptes_tresorerie set solde_initial = 100000, date_ouverture = date_trunc('month', current_date)::date where id = $1`, [cpt]);
    const f = (await un(q<{ id: string }>(`insert into fournisseurs (organisation_id, nom) values ($1, 'Grossiste') returning id`, [org]))).id;
    const p = (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Pagne', 4500) returning id`, [org]))).id;
    const r = (await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id, fournisseur_id, reglement) values ($1, $2, $3, 'credit') returning id`, [org, mag, f]))).id;
    await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 100, 3000)`, [org, r, p]);
    await q(`select public.valider_reception($1)`, [r]);
    await q(`select public.payer_fournisseur($1, $2, $3, 100000, $4)`, [org, f, r, banque]);
    await q(`select public.inviter_membre($1, 'carine@x.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse]]);
    const session = await ouvrirPourCaissier(q, { org, caisse, gerant: alice, caissier: carine, email: 'carine@x.ci' });
    await q(`select public.enregistrer_vente($1::jsonb)`, [JSON.stringify({
      id: randomUUID(), organisation_id: org, caisse_id: caisse, session_id: session, date_vente: new Date().toISOString(),
      lignes: [{ produit_id: p, quantite: 10, prix_unitaire: 4500 }],
      reglements: [{ moyen_id: especes, montant: 45000, montant_recu: 45000 }],
    })]);
    await devenir(q, alice);
    const loyer = (await un(q<{ id: string }>(`select id from postes_budget where organisation_id = $1 and libelle = 'Loyer'`, [org]))).id;
    await q(`select public.enregistrer_depense($1, current_date, $2, $3, 30000)`, [org, loyer, cpt]);
    await q(`select public.saisir_virement($1, $2, $3, 20000, 500, current_date, 'V1')`, [org, cpt, banque]);
  });
  await enTantQue(pool, carine, (q) => q(`select public.accepter_invitations()`));
});

afterAll(async () => {
  await pool?.end();
});

const debut = `date_trunc('month', current_date)::date`;

describe('Écritures automatiques', () => {
  it('génère des écritures toutes équilibrées pour ventes, achats, règlements, dépenses et virements', async () => {
    const j = await commeAlice((q) => un(q<{ r: { journal: string; lignes: { compte: string; debit: number; credit: number }[] }[] }>(
      `select public.journal_comptable($1, ${debut}, current_date) r`, [org])));
    const journaux = new Set(j.r.map((e) => e.journal));
    for (const c of ['VT', 'AC', 'TR']) expect(journaux.has(c)).toBe(true);
    for (const e of j.r) {
      const d = e.lignes.reduce((s, l) => s + Number(l.debit), 0);
      const c = e.lignes.reduce((s, l) => s + Number(l.credit), 0);
      expect(d).toBe(c);
      expect(d).toBeGreaterThan(0);
    }
    const comptes = new Set(j.r.flatMap((e) => e.lignes.map((l) => l.compte)));
    for (const c of ['701', '601', '401', '5711', '5211', '622']) expect(comptes.has(c)).toBe(true);
  });

  it('balance équilibrée et bilan actif = passif', async () => {
    const b = await commeAlice((q) => un(q<{ r: { debit: number; credit: number; solde_final: number; compte: string }[] }>(
      `select public.balance_comptable($1, ${debut}, current_date) r`, [org])));
    const d = b.r.reduce((s, x) => s + Number(x.debit), 0);
    const c = b.r.reduce((s, x) => s + Number(x.credit), 0);
    expect(d).toBe(c);
    expect(b.r.reduce((s, x) => s + Number(x.solde_final), 0)).toBe(0);
    const bil = await commeAlice((q) => un(q<{ r: { actif: { total: number; stocks: number }; passif: { total: number; dettes_fournisseurs: number } } }>(
      `select public.bilan_simplifie($1) r`, [org])));
    expect(Number(bil.r.actif.total)).toBe(Number(bil.r.passif.total));
    expect(Number(bil.r.actif.stocks)).toBe(90 * 3000);
    expect(Number(bil.r.passif.dettes_fournisseurs)).toBe(300000 - 100000);
  });

  it('régénérer ne duplique pas les écritures automatiques', async () => {
    const n1 = await commeAlice((q) => un(q<{ n: number }>(`select jsonb_array_length(public.journal_comptable($1, ${debut}, current_date)) n`, [org])));
    const n2 = await commeAlice((q) => un(q<{ n: number }>(`select jsonb_array_length(public.journal_comptable($1, ${debut}, current_date)) n`, [org])));
    expect(n2.n).toBe(n1.n);
  });
});

describe('Écritures manuelles, clôture, extourne', () => {
  it('refuse une écriture déséquilibrée ou sans pièce', async () => {
    await expect(commeAlice((q) => q(`select public.ecriture_manuelle($1, current_date, 'OD', 'Déséquilibre', $2::jsonb, 'X')`,
      [org, JSON.stringify([{ compte: '5211', debit: 5 }, { compte: '101', credit: 4 }])]))).rejects.toThrow(/déséquilibrée/);
    await expect(commeAlice((q) => q(`select public.ecriture_manuelle($1, current_date, 'OD', 'Sans pièce', $2::jsonb, '')`,
      [org, JSON.stringify([{ compte: '5211', debit: 5 }, { compte: '101', credit: 5 }])]))).rejects.toThrow(/pièce/);
  });

  it('refuse de clôturer le mois en cours', async () => {
    await expect(commeAlice((q) => q(`select public.cloturer_mois_comptable($1, current_date)`, [org]))).rejects.toThrow(/mois terminé/);
  });

  it('clôture un mois passé, le fige, puis corrige par extourne', async () => {
    const id = (await commeAlice((q) => un(q<{ id: string }>(`select public.ecriture_manuelle($1, $2::date, 'OD', 'Apport en capital', $3::jsonb, 'PV-01') id`,
      [org, moisPrecedent(), JSON.stringify([{ compte: '5211', debit: 500000 }, { compte: '101', credit: 500000 }])])))).id;
    const c = await commeAlice((q) => un(q<{ r: { ecritures: number } }>(`select public.cloturer_mois_comptable($1, $2::date) r`, [org, moisPrecedent()])));
    expect(Number(c.r.ecritures)).toBeGreaterThanOrEqual(1);
    await expect(commeAlice((q) => q(`select public.ecriture_manuelle($1, $2::date, 'OD', 'Tardive', $3::jsonb, 'X')`,
      [org, moisPrecedent(), JSON.stringify([{ compte: '5211', debit: 1 }, { compte: '101', credit: 1 }])]))).rejects.toThrow(/clôturé/);
    await expect(commeAlice((q) => q(`delete from ecritures where id = $1`, [id]))).rejects.toThrow();
    const ext = (await commeAlice((q) => un(q<{ id: string }>(`select public.extourner_ecriture($1, 'Erreur de montant') id`, [id])))).id;
    const lignes = await commeAlice((q) => q<{ compte: string; debit: number; credit: number }>(
      `select compte, debit, credit from ecritures_lignes where ecriture_id = $1 order by compte`, [ext]));
    expect(lignes.map((l) => [l.compte, Number(l.debit), Number(l.credit)])).toEqual([['101', 500000, 0], ['5211', 0, 500000]]);
    await expect(commeAlice((q) => q(`select public.extourner_ecriture($1, 'Encore')`, [id]))).rejects.toThrow(/déjà extournée/);
    const etat = await commeAlice((q) => un(q<{ r: { mois: string; cloturee: boolean }[] }>(`select public.periodes_comptables_etat($1) r`, [org])));
    expect(etat.r.find((p) => p.mois === `${moisPrecedent().slice(0, 7)}-01`)?.cloturee).toBe(true);
  });
});

describe('Droits', () => {
  it('le caissier n’accède pas à la comptabilité', async () => {
    await expect(enTantQue(pool, carine, (q) => q(`select public.balance_comptable($1, current_date - 30, current_date)`, [org]))).rejects.toThrow(/comptabilite/);
  });
  it('le caissier ne lit pas les écritures', async () => {
    const r = await enTantQue(pool, carine, (q) => q(`select count(*)::int n from ecritures`));
    expect(r[0]!.n).toBe(0);
  });
});

describe('Budget prévu / réalisé', () => {
  it('suit la date prévue, le réalisé, les dépassements et les retards', async () => {
    const s = await commeAlice(async (q) => {
      const postes = await q<{ id: string; libelle: string }>(`select id, libelle from postes_budget where organisation_id = $1`, [org]);
      const id = (l: string) => postes.find((p) => p.libelle === l)!.id;
      const debutMois = (await un(q<{ d: string }>(`select to_char(date_trunc('month', current_date), 'YYYY-MM-DD') d`))).d;
      const finMois = (await un(q<{ d: string }>(`select to_char(date_trunc('month', current_date) + interval '1 month' - interval '1 day', 'YYYY-MM-DD') d`))).d;
      await q(`select public.enregistrer_budget($1, current_date, $2::jsonb)`, [org, JSON.stringify([
        { poste_id: id('Loyer'), montant: 25000, date_prevue: debutMois },
        { poste_id: id('Salaires'), montant: 50000, date_prevue: finMois },
      ])]);
      return un(q<{ r: { lignes: { libelle: string; statut: string; depassement: number; date_prevue: string; nb_depenses: number }[]; totaux: { depassement: number; depasses: number } } }>(
        `select public.suivi_budget($1, current_date) r`, [org]));
    });
    const loyer = s.r.lignes.find((l) => l.libelle === 'Loyer')!;
    expect(loyer.statut).toBe('depasse');
    expect(Number(loyer.depassement)).toBe(5000);
    expect(loyer.nb_depenses).toBe(1);
    const salaires = s.r.lignes.find((l) => l.libelle === 'Salaires')!;
    expect(['a_venir', 'non_realise']).toContain(salaires.statut);
    expect(Number(s.r.totaux.depassement)).toBe(5000);
    const b = await commeAlice((q) => un(q<{ r: { mois: unknown[]; postes: { libelle: string; mois_depasses: number }[] } }>(
      `select public.bilan_budget($1, extract(year from current_date)::int) r`, [org])));
    expect(b.r.mois).toHaveLength(12);
    expect(b.r.postes.find((p) => p.libelle === 'Loyer')?.mois_depasses).toBe(1);
  });

  it('refuse une date prévue hors du mois', async () => {
    await expect(commeAlice(async (q) => {
      const p = (await un(q<{ id: string }>(`select id from postes_budget where organisation_id = $1 and libelle = 'Loyer'`, [org]))).id;
      await q(`select public.enregistrer_budget($1, current_date, $2::jsonb)`, [org, JSON.stringify([{ poste_id: p, montant: 1, date_prevue: '2000-01-01' }])]);
    })).rejects.toThrow(/mois du budget/);
  });
});

describe('Modules choisis', () => {
  it('un module retiré disparaît des droits, puis revient', async () => {
    await commeAlice((q) => q(`select public.definir_modules($1, array['comptabilite'])`, [org]));
    await expect(commeAlice((q) => q(`select public.balance_comptable($1, current_date - 30, current_date)`, [org]))).rejects.toThrow(/comptabilite/);
    const p = await commeAlice((q) => un(q<{ permissions: string[] }>(`select permissions from public.mes_organisations() where organisation_id = $1`, [org])));
    expect(p.permissions.some((c) => c.startsWith('comptabilite.'))).toBe(false);
    expect(p.permissions).toContain('budget.consulter');
    await commeAlice((q) => q(`select public.definir_modules($1, '{}')`, [org]));
    await commeAlice((q) => q(`select public.balance_comptable($1, current_date - 30, current_date)`, [org]));
  });

  it('retirer le stock retire les arrivages ; les modules obligatoires restent', async () => {
    const r = await commeAlice((q) => un(q<{ r: { desactives: string[] } }>(`select public.definir_modules($1, array['stock']) r`, [org])));
    expect(r.r.desactives).toEqual(['achats', 'stock']);
    await expect(commeAlice((q) => q(`select public.definir_modules($1, array['caisse'])`, [org]))).rejects.toThrow(/obligatoire/);
    await commeAlice((q) => q(`select public.definir_modules($1, '{}')`, [org]));
  });

  it('l’administrateur général fixe les modules souscrits ; le propriétaire ne peut pas les rouvrir', async () => {
    const admin = await creerCompte(pool, 'admin@x.ci', 'Admin');
    await enTantQue(pool, admin, (q) => q(`select public.devenir_admin_general()`));
    await enTantQue(pool, admin, (q) => q(`select public.definir_modules($1, null, array['rentabilite'])`, [org]));
    await expect(commeAlice((q) => q(`select public.compte_exploitation($1)`, [org]))).rejects.toThrow(/rentabilite/);
    await expect(commeAlice((q) => q(`select public.definir_modules($1, '{}')`, [org]))).rejects.toThrow(/souscrit/);
    await expect(commeAlice((q) => q(`select public.definir_modules($1, '{}', '{}')`, [org]))).rejects.toThrow(/administrateur général/);
    await expect(enTantQue(pool, carine, (q) => q(`select public.definir_modules($1, '{}')`, [org]))).rejects.toThrow(/propriétaire/);
    const r = await enTantQue(pool, admin, (q) => un(q<{ r: { desactives: string[]; bloques: string[] } }>(`select public.definir_modules($1, null, '{}') r`, [org])));
    expect(r.r.bloques).toEqual([]);
    expect(r.r.desactives).toEqual([]);
  });
});
