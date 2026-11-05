import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

let pool: pg.Pool;
let alice: string; // propriétaire A
let bruno: string; // propriétaire B
let vendeur: string; // vendeur chez A (consultation du catalogue seulement)
let orgA: string;
let orgB: string;

const un = async <T>(p: Promise<T[]>) => (await p)[0]!;

beforeAll(async () => {
  pool = await preparerBase('catalogue');
  alice = await creerCompte(pool, 'alice@a.ci');
  bruno = await creerCompte(pool, 'bruno@b.ci');
  vendeur = await creerCompte(pool, 'vendeur@a.ci');
  orgA = (await enTantQue(pool, alice, (q) => un(q<{ id: string }>(`select public.creer_organisation('Supérette A') id`)))).id;
  orgB = (await enTantQue(pool, bruno, (q) => un(q<{ id: string }>(`select public.creer_organisation('Boutique B') id`)))).id;
  await enTantQue(pool, alice, (q) => q(`select public.inviter_membre($1, 'vendeur@a.ci', 'vendeur', true)`, [orgA]));
});

afterAll(async () => {
  await pool?.end();
});

async function creerProduit(uid: string, org: string, designation: string, extra: Record<string, unknown> = {}) {
  const cols = ['organisation_id', 'designation', ...Object.keys(extra)];
  const vals = [org, designation, ...Object.values(extra)];
  return enTantQue(pool, uid, (q) =>
    un(
      q<{ id: string; code: string }>(
        `insert into produits (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning id, code`,
        vals,
      ),
    ),
  );
}

describe('Produits', () => {
  it('attribue un code interne automatique et séquentiel par entreprise', async () => {
    const p1 = await creerProduit(alice, orgA, 'Riz parfumé 5 kg', { prix_vente: 4500 });
    const p2 = await creerProduit(alice, orgA, 'Huile Dinor 1 L', { prix_vente: 1500 });
    const pB = await creerProduit(bruno, orgB, 'Sucre en morceaux', { prix_vente: 800 });
    expect([p1.code, p2.code, pB.code]).toEqual(['P00001', 'P00002', 'P00001']);
  });

  it('accepte un code interne choisi, en majuscules, et refuse un doublon', async () => {
    const p = await creerProduit(alice, orgA, 'Lait concentré', { code: 'lait-01', prix_vente: 650 });
    expect(p.code).toBe('LAIT-01');
    await expect(creerProduit(alice, orgA, 'Autre', { code: 'LAIT-01' })).rejects.toThrow(/duplicate key/);
  });

  it('refuse un prix négatif et un taux de TVA non prévu', async () => {
    await expect(creerProduit(alice, orgA, 'Erreur', { prix_vente: -1 })).rejects.toThrow(/check constraint/);
    await expect(creerProduit(alice, orgA, 'Erreur', { taux_tva: 12 })).rejects.toThrow(/check constraint/);
  });

  it('historise chaque changement de prix et l’inscrit au journal', async () => {
    const p = await creerProduit(alice, orgA, 'Savon Kabakrou', { prix_vente: 300, prix_achat: 220 });
    await enTantQue(pool, alice, (q) => q(`update produits set prix_vente = 350 where id = $1`, [p.id]));
    await enTantQue(pool, alice, (q) => q(`update produits set designation = 'Savon Kabakrou 200 g' where id = $1`, [p.id]));
    const h = await enTantQue(pool, alice, (q) =>
      q<{ prix_vente: string }>(`select prix_vente from prix_historique where produit_id = $1 order by id`, [p.id]),
    );
    expect(h.map((x) => Number(x.prix_vente))).toEqual([300, 350]);
    const audit = await enTantQue(pool, alice, (q) =>
      q<{ avant: number; apres: number }>(
        `select (avant->>'prix_vente')::int avant, (apres->>'prix_vente')::int apres from journal_audit
          where action = 'produits.update' and objet_id = $1 and avant->>'prix_vente' <> apres->>'prix_vente'`,
        [p.id],
      ),
    );
    expect(audit).toEqual([{ avant: 300, apres: 350 }]);
  });

  it('isole le catalogue entre entreprises', async () => {
    const vus = await enTantQue(pool, alice, (q) => q<{ organisation_id: string }>(`select organisation_id from produits`));
    expect(vus.every((p) => p.organisation_id === orgA)).toBe(true);
    await expect(creerProduit(alice, orgB, 'Intrusion')).rejects.toThrow(/row-level security/);
  });

  it('le vendeur consulte le catalogue mais ne peut ni créer ni modifier un prix', async () => {
    const vus = await enTantQue(pool, vendeur, (q) => q(`select id from produits`));
    expect(vus.length).toBeGreaterThan(0);
    await expect(creerProduit(vendeur, orgA, 'Non autorisé')).rejects.toThrow(/row-level security/);
    const r = await enTantQue(pool, vendeur, (q) => q(`update produits set prix_vente = 1 returning id`));
    expect(r).toHaveLength(0);
  });
});

describe('Codes-barres', () => {
  it('rattache un code scanné et refuse le même code sur un autre produit de l’entreprise', async () => {
    const p = await creerProduit(alice, orgA, 'Coca-Cola 33 cl', { prix_vente: 500 });
    const autre = await creerProduit(alice, orgA, 'Fanta 33 cl', { prix_vente: 500 });
    await enTantQue(pool, alice, (q) =>
      q(`insert into codes_barres (organisation_id, produit_id, code) values ($1, $2, ' 5449000000996 ')`, [orgA, p.id]),
    );
    await expect(
      enTantQue(pool, alice, (q) =>
        q(`insert into codes_barres (organisation_id, produit_id, code) values ($1, $2, '5449000000996')`, [orgA, autre.id]),
      ),
    ).rejects.toThrow(/duplicate key/);
    // Le même code reste utilisable par une autre entreprise.
    const pB = await creerProduit(bruno, orgB, 'Coca-Cola 33 cl', { prix_vente: 550 });
    await enTantQue(pool, bruno, (q) =>
      q(`insert into codes_barres (organisation_id, produit_id, code) values ($1, $2, '5449000000996')`, [orgB, pB.id]),
    );
  });

  it('génère des EAN-13 internes valides, uniques et préfixés 20', async () => {
    const p = await creerProduit(alice, orgA, 'Pain sucré', { prix_vente: 200 });
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) {
      codes.push(
        (await enTantQue(pool, alice, (q) => un(q<{ c: string }>(`select public.generer_code_barres($1) c`, [p.id])))).c,
      );
    }
    expect(new Set(codes).size).toBe(3);
    for (const c of codes) {
      expect(c).toMatch(/^20\d{11}$/);
      const ok = await enTantQue(pool, alice, (q) => un(q<{ v: boolean }>(`select public.ean13_valide($1) v`, [c])));
      expect(ok.v).toBe(true);
    }
  });

  it('évite un code généré déjà saisi manuellement', async () => {
    const p = await creerProduit(alice, orgA, 'Biscuit', { prix_vente: 100 });
    // On réserve à la main le prochain code que le compteur produirait.
    const { rows } = await pool.query(`select valeur from compteurs where organisation_id = $1 and nom = 'ean_interne'`, [orgA]);
    const prochain = '20' + String(Number(rows[0].valeur) + 1).padStart(10, '0');
    const cle = (await pool.query(`select public.cle_ean13($1) k`, [prochain])).rows[0].k;
    await enTantQue(pool, alice, (q) =>
      q(`insert into codes_barres (organisation_id, produit_id, code) values ($1, $2, $3)`, [orgA, p.id, prochain + cle]),
    );
    const genere = (await enTantQue(pool, alice, (q) => un(q<{ c: string }>(`select public.generer_code_barres($1) c`, [p.id])))).c;
    expect(genere).not.toBe(prochain + cle);
  });

  it('le vendeur ne peut pas générer de code-barres', async () => {
    const { rows } = await pool.query(`select id from produits where organisation_id = $1 limit 1`, [orgA]);
    await expect(
      enTantQue(pool, vendeur, (q) => q(`select public.generer_code_barres($1)`, [rows[0].id])),
    ).rejects.toThrow(/catalogue.modifier/);
  });
});

describe('Recherche', () => {
  it('trouve par code-barres exact en premier', async () => {
    const r = await enTantQue(pool, alice, (q) =>
      q<{ designation: string; pertinence: number }>(`select designation, pertinence from public.rechercher_produits($1, '5449000000996')`, [orgA]),
    );
    expect(r[0]).toEqual({ designation: 'Coca-Cola 33 cl', pertinence: 0 });
    expect(r).toHaveLength(1);
  });

  it('trouve par mots sans tenir compte des accents ni de l’ordre', async () => {
    const r = await enTantQue(pool, alice, (q) =>
      q<{ designation: string }>(`select designation from public.rechercher_produits($1, 'PARFUME riz')`, [orgA]),
    );
    expect(r.map((x) => x.designation)).toEqual(['Riz parfumé 5 kg']);
  });

  it('trouve par code interne', async () => {
    const r = await enTantQue(pool, alice, (q) =>
      q<{ code: string }>(`select code from public.rechercher_produits($1, 'p00002')`, [orgA]),
    );
    expect(r[0]!.code).toBe('P00002');
  });

  it('respecte l’isolation : la recherche de B ne voit pas le catalogue de A', async () => {
    const r = await enTantQue(pool, bruno, (q) => q(`select * from public.rechercher_produits($1, 'riz')`, [orgA]));
    expect(r).toHaveLength(0);
  });

  it('exclut les produits arrêtés sauf demande explicite', async () => {
    await enTantQue(pool, alice, (q) => q(`update produits set statut = 'arrete' where designation = 'Biscuit'`));
    const sans = await enTantQue(pool, alice, (q) => q(`select * from public.rechercher_produits($1, 'biscuit')`, [orgA]));
    const avec = await enTantQue(pool, alice, (q) =>
      q(`select * from public.rechercher_produits($1, 'biscuit', 20, true)`, [orgA]),
    );
    expect([sans.length, avec.length]).toEqual([0, 1]);
  });
});

describe('Catégories', () => {
  it('crée catégories et sous-catégories, refuse un doublon de nom au même niveau', async () => {
    const parent = await enTantQue(pool, alice, (q) =>
      un(q<{ id: string }>(`insert into categories (organisation_id, nom) values ($1, 'Boissons') returning id`, [orgA])),
    );
    await enTantQue(pool, alice, (q) =>
      q(`insert into categories (organisation_id, parent_id, nom) values ($1, $2, 'Sodas')`, [orgA, parent.id]),
    );
    await expect(
      enTantQue(pool, alice, (q) => q(`insert into categories (organisation_id, nom) values ($1, 'boissons')`, [orgA])),
    ).rejects.toThrow(/duplicate key/);
  });
});

describe('Personnalisation', () => {
  it('crée les paramètres d’impression par défaut (A4 divisé en 6)', async () => {
    const p = await enTantQue(pool, alice, (q) => un(q<{ format: string }>(`select format from parametres_impression where organisation_id = $1`, [orgA])));
    expect(p.format).toBe('a4_6');
  });

  it('seul un utilisateur habilité modifie l’identité et le modèle de reçu', async () => {
    await enTantQue(pool, alice, (q) =>
      q(`update organisations set rccm = 'CI-ABJ-2026-B-12345', couleur = 'ocean' where id = $1`, [orgA]),
    );
    await enTantQue(pool, alice, (q) =>
      q(`update parametres_impression set format = 'thermique_80', pied = 'Merci !' where organisation_id = $1`, [orgA]),
    );
    const r = await enTantQue(pool, vendeur, (q) =>
      q(`update parametres_impression set pied = 'Piraté' where organisation_id = $1 returning 1`, [orgA]),
    );
    expect(r).toHaveLength(0);
    await expect(
      enTantQue(pool, alice, (q) => q(`update organisations set couleur = 'fluo' where id = $1`, [orgA])),
    ).rejects.toThrow(/check constraint/);
  });

  it('le logo ne peut être déposé que dans le dossier de sa propre entreprise', async () => {
    await enTantQue(pool, alice, (q) =>
      q(`insert into storage.objects (bucket_id, name, owner) values ('logos', $1, $2)`, [`${orgA}/logo.png`, alice]),
    );
    await expect(
      enTantQue(pool, alice, (q) =>
        q(`insert into storage.objects (bucket_id, name, owner) values ('logos', $1, $2)`, [`${orgB}/logo.png`, alice]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      enTantQue(pool, vendeur, (q) =>
        q(`insert into storage.objects (bucket_id, name, owner) values ('logos', $1, $2)`, [`${orgA}/autre.png`, vendeur]),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      enTantQue(pool, alice, (q) =>
        q(`insert into storage.objects (bucket_id, name, owner) values ('logos', 'pas-un-dossier/logo.png', $1)`, [alice]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});
