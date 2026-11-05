import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

let pool: pg.Pool;
let alice: string; // propriétaire
let gilles: string; // gestionnaire de stock, magasin 1 seulement
let carine: string; // caissière, magasin 1 seulement
let org: string;
let mag1: string;
let mag2: string;
let riz: string;
let huile: string;
let yaourt: string; // périssable
let sucre: string; // jamais compté à l'inventaire

const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const n = (v: unknown) => Number(v);

async function stock(magasin: string, produit: string) {
  const { rows } = await pool.query(`select quantite, cout_moyen from stocks where magasin_id = $1 and produit_id = $2`, [
    magasin,
    produit,
  ]);
  return rows[0] ? { q: n(rows[0].quantite), cmp: n(rows[0].cout_moyen) } : { q: 0, cmp: 0 };
}

async function reception(uid: string, magasin: string, frais: number, lignes: [string, number, number, string?][]) {
  return enTantQue(pool, uid, async (q) => {
    const r = await un(
      q<{ id: string; numero: string }>(
        `insert into receptions (organisation_id, magasin_id, frais_approche) values ($1, $2, $3) returning id, numero`,
        [org, magasin, frais],
      ),
    );
    for (const [produit, quantite, prix, peremption] of lignes) {
      await q(
        `insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire, date_peremption)
         values ($1, $2, $3, $4, $5, $6)`,
        [org, r.id, produit, quantite, prix, peremption ?? null],
      );
    }
    return r;
  });
}

beforeAll(async () => {
  pool = await preparerBase('stock');
  alice = await creerCompte(pool, 'alice@s.ci');
  gilles = await creerCompte(pool, 'gilles@s.ci');
  carine = await creerCompte(pool, 'carine@s.ci');
  org = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Supérette Stock') id`)))).id;
  await enTantQue(pool, alice, async (q) => {
    mag1 = (await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]))).id;
    mag2 = (await un(q<{ id: string }>(`insert into magasins (organisation_id, code, nom) values ($1, 'MAG02', 'Dépôt') returning id`, [org]))).id;
    const p = async (d: string, extra = '') =>
      (await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente${extra ? ', ' + extra.split('=')[0] : ''}) values ($1, $2, 1000${extra ? ', ' + extra.split('=')[1] : ''}) returning id`, [org, d]))).id;
    riz = await p('Riz 5 kg', 'seuil_min=15');
    huile = await p('Huile 1 L');
    yaourt = await p('Yaourt nature', 'gere_peremption=true');
    sucre = await p('Sucre 1 kg');
    await q(`select public.inviter_membre($1, 'gilles@s.ci', 'gestionnaire_stock', false, $2)`, [org, [mag1]]);
    await q(`select public.inviter_membre($1, 'carine@s.ci', 'caissier', false, $2)`, [org, [mag1]]);
  });
});

afterAll(async () => {
  await pool?.end();
});

describe('Réceptions', () => {
  let premiere: { id: string; numero: string };

  it('répartit les frais d’approche au prorata de la valeur et fixe le coût moyen', async () => {
    premiere = await reception(alice, mag1, 3000, [
      [riz, 10, 3900],
      [huile, 20, 1200],
    ]);
    expect(premiere.numero).toBe('R-000001');
    await enTantQue(pool, alice, (q) => q(`select public.valider_reception($1)`, [premiere.id]));
    const r = await stock(mag1, riz);
    const h = await stock(mag1, huile);
    expect(r.q).toBe(10);
    expect(r.cmp).toBeCloseTo(3900 + (3000 * 3900) / 63000, 3);
    expect(h.cmp).toBeCloseTo(1200 + (3000 * 1200) / 63000, 3);
    const { rows } = await pool.query(`select sum(valeur)::int v from mouvements_stock where piece_id = $1`, [premiere.id]);
    expect(rows[0].v).toBe(63000 + 3000); // marchandises + frais, au franc près
    const prix = await pool.query(`select prix_achat from produits where id = $1`, [riz]);
    expect(n(prix.rows[0].prix_achat)).toBe(3900);
  });

  it('une seconde validation (double clic) ne crée aucun mouvement de plus', async () => {
    const avant = await pool.query(`select count(*)::int c from mouvements_stock`);
    const numero = await enTantQue(pool, alice, (q) => un(q<{ n: string }>(`select public.valider_reception($1) n`, [premiere.id])));
    const apres = await pool.query(`select count(*)::int c from mouvements_stock`);
    expect(numero.n).toBe('R-000001');
    expect(apres.rows[0].c).toBe(avant.rows[0].c);
  });

  it('une réception validée n’est plus modifiable ni annulable', async () => {
    const maj = await enTantQue(pool, alice, (q) =>
      q(`update receptions_lignes set quantite = 99 where reception_id = $1 returning id`, [premiere.id]),
    );
    expect(maj).toHaveLength(0);
    await expect(
      enTantQue(pool, alice, (q) =>
        q(`insert into receptions_lignes (organisation_id, reception_id, produit_id, quantite, prix_unitaire) values ($1, $2, $3, 1, 1)`, [org, premiere.id, riz]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(enTantQue(pool, alice, (q) => q(`select public.annuler_reception($1)`, [premiere.id]))).rejects.toThrow(
      /retour fournisseur ou un ajustement/,
    );
  });

  it('recalcule le coût moyen pondéré à la réception suivante', async () => {
    const avant = await stock(mag1, riz);
    const r2 = await reception(alice, mag1, 0, [[riz, 10, 4500]]);
    await enTantQue(pool, alice, (q) => q(`select public.valider_reception($1)`, [r2.id]));
    const apres = await stock(mag1, riz);
    expect(apres.q).toBe(20);
    expect(apres.cmp).toBeCloseTo((10 * avant.cmp + 10 * 4500) / 20, 3);
  });

  it('exige la date de péremption d’un produit périssable', async () => {
    const r = await reception(alice, mag1, 0, [[yaourt, 12, 250]]);
    await expect(enTantQue(pool, alice, (q) => q(`select public.valider_reception($1)`, [r.id]))).rejects.toThrow(
      /Date de péremption obligatoire/,
    );
    await enTantQue(pool, alice, (q) => q(`select public.annuler_reception($1)`, [r.id]));
    const ok = await reception(alice, mag1, 0, [[yaourt, 12, 250, '2020-01-31']]);
    await enTantQue(pool, alice, (q) => q(`select public.valider_reception($1)`, [ok.id]));
  });

  it('la caissière ne peut pas créer de réception', async () => {
    await expect(reception(carine, mag1, 0, [[riz, 1, 1]])).rejects.toThrow(/row-level security/);
  });
});

describe('Sorties et ajustements', () => {
  it('enregistre une perte au coût moyen avec son motif, et la trace au journal', async () => {
    const avant = await stock(mag1, riz);
    await enTantQue(pool, alice, (q) =>
      q(`select public.enregistrer_mouvement_manuel($1, $2, $3, 'perte', 3, 'Sacs percés par les rats')`, [org, mag1, riz]),
    );
    const apres = await stock(mag1, riz);
    expect(apres.q).toBe(avant.q - 3);
    expect(apres.cmp).toBeCloseTo(avant.cmp, 4);
    const m = await pool.query(`select valeur, motif from mouvements_stock where type = 'perte'`);
    expect(n(m.rows[0].valeur)).toBe(-Math.round(3 * avant.cmp));
    const a = await pool.query(`select contexte->>'motif' motif from journal_audit where action = 'stock.perte'`);
    expect(a.rows[0].motif).toBe('Sacs percés par les rats');
  });

  it('refuse une sortie sans motif ou supérieure au stock', async () => {
    await expect(
      enTantQue(pool, alice, (q) => q(`select public.enregistrer_mouvement_manuel($1, $2, $3, 'casse', 1, '')`, [org, mag1, riz])),
    ).rejects.toThrow(/motif est obligatoire/);
    await expect(
      enTantQue(pool, alice, (q) => q(`select public.enregistrer_mouvement_manuel($1, $2, $3, 'vol', 500, 'Constat')`, [org, mag1, riz])),
    ).rejects.toThrow(/Stock insuffisant pour « Riz 5 kg »/);
  });

  it('un ajustement exige le droit de validation', async () => {
    const membre = await pool.query(`select id from membres where user_id = $1`, [gilles]);
    await enTantQue(pool, alice, (q) =>
      q(`select public.definir_permission_membre($1, 'stock.valider', false)`, [membre.rows[0].id]),
    );
    await expect(
      enTantQue(pool, gilles, (q) =>
        q(`select public.enregistrer_mouvement_manuel($1, $2, $3, 'ajustement_plus', 2, 'Recomptage')`, [org, mag1, riz]),
      ),
    ).rejects.toThrow(/stock.valider/);
    // Une casse reste possible avec « stock.modifier ».
    await enTantQue(pool, gilles, (q) =>
      q(`select public.enregistrer_mouvement_manuel($1, $2, $3, 'casse', 1, 'Bouteille cassée')`, [org, mag1, huile]),
    );
    await enTantQue(pool, alice, (q) => q(`select public.definir_permission_membre($1, 'stock.valider', null)`, [membre.rows[0].id]));
  });

  it('une clé d’idempotence évite le double enregistrement', async () => {
    const cle = randomUUID();
    const avant = await stock(mag1, huile);
    for (let i = 0; i < 2; i++) {
      await enTantQue(pool, alice, (q) =>
        q(`select public.enregistrer_mouvement_manuel($1, $2, $3, 'consommation', 1, 'Usage boutique', null, $4)`, [org, mag1, huile, cle]),
      );
    }
    expect((await stock(mag1, huile)).q).toBe(avant.q - 1);
  });
});

describe('Concurrence', () => {
  it('deux sorties simultanées ne peuvent pas consommer le même stock', async () => {
    const r = await reception(alice, mag2, 0, [[sucre, 10, 500]]);
    await enTantQue(pool, alice, (q) => q(`select public.valider_reception($1)`, [r.id]));
    const tentative = () =>
      enTantQue(pool, alice, async (q) => {
        const res = await q(`select public.enregistrer_mouvement_manuel($1, $2, $3, 'consommation', 6, 'Test simultané')`, [org, mag2, sucre]);
        await q(`select pg_sleep(0.2)`);
        return res;
      });
    const resultats = await Promise.allSettled([tentative(), tentative()]);
    expect(resultats.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await stock(mag2, sucre)).q).toBe(4);
  });
});

describe('Transferts', () => {
  it('déplace le stock au même coût et reste idempotent', async () => {
    const source = await stock(mag1, riz);
    const cle = randomUUID();
    const lignes = JSON.stringify([{ produit_id: riz, quantite: 5 }]);
    const n1 = await enTantQue(pool, alice, (q) =>
      un(q<{ n: string }>(`select public.transferer_stock($1, $2, $3, $4::jsonb, 'Réassort', $5) n`, [org, mag1, mag2, lignes, cle])),
    );
    const n2 = await enTantQue(pool, alice, (q) =>
      un(q<{ n: string }>(`select public.transferer_stock($1, $2, $3, $4::jsonb, 'Réassort', $5) n`, [org, mag1, mag2, lignes, cle])),
    );
    expect(n1.n).toBe('TR-000001');
    expect(n2.n).toBe('TR-000001');
    expect((await stock(mag1, riz)).q).toBe(source.q - 5);
    const dest = await stock(mag2, riz);
    expect(dest.q).toBe(5);
    expect(dest.cmp).toBeCloseTo(source.cmp, 4);
  });

  it('refuse un transfert vers un magasin hors de son périmètre', async () => {
    await expect(
      enTantQue(pool, gilles, (q) =>
        q(`select public.transferer_stock($1, $2, $3, $4::jsonb)`, [org, mag1, mag2, JSON.stringify([{ produit_id: riz, quantite: 1 }])]),
      ),
    ).rejects.toThrow(/accès aux deux magasins/);
  });
});

describe('Inventaire', () => {
  let inv: string;

  it('ouvre un inventaire, compte au scan et refuse un second inventaire ouvert', async () => {
    inv = await enTantQue(pool, gilles, (q) => un(q<{ id: string }>(`select public.ouvrir_inventaire($1, $2) id`, [org, mag1]))).then((r) => r.id);
    await expect(enTantQue(pool, gilles, (q) => q(`select public.ouvrir_inventaire($1, $2)`, [org, mag1]))).rejects.toThrow(
      /déjà en cours/,
    );
    await enTantQue(pool, gilles, (q) => q(`select public.compter_inventaire($1, $2, 10)`, [inv, riz]));
    for (let i = 0; i < 3; i++) await enTantQue(pool, gilles, (q) => q(`select public.compter_inventaire($1, $2, 5, true)`, [inv, huile]));
    const l = await pool.query(`select quantite_comptee from inventaires_lignes where inventaire_id = $1 and produit_id = $2`, [inv, huile]);
    expect(n(l.rows[0].quantite_comptee)).toBe(15);
  });

  it('la validation ajuste les écarts sur le stock du moment et ignore les produits non comptés', async () => {
    const sucreAvant = await stock(mag1, sucre);
    const rizAvant = await stock(mag1, riz);
    const total = await enTantQue(pool, alice, (q) => un(q<{ t: string }>(`select public.valider_inventaire($1) t`, [inv])));
    expect((await stock(mag1, riz)).q).toBe(10);
    expect((await stock(mag1, huile)).q).toBe(15);
    expect((await stock(mag1, sucre)).q).toBe(sucreAvant.q);
    expect(n(total.t)).toBeLessThan(0);
    const ligne = await pool.query(`select ecart, quantite_systeme from inventaires_lignes where inventaire_id = $1 and produit_id = $2`, [inv, riz]);
    expect(n(ligne.rows[0].ecart)).toBe(10 - rizAvant.q);
    // Validation répétée sans effet
    const avant = await pool.query(`select count(*)::int c from mouvements_stock`);
    await enTantQue(pool, alice, (q) => q(`select public.valider_inventaire($1)`, [inv]));
    const apres = await pool.query(`select count(*)::int c from mouvements_stock`);
    expect(apres.rows[0].c).toBe(avant.rows[0].c);
  });
});

describe('Garanties du registre', () => {
  it('chaque solde est exactement la somme de ses mouvements', async () => {
    const { rows } = await pool.query(`
      select s.magasin_id, s.produit_id, s.quantite, coalesce(sum(m.quantite), 0) somme
      from stocks s left join mouvements_stock m on m.magasin_id = s.magasin_id and m.produit_id = s.produit_id
      group by s.magasin_id, s.produit_id, s.quantite`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(n(r.quantite)).toBe(n(r.somme));
  });

  it('un mouvement ne peut être ni modifié, ni supprimé, ni inséré directement', async () => {
    await expect(pool.query(`update mouvements_stock set quantite = 1`)).rejects.toThrow(/ni modifié ni supprimé/);
    await expect(pool.query(`delete from mouvements_stock`)).rejects.toThrow(/ni modifié ni supprimé/);
    await expect(
      enTantQue(pool, alice, (q) =>
        q(`insert into mouvements_stock (organisation_id, magasin_id, produit_id, type, quantite) values ($1, $2, $3, 'reception', 100)`, [org, mag1, riz]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('la caissière ne voit que le stock de son magasin', async () => {
    const vus = await enTantQue(pool, carine, (q) => q<{ magasin_id: string }>(`select magasin_id from stocks`));
    expect(vus.length).toBeGreaterThan(0);
    expect(vus.every((s) => s.magasin_id === mag1)).toBe(true);
    // v0.9 : la caissière n'a plus l'écran Stock (mouvements, coûts) ; elle garde le stock disponible par le catalogue.
    const mvts = await enTantQue(pool, carine, (q) => q<{ magasin_id: string }>(`select distinct magasin_id from mouvements_stock`));
    expect(mvts).toEqual([]);
  });
});

describe('État et alertes', () => {
  it('l’état consolidé additionne les magasins et valorise au CMP', async () => {
    const etat = await enTantQue(pool, alice, (q) =>
      q<{ designation: string; quantite: string; valeur: string }>(`select designation, quantite, valeur from public.etat_stock($1)`, [org]),
    );
    const r = etat.find((e) => e.designation === 'Riz 5 kg')!;
    expect(n(r.quantite)).toBe(15); // 10 au magasin + 5 au dépôt
    expect(n(r.valeur)).toBeGreaterThan(0);
  });

  it('signale le minimum atteint et le lot périmé', async () => {
    const alertes = await enTantQue(pool, alice, (q) =>
      q<{ type: string; designation: string }>(`select type, designation from public.alertes_stock($1)`, [org]),
    );
    expect(alertes).toContainEqual({ type: 'sous_minimum', designation: 'Riz 5 kg' });
    expect(alertes).toContainEqual({ type: 'perime', designation: 'Yaourt nature' });
  });
});
