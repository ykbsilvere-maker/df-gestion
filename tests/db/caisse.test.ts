import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

let pool: pg.Pool;
let alice: string; // propriétaire
let carine: string; // caissière, caisse 1 seulement
let robert: string; // responsable de caisse
let bruno: string; // autre entreprise
let org: string;
let orgB: string;
let mag: string;
let caisse1: string;
let caisse2: string;
let session: string;
let riz: string;
let lait: string;
let yaourt: string;
const moyens: Record<string, string> = {};

const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const n = (v: unknown) => Number(v);

async function stockDe(produit: string) {
  const { rows } = await pool.query(`select quantite from stocks where magasin_id = $1 and produit_id = $2`, [mag, produit]);
  return n(rows[0]?.quantite ?? 0);
}

function vente(lignes: { produit_id: string; quantite: number; prix_unitaire?: number; remise?: number }[],
               reglements: { moyen: string; montant: number; montant_recu?: number; reference?: string }[],
               extra: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    organisation_id: org,
    caisse_id: caisse1,
    session_id: session,
    date_vente: new Date().toISOString(),
    lignes,
    reglements: reglements.map((r) => ({ moyen_id: moyens[r.moyen], montant: r.montant, montant_recu: r.montant_recu, reference: r.reference })),
    ...extra,
  };
}

const enregistrer = (uid: string, v: object) =>
  enTantQue(pool, uid, (q) => un(q<{ r: { numero: string; deja_enregistree: boolean; total: number } }>(`select public.enregistrer_vente($1::jsonb) r`, [JSON.stringify(v)]))).then((x) => x.r);

beforeAll(async () => {
  pool = await preparerBase('caisse');
  alice = await creerCompte(pool, 'alice@c.ci');
  carine = await creerCompte(pool, 'carine@c.ci');
  robert = await creerCompte(pool, 'robert@c.ci');
  bruno = await creerCompte(pool, 'bruno@c.ci');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Supérette Caisse') id`)))).id;
  orgB = (await enTantQue(pool, bruno, (q) => un(q<{ id: string }>(`select public.creer_organisation('Autre') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    caisse1 = (await un(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [mag]))).id;
    caisse2 = (await un(q<{ id: string }>(`insert into caisses (organisation_id, magasin_id, code, nom) values ($1, $2, 'CAISSE02', 'Caisse 2') returning id`, [org, mag]))).id;
    for (const m of await q<{ code: string; id: string }>(`select code, id from moyens_paiement where organisation_id = $1`, [org])) moyens[m.code] = m.id;
    await q(`update moyens_paiement set reference_obligatoire = true where id = $1`, [moyens.wave]);
    const p = async (d: string, prix: number, perissable = false) =>
      (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente, gere_peremption) values ($1, $2, $3, $4) returning id`, [org, d, prix, perissable]))).id;
    riz = await p('Riz 5 kg', 4500);
    lait = await p('Lait concentré', 650);
    yaourt = await p('Yaourt', 300, true);
    // Stock de départ : riz 10 à 3 900, lait 24 à 500, yaourt 2 lots
    const r = await un(q<{ id: string }>(`insert into receptions (organisation_id, magasin_id) values ($1, $2) returning id`, [org, mag]));
    await q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire, date_peremption) values
      ($1, $2, $3, 10, 3900, null), ($1, $2, $4, 24, 500, null), ($1, $2, $5, 5, 200, '2026-12-31'), ($1, $2, $5, 5, 200, '2026-11-15')`,
      [org, r.id, riz, lait, yaourt]);
    await q(`select public.valider_reception($1)`, [r.id]);
    await q(`select public.inviter_membre($1, 'carine@c.ci', 'caissier', false, $2, $3)`, [org, [mag], [caisse1]]);
    await q(`select public.inviter_membre($1, 'robert@c.ci', 'responsable_caisse', false, $2)`, [org, [mag]]);
  });
});

afterAll(async () => {
  await pool?.end();
});

describe('Ouverture de caisse', () => {
  it('la caissière ne peut pas ouvrir sa caisse seule', async () => {
    await expect(enTantQue(pool, carine, (q) => q(`select public.ouvrir_session($1, $2, 20000)`, [org, caisse1]))).rejects.toThrow(/responsable/);
  });

  it('le responsable ouvre la caisse attribuée à la caissière et refuse une seconde ouverture', async () => {
    session = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 20000, $3) id`, [org, caisse1, carine])))).id;
    await expect(enTantQue(pool, alice, (q) => q(`select public.ouvrir_session($1, $2, 0, $3)`, [org, caisse1, carine]))).rejects.toThrow(/déjà ouverte/);
  });

  it('refuse une caisse non attribuée à la caissière', async () => {
    await expect(enTantQue(pool, alice, (q) => q(`select public.ouvrir_session($1, $2, 0, $3)`, [org, caisse2, carine]))).rejects.toThrow(/pas attribuée à cette personne/);
  });
});

describe('Ventes', () => {
  let premiere: ReturnType<typeof vente>;

  it('enregistre une vente avec paiement mixte, rendu de monnaie et sortie de stock', async () => {
    // 1 riz (4 500) + 3 laits (1 950) = 6 450 : Wave 2 000 + espèces 4 450 (client donne 5 000)
    premiere = vente(
      [
        { produit_id: riz, quantite: 1, prix_unitaire: 4500 },
        { produit_id: lait, quantite: 3, prix_unitaire: 650 },
      ],
      [
        { moyen: 'wave', montant: 2000, reference: 'TX-81A' },
        { moyen: 'especes', montant: 4450, montant_recu: 5000 },
      ],
    );
    const r = await enregistrer(carine, premiere);
    expect(r).toMatchObject({ numero: 'T-000001', total: 6450, deja_enregistree: false });
    expect(await stockDe(riz)).toBe(9);
    expect(await stockDe(lait)).toBe(21);
    const regl = await pool.query(`select libelle, montant, montant_recu, rendu from reglements where vente_id = $1 order by montant`, [premiere.id]);
    expect(regl.rows.map((x) => [x.libelle, n(x.montant), x.montant_recu === null ? null : n(x.montant_recu), n(x.rendu)])).toEqual([
      ['Wave', 2000, null, 0],
      ['Espèces', 4450, 5000, 550],
    ]);
    const cout = await pool.query(`select cout_unitaire from ventes_lignes where vente_id = $1 and produit_id = $2`, [premiere.id, riz]);
    expect(n(cout.rows[0].cout_unitaire)).toBe(3900);
  });

  it('une vente renvoyée (double clic, resynchronisation) n’est enregistrée qu’une fois', async () => {
    const r = await enregistrer(carine, premiere);
    expect(r).toMatchObject({ numero: 'T-000001', deja_enregistree: true });
    expect(await stockDe(riz)).toBe(9);
    const c = await pool.query(`select count(*)::int c from reglements where vente_id = $1`, [premiere.id]);
    expect(c.rows[0].c).toBe(2);
  });

  it('refuse des règlements qui ne couvrent pas exactement le total', async () => {
    await expect(enregistrer(carine, vente([{ produit_id: lait, quantite: 1, prix_unitaire: 650 }], [{ moyen: 'especes', montant: 600 }]))).rejects.toThrow(
      /ne correspondent pas au total/,
    );
    expect(await stockDe(lait)).toBe(21); // rien n'a bougé
  });

  it('exige la référence de transaction quand le moyen l’impose', async () => {
    await expect(enregistrer(carine, vente([{ produit_id: lait, quantite: 1, prix_unitaire: 650 }], [{ moyen: 'wave', montant: 650 }]))).rejects.toThrow(
      /Référence de transaction obligatoire pour Wave/,
    );
  });

  it('réserve les remises au droit « ventes.valider »', async () => {
    const v = () => vente([{ produit_id: riz, quantite: 1, prix_unitaire: 4500, remise: 500 }], [{ moyen: 'especes', montant: 4000 }]);
    await expect(enregistrer(carine, v())).rejects.toThrow(/ventes.valider/);
    // Le responsable de caisse ne vend pas dans la caisse de Carine…
    await expect(enregistrer(robert, v())).rejects.toThrow(/autre personne/);
    // …mais dans la sienne, ouverte pour lui, il peut accorder la remise.
    const sR = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0, $3) id`, [org, caisse2, robert])))).id;
    const r = await enregistrer(robert, { ...v(), session_id: sR, caisse_id: caisse2 });
    expect(r.total).toBe(4000);
  });

  it('refuse un prix modifié en ligne, l’accepte pour une vente faite hors connexion', async () => {
    await expect(enregistrer(carine, vente([{ produit_id: lait, quantite: 1, prix_unitaire: 600 }], [{ moyen: 'especes', montant: 600 }]))).rejects.toThrow(
      /rechargez le catalogue/,
    );
    const r = await enregistrer(carine, vente([{ produit_id: lait, quantite: 1, prix_unitaire: 600 }], [{ moyen: 'especes', montant: 600 }], { origine: 'hors_ligne', numero_local: 'C1-0001' }));
    expect(r.total).toBe(600);
  });

  it('consomme les lots à la péremption la plus proche d’abord (FEFO)', async () => {
    const v = vente([{ produit_id: yaourt, quantite: 7, prix_unitaire: 300 }], [{ moyen: 'especes', montant: 2100 }]);
    await enregistrer(carine, v);
    const { rows } = await pool.query(`
      select l.date_peremption::text d, sl.quantite from stocks_lots sl join lots l on l.id = sl.lot_id
      where sl.produit_id = $1 order by l.date_peremption`, [yaourt]);
    expect(rows.map((r) => [r.d, n(r.quantite)])).toEqual([
      ['2026-11-15', 0],
      ['2026-12-31', 3],
    ]);
  });

  it('autorise la vente au-delà du stock (fait accompli au comptoir) et le signale', async () => {
    await enregistrer(carine, vente([{ produit_id: riz, quantite: 20, prix_unitaire: 4500 }], [{ moyen: 'carte', montant: 90000 }]));
    expect(await stockDe(riz)).toBeLessThan(0);
    const alertes = await enTantQue(pool, alice, (q) => q<{ type: string }>(`select type from public.alertes_stock($1) where produit_id = $2`, [org, riz]));
    expect(alertes.map((a) => a.type)).toContain('negatif');
  });

  it('isole les ventes : une autre entreprise ne les voit pas et ne peut pas en rejouer une', async () => {
    const vues = await enTantQue(pool, bruno, (q) => q(`select id from ventes`));
    expect(vues).toHaveLength(0);
    await expect(enregistrer(bruno, { ...premiere, organisation_id: orgB })).rejects.toThrow(/introuvable/);
  });
});

describe('Annulation', () => {
  it('la caissière ne peut pas annuler ; le responsable annule avec motif et le stock revient', async () => {
    const v = vente([{ produit_id: lait, quantite: 2, prix_unitaire: 650 }], [{ moyen: 'especes', montant: 1300 }]);
    await enregistrer(carine, v);
    const avant = await stockDe(lait);
    await expect(enTantQue(pool, carine, (q) => q(`select public.annuler_vente($1, 'Erreur')`, [v.id]))).rejects.toThrow(/ventes.annuler/);
    await expect(enTantQue(pool, robert, (q) => q(`select public.annuler_vente($1, '')`, [v.id]))).rejects.toThrow(/motif/);
    await enTantQue(pool, robert, (q) => q(`select public.annuler_vente($1, 'Client a changé d’avis')`, [v.id]));
    expect(await stockDe(lait)).toBe(avant + 2);
    const s = await pool.query(`select statut from reglements where vente_id = $1`, [v.id]);
    expect(s.rows[0].statut).toBe('annule');
    const a = await pool.query(`select contexte->>'motif' m from journal_audit where action = 'ventes.annulation'`);
    expect(a.rows[0].m).toBe('Client a changé d’avis');
  });
});

describe('Rapports et clôture', () => {
  it('le rapport X totalise par moyen et calcule les espèces attendues', async () => {
    const r = await enTantQue(pool, carine, (q) => un(q<{ r: Record<string, unknown> }>(`select public.rapport_session($1) r`, [session]))).then((x) => x.r);
    // Espèces nettes : 4 450 + 600 + 2 100 = 7 150 (la vente annulée est exclue ; la remise de Robert est dans sa caisse)
    expect(r.especes_encaissees).toBe(7150);
    expect(r.especes_attendues).toBe(20000 + 7150);
    expect(r.nombre_annulations).toBe(1);
    const parMoyen = Object.fromEntries((r.par_moyen as { libelle: string; montant: number }[]).map((m) => [m.libelle, m.montant]));
    expect(parMoyen).toEqual({ 'Carte bancaire': 90000, Espèces: 7150, Wave: 2000 });
  });

  it('exige un motif en cas d’écart, puis clôture avec un numéro Z', async () => {
    await expect(enTantQue(pool, carine, (q) => q(`select public.cloturer_session($1, 27000)`, [session]))).rejects.toThrow(/justifié/);
    const z = await enTantQue(pool, carine, (q) =>
      un(q<{ r: Record<string, unknown> }>(`select public.cloturer_session($1, 27000, '{"10000": 2, "1000": 7}'::jsonb, 'Pièces manquantes') r`, [session])),
    ).then((x) => x.r);
    expect(z).toMatchObject({ numero_z: 1, ecart: -150, motif_ecart: 'Pièces manquantes' });
    await expect(enTantQue(pool, carine, (q) => q(`select public.cloturer_session($1, 27150)`, [session]))).rejects.toThrow(/déjà clôturée/);
  });

  it('après clôture : vente en ligne refusée, vente faite hors connexion acceptée et signalée', async () => {
    await expect(enregistrer(carine, vente([{ produit_id: lait, quantite: 1, prix_unitaire: 650 }], [{ moyen: 'especes', montant: 650 }]))).rejects.toThrow(
      /clôturée/,
    );
    await enregistrer(carine, vente([{ produit_id: lait, quantite: 1, prix_unitaire: 650 }], [{ moyen: 'especes', montant: 650 }], { origine: 'hors_ligne' }));
    const r = await enTantQue(pool, carine, (q) => un(q<{ r: Record<string, unknown> }>(`select public.rapport_session($1) r`, [session]))).then((x) => x.r);
    expect(r.ventes_apres_cloture).toBe(1);
  });

  it('le numéro Z suit la caisse : la session suivante porte le Z 2', async () => {
    const s2 = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 0, $3) id`, [org, caisse1, carine])))).id;
    const z = await enTantQue(pool, alice, (q) => un(q<{ r: { numero_z: number } }>(`select public.cloturer_session($1, 0) r`, [s2]))).then((x) => x.r);
    expect(z.numero_z).toBe(2);
  });

  it('la caissière ne clôture pas la session ouverte par une autre personne', async () => {
    // La caisse 2 est tenue par Robert (ouverte pour lui par Alice) : Carine ne peut pas la clôturer.
    const s3 = (await pool.query(`select id from sessions_caisse where caissier_id = $1 and statut = 'ouverte'`, [robert])).rows[0].id as string;
    await expect(enTantQue(pool, carine, (q) => q(`select public.cloturer_session($1, 0)`, [s3]))).rejects.toThrow(/Seule la personne/);
  });
});

describe('Garanties', () => {
  it('le stock reste égal à la somme des mouvements après ventes et annulations', async () => {
    const { rows } = await pool.query(`
      select s.quantite, coalesce(sum(m.quantite), 0) somme from stocks s
      left join mouvements_stock m on m.magasin_id = s.magasin_id and m.produit_id = s.produit_id
      group by s.magasin_id, s.produit_id, s.quantite`);
    for (const r of rows) expect(n(r.quantite)).toBe(n(r.somme));
  });

  it('le total de chaque vente est égal à la somme de ses lignes et de ses règlements', async () => {
    const { rows } = await pool.query(`
      select v.total,
             (select sum(montant) from ventes_lignes l where l.vente_id = v.id) lignes,
             (select sum(montant) from reglements r where r.vente_id = v.id) regl
      from ventes v`);
    for (const r of rows) {
      expect(n(r.total)).toBe(n(r.lignes));
      expect(n(r.total)).toBe(n(r.regl));
    }
  });

  it('aucune écriture directe dans les ventes', async () => {
    await expect(
      enTantQue(pool, alice, (q) => q(`update ventes set total = 1`)),
    ).rejects.toThrow(/permission denied/);
  });
});
