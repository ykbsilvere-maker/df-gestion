import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

let pool: pg.Pool;
// Comptes
let alice: string; // propriétaire de l'entreprise A
let bruno: string; // propriétaire de l'entreprise B
let chantal: string; // caissière invitée chez A (magasin 1 uniquement)
let gerard: string; // gérant chez A, limité au magasin 1
// Données
let orgA: string;
let orgB: string;
let magA1: string;
let magA2: string;
let caisseA1: string;
let magB1: string;

const q1 = async <T>(p: Promise<T[]>) => (await p)[0];

beforeAll(async () => {
  pool = await preparerBase('socle');
  alice = await creerCompte(pool, 'alice@boutique-a.ci', 'Alice Kouassi');
  bruno = await creerCompte(pool, 'bruno@boutique-b.ci', 'Bruno Koné');

  orgA = (await enTantQue(pool, alice, (q) =>
    q1(q<{ id: string }>(`select public.creer_organisation('Supérette Alice', 'AB123456', 'rsi') as id`)),
  ))!.id;
  orgB = (await enTantQue(pool, bruno, (q) =>
    q1(q<{ id: string }>(`select public.creer_organisation('Boutique Bruno') as id`)),
  ))!.id;

  await enTantQue(pool, alice, async (q) => {
    magA1 = (await q1(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [orgA])))!.id;
    caisseA1 = (await q1(q<{ id: string }>(`select id from caisses where magasin_id = $1`, [magA1])))!.id;
    magA2 = (await q1(
      q<{ id: string }>(
        `insert into magasins (organisation_id, code, nom) values ($1, 'MAG02', 'Magasin Cocody') returning id`,
        [orgA],
      ),
    ))!.id;
  });
  magB1 = (await q1(
    pool.query(`select id from magasins where organisation_id = $1`, [orgB]).then((r) => r.rows),
  ))!.id;
});

afterAll(async () => {
  await pool?.end();
});

describe('Création d’entreprise', () => {
  it('crée l’entreprise, le propriétaire, le premier magasin et la première caisse', async () => {
    const orgs = await enTantQue(pool, alice, (q) => q(`select * from public.mes_organisations()`));
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ organisation_id: orgA, role_code: 'proprietaire', tous_magasins: true });
    expect((orgs[0] as { permissions: string[] }).permissions).toHaveLength(117);
  });

  it('refuse un appel sans connexion', async () => {
    await expect(enTantQue(pool, null, (q) => q(`select public.creer_organisation('Pirate')`))).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('Isolation entre entreprises', () => {
  it('Alice ne voit aucune donnée de l’entreprise B', async () => {
    await enTantQue(pool, alice, async (q) => {
      expect(await q(`select id from organisations where id = $1`, [orgB])).toHaveLength(0);
      expect(await q(`select id from magasins where organisation_id = $1`, [orgB])).toHaveLength(0);
      expect(await q(`select id from caisses where organisation_id = $1`, [orgB])).toHaveLength(0);
      expect(await q(`select id from membres where organisation_id = $1`, [orgB])).toHaveLength(0);
      expect(await q(`select id from journal_audit where organisation_id = $1`, [orgB])).toHaveLength(0);
      expect(await q(`select id from profils where id = $1`, [bruno])).toHaveLength(0);
    });
  });

  it('Alice ne peut pas créer de magasin dans l’entreprise B', async () => {
    await expect(
      enTantQue(pool, alice, (q) =>
        q(`insert into magasins (organisation_id, code, nom) values ($1, 'PIRATE', 'Pirate')`, [orgB]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('Alice ne peut pas rattacher une caisse de son entreprise à un magasin de B', async () => {
    await expect(
      enTantQue(pool, alice, (q) =>
        q(`insert into caisses (organisation_id, magasin_id, code, nom) values ($1, $2, 'C9', 'Pirate')`, [
          orgA,
          magB1,
        ]),
      ),
    ).rejects.toThrow(/row-level security|foreign key/);
  });

  it('Alice ne peut pas modifier l’entreprise B', async () => {
    const r = await enTantQue(pool, alice, (q) =>
      q(`update organisations set nom = 'Volée' where id = $1 returning id`, [orgB]),
    );
    expect(r).toHaveLength(0);
  });

  it('un visiteur non connecté ne lit rien', async () => {
    await expect(enTantQue(pool, null, (q) => q(`select * from organisations`))).rejects.toThrow(/permission denied/);
  });
});

describe('Invitations et périmètre', () => {
  it('invite une caissière sans compte, rattachée à sa première connexion', async () => {
    await enTantQue(pool, alice, (q) =>
      q(`select public.inviter_membre($1, ' Chantal@Boutique-A.ci ', 'caissier', false, $2, $3)`, [
        orgA,
        [magA1],
        [caisseA1],
      ]),
    );
    const inv = await enTantQue(pool, alice, (q) =>
      q(`select email, statut from invitations where organisation_id = $1`, [orgA]),
    );
    expect(inv).toEqual([{ email: 'chantal@boutique-a.ci', statut: 'en_attente' }]);

    chantal = await creerCompte(pool, 'chantal@boutique-a.ci', 'Chantal Yao');
    const n = await enTantQue(pool, chantal, (q) => q1(q<{ n: number }>(`select public.accepter_invitations() as n`)));
    expect(n!.n).toBe(1);

    const orgs = await enTantQue(pool, chantal, (q) => q(`select organisation_id, role_code from public.mes_organisations()`));
    expect(orgs).toEqual([{ organisation_id: orgA, role_code: 'caissier' }]);
  });

  it('la caissière ne voit que son magasin et sa propre fiche', async () => {
    await enTantQue(pool, chantal, async (q) => {
      const mags = await q<{ id: string }>(`select id from magasins`);
      expect(mags.map((m) => m.id)).toEqual([magA1]);
      const membres = await q<{ user_id: string }>(`select user_id from membres`);
      expect(membres.map((m) => m.user_id)).toEqual([chantal]);
      expect(await q(`select id from journal_audit`)).toHaveLength(0);
      expect(await q(`select id from invitations`)).toHaveLength(0);
    });
  });

  it('la caissière ne peut ni inviter, ni créer de magasin, ni modifier l’entreprise', async () => {
    await expect(
      enTantQue(pool, chantal, (q) => q(`select public.inviter_membre($1, 'x@y.ci', 'vendeur')`, [orgA])),
    ).rejects.toThrow(/utilisateurs.creer/);
    await expect(
      enTantQue(pool, chantal, (q) =>
        q(`insert into magasins (organisation_id, code, nom) values ($1, 'MAG03', 'Non autorisé')`, [orgA]),
      ),
    ).rejects.toThrow(/row-level security/);
    const r = await enTantQue(pool, chantal, (q) =>
      q(`update organisations set nom = 'Changée' where id = $1 returning id`, [orgA]),
    );
    expect(r).toHaveLength(0);
  });

  it('une personne qui a déjà un compte est rattachée immédiatement', async () => {
    gerard = await creerCompte(pool, 'gerard@boutique-a.ci', 'Gérard Bamba');
    await enTantQue(pool, alice, (q) =>
      q(`select public.inviter_membre($1, 'gerard@boutique-a.ci', 'gerant_magasin', false, $2)`, [orgA, [magA1]]),
    );
    const orgs = await enTantQue(pool, gerard, (q) => q(`select role_code, tous_magasins from public.mes_organisations()`));
    expect(orgs).toEqual([{ role_code: 'gerant_magasin', tous_magasins: false }]);
  });

  it('un gérant limité ne peut pas étendre les droits au-delà de son périmètre', async () => {
    await expect(
      enTantQue(pool, gerard, (q) => q(`select public.inviter_membre($1, 'v@a.ci', 'vendeur', true)`, [orgA])),
    ).rejects.toThrow(/tous les magasins/);
    await expect(
      enTantQue(pool, gerard, (q) =>
        q(`select public.inviter_membre($1, 'v@a.ci', 'vendeur', false, $2)`, [orgA, [magA2]]),
      ),
    ).rejects.toThrow(/auxquels vous avez accès/);
    await expect(
      enTantQue(pool, gerard, (q) => q(`select public.inviter_membre($1, 'v@a.ci', 'proprietaire')`, [orgA])),
    ).rejects.toThrow(/Seul un propriétaire/);
    // Dans son périmètre, l'invitation passe.
    await enTantQue(pool, gerard, (q) =>
      q(`select public.inviter_membre($1, 'v@a.ci', 'vendeur', false, $2)`, [orgA, [magA1]]),
    );
  });

  it('un gérant ne peut pas modifier le propriétaire ni ses propres droits', async () => {
    const membreAlice = (await enTantQue(pool, alice, (q) =>
      q1(q<{ id: string }>(`select id from membres where user_id = $1`, [alice])),
    ))!.id;
    const membreGerard = (await enTantQue(pool, alice, (q) =>
      q1(q<{ id: string }>(`select id from membres where user_id = $1`, [gerard])),
    ))!.id;
    await expect(
      enTantQue(pool, gerard, (q) => q(`select public.desactiver_membre($1, 'test')`, [membreAlice])),
    ).rejects.toThrow(/Seul un propriétaire/);
    await expect(
      enTantQue(pool, gerard, (q) =>
        q(`select public.modifier_membre($1, 'gerant_magasin', true)`, [membreGerard]),
      ),
    ).rejects.toThrow(/propres droits/);
  });
});

describe('Désactivation et propriétaires', () => {
  it('une propriétaire ne peut pas se retirer elle-même, et les fonctions internes sont inaccessibles', async () => {
    // Seul un propriétaire peut agir sur un propriétaire, et jamais sur lui-même :
    // l'entreprise garde donc toujours au moins un propriétaire actif.
    const membreAlice = (await enTantQue(pool, alice, (q) =>
      q1(q<{ id: string }>(`select id from membres where user_id = $1`, [alice])),
    ))!.id;
    await expect(
      enTantQue(pool, alice, (q) => q(`select public.desactiver_membre($1, 'départ')`, [membreAlice])),
    ).rejects.toThrow(/propres droits/);
    const r = await enTantQue(pool, alice, (q) =>
      q1(q<{ n: number }>(`select prive.compter_proprietaires_actifs($1) as n`, [orgA])).catch(() => null),
    ).catch(() => null);
    // La fonction interne n'est pas exécutable par un utilisateur.
    expect(r).toBeNull();
  });

  it('désactiver coupe immédiatement l’accès et trace le motif ; réactiver le rétablit', async () => {
    const membreChantal = (await enTantQue(pool, alice, (q) =>
      q1(q<{ id: string }>(`select id from membres where user_id = $1`, [chantal])),
    ))!.id;

    await expect(
      enTantQue(pool, alice, (q) => q(`select public.desactiver_membre($1, '')`, [membreChantal])),
    ).rejects.toThrow(/motif/);

    await enTantQue(pool, alice, (q) =>
      q(`select public.desactiver_membre($1, 'Fin de contrat')`, [membreChantal]),
    );
    await enTantQue(pool, chantal, async (q) => {
      expect(await q(`select * from public.mes_organisations()`)).toHaveLength(0);
      expect(await q(`select id from magasins`)).toHaveLength(0);
      expect(await q(`select id from organisations`)).toHaveLength(0);
    });

    const audit = await enTantQue(pool, alice, (q) =>
      q<{ contexte: { motif: string }; user_id: string }>(
        `select contexte, user_id from journal_audit
          where organisation_id = $1 and action = 'membres.update' and objet_id = $2
          order by id desc limit 1`,
        [orgA, membreChantal],
      ),
    );
    expect(audit[0]).toMatchObject({ contexte: { motif: 'Fin de contrat' }, user_id: alice });

    await enTantQue(pool, alice, (q) => q(`select public.reactiver_membre($1)`, [membreChantal]));
    const mags = await enTantQue(pool, chantal, (q) => q<{ id: string }>(`select id from magasins`));
    expect(mags.map((m) => m.id)).toEqual([magA1]);
  });
});

describe('Droits individuels', () => {
  it('un droit ajouté puis retiré change l’accès au journal d’audit', async () => {
    const membreChantal = (await enTantQue(pool, alice, (q) =>
      q1(q<{ id: string }>(`select id from membres where user_id = $1`, [chantal])),
    ))!.id;
    await enTantQue(pool, alice, (q) =>
      q(`select public.definir_permission_membre($1, 'audit.consulter', true)`, [membreChantal]),
    );
    const vu = await enTantQue(pool, chantal, (q) => q(`select id from journal_audit limit 1`));
    expect(vu.length).toBe(1);

    await enTantQue(pool, alice, (q) =>
      q(`select public.definir_permission_membre($1, 'audit.consulter', null)`, [membreChantal]),
    );
    expect(await enTantQue(pool, chantal, (q) => q(`select id from journal_audit`))).toHaveLength(0);

    // Retrait d'un droit du rôle : la caissière perd la consultation du catalogue.
    await enTantQue(pool, alice, (q) =>
      q(`select public.definir_permission_membre($1, 'catalogue.consulter', false)`, [membreChantal]),
    );
    const perms = await enTantQue(pool, chantal, (q) =>
      q1(q<{ permissions: string[] }>(`select permissions from public.mes_organisations()`)),
    );
    expect(perms!.permissions).not.toContain('catalogue.consulter');
    expect(perms!.permissions).toContain('ventes.creer');
  });

  it('un gérant ne peut pas déléguer un droit qu’il n’a pas', async () => {
    const membreChantal = (await enTantQue(pool, alice, (q) =>
      q1(q<{ id: string }>(`select id from membres where user_id = $1`, [chantal])),
    ))!.id;
    await expect(
      enTantQue(pool, gerard, (q) =>
        q(`select public.definir_permission_membre($1, 'comptabilite.cloturer', true)`, [membreChantal]),
      ),
    ).rejects.toThrow(/que vous n'avez pas/);
  });
});

describe('Écritures directes interdites', () => {
  it('aucune modification directe des membres, même par le propriétaire', async () => {
    await expect(
      enTantQue(pool, alice, (q) => q(`update membres set role_code = 'proprietaire' where user_id = $1`, [chantal])),
    ).rejects.toThrow(/permission denied/);
  });

  it('les colonnes protégées de l’entreprise ne sont pas modifiables', async () => {
    await expect(
      enTantQue(pool, alice, (q) => q(`update organisations set actif = false where id = $1`, [orgA])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('Journal d’audit', () => {
  it('trace la création du magasin avec son auteur', async () => {
    const r = await enTantQue(pool, alice, (q) =>
      q(`select user_id, apres->>'code' as code from journal_audit
          where organisation_id = $1 and action = 'magasins.insert' and objet_id = $2`, [orgA, magA2]),
    );
    expect(r).toEqual([{ user_id: alice, code: 'MAG02' }]);
  });

  it('enregistre la connexion sans ligne parasite sur la fiche membre', async () => {
    const avant = await pool.query(`select count(*)::int n from journal_audit where action = 'membres.update'`);
    await enTantQue(pool, alice, (q) => q(`select public.enregistrer_connexion('Tablette caisse', 'test-agent')`));
    const apres = await pool.query(`select count(*)::int n from journal_audit where action = 'membres.update'`);
    expect(apres.rows[0].n).toBe(avant.rows[0].n);
    const c = await pool.query(
      `select contexte from journal_audit where action = 'session.connexion' and user_id = $1`,
      [alice],
    );
    expect(c.rows[0].contexte).toMatchObject({ appareil: 'Tablette caisse' });
    const m = await pool.query(`select derniere_connexion from membres where user_id = $1`, [alice]);
    expect(m.rows[0].derniere_connexion).not.toBeNull();
  });

  it('ne peut être ni modifié ni supprimé, même par l’administrateur de la base', async () => {
    await expect(pool.query(`update journal_audit set action = 'x'`)).rejects.toThrow(/ni modifié ni supprimé/);
    await expect(pool.query(`delete from journal_audit`)).rejects.toThrow(/ni modifié ni supprimé/);
    await expect(pool.query(`truncate journal_audit`)).rejects.toThrow(/ni modifié ni supprimé/);
  });

  it('un utilisateur ne peut pas écrire dans le journal', async () => {
    await expect(
      enTantQue(pool, alice, (q) =>
        q(`insert into journal_audit (organisation_id, action) values ($1, 'faux')`, [orgA]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
