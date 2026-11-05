import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

let pool: pg.Pool;
let admin: string; // administrateur général (premier compte)
let intrus: string; // compte quelconque
let awa: string; // gérante principale de l'entreprise créée par l'administrateur
let koffi: string; // gérant d'une seconde entreprise
let org: string;
let org2: string;

const un = async <T>(p: Promise<T[]>) => (await p)[0]!;
const info = (uid: string | null) =>
  enTantQue(pool, uid, (q) => un(q<{ i: Record<string, boolean> }>(`select public.plateforme_info() i`))).then((r) => r.i);

beforeAll(async () => {
  pool = await preparerBase('admin');
  admin = await creerCompte(pool, 'admin@df.ci', 'Bérenger');
  intrus = await creerCompte(pool, 'intrus@x.ci');
});

afterAll(async () => {
  await pool?.end();
});

describe('première installation', () => {
  it('sans administrateur, la plateforme le signale (même sans être connecté)', async () => {
    expect(await info(null)).toMatchObject({ admin_existe: false, je_suis_admin: false });
    expect(await info(intrus)).toMatchObject({ admin_existe: false, creation_entreprise_possible: true });
  });

  it('le premier compte qui le demande devient administrateur général, une seule fois', async () => {
    await enTantQue(pool, admin, (q) => q(`select public.devenir_admin_general()`));
    expect(await info(admin)).toMatchObject({ admin_existe: true, je_suis_admin: true });
    await expect(enTantQue(pool, intrus, (q) => q(`select public.devenir_admin_general()`))).rejects.toThrow(/existe déjà/);
    const { rows } = await pool.query(`select count(*)::int n from journal_audit where action = 'plateforme.admin_general'`);
    expect(rows[0].n).toBe(1);
  });

  it('l’application ne peut pas appeler la promotion réservée à l’éditeur SQL', async () => {
    await expect(enTantQue(pool, admin, (q) => q(`select public.promouvoir_admin_general('intrus@x.ci')`))).rejects.toThrow(/permission denied/);
  });

  it('une fois l’administrateur désigné, un compte quelconque ne crée plus d’entreprise', async () => {
    expect(await info(intrus)).toMatchObject({ creation_entreprise_possible: false });
    await expect(enTantQue(pool, intrus, (q) => q(`select public.creer_organisation('Pirate')`))).rejects.toThrow(/réservée à l'administrateur/);
  });
});

describe('entreprises clientes', () => {
  it('l’administrateur crée l’entreprise, son magasin, sa caisse et l’accès du gérant principal', async () => {
    org = (await enTantQue(pool, admin, (q) => un(q<{ id: string }>(
      `select public.admin_creer_entreprise('Boutique Awa', ' Awa@Boutique.CI ', null, 'non_precise', '0707070707', 'Angré', 'Abidjan', 'Boutique Angré') id`)))).id;
    const { rows: inv } = await pool.query(`select email, role_code, tous_magasins, statut from invitations where organisation_id = $1`, [org]);
    expect(inv).toEqual([{ email: 'awa@boutique.ci', role_code: 'proprietaire', tous_magasins: true, statut: 'en_attente' }]);
    const { rows: c } = await pool.query(`select count(*)::int n from caisses where organisation_id = $1`, [org]);
    expect(c[0].n).toBe(1);
    // Couleur de la marque Le Décodeur Financier par défaut.
    const { rows: o } = await pool.query(`select couleur from organisations where id = $1`, [org]);
    expect(o[0].couleur).toBe('decodeur');
    // L'administrateur n'en devient pas membre.
    const { rows: m } = await pool.query(`select count(*)::int n from membres where organisation_id = $1`, [org]);
    expect(m[0].n).toBe(0);
  });

  it('un compte non administrateur ne peut pas créer d’entreprise cliente', async () => {
    await expect(enTantQue(pool, intrus, (q) => q(`select public.admin_creer_entreprise('X', 'x@x.ci')`))).rejects.toThrow(/Réservé/);
  });

  it('le gérant crée son compte : il devient propriétaire et crée ses caisses', async () => {
    awa = await creerCompte(pool, 'awa@boutique.ci', 'Awa Koné');
    await enTantQue(pool, awa, async (q) => {
      expect((await un(q<{ n: number }>(`select public.accepter_invitations() n`))).n).toBe(1);
      const orgs = await q<{ role_code: string }>(`select * from public.mes_organisations()`);
      expect(orgs.map((o) => o.role_code)).toEqual(['proprietaire']);
      const mag = await un(q<{ id: string }>(`select id from magasins where organisation_id = $1`, [org]));
      await q(`insert into caisses (organisation_id, magasin_id, code, nom) values ($1, $2, 'CAISSE02', 'Caisse 2')`, [org, mag.id]);
    });
  });

  it('un gérant déjà inscrit est rattaché aussitôt à une nouvelle entreprise', async () => {
    koffi = await creerCompte(pool, 'koffi@k.ci');
    org2 = (await enTantQue(pool, admin, (q) => un(q<{ id: string }>(`select public.admin_creer_entreprise('Quincaillerie Koffi', 'koffi@k.ci') id`)))).id;
    const orgs = await enTantQue(pool, koffi, (q) => q<{ organisation_id: string }>(`select * from public.mes_organisations()`));
    expect(orgs.map((o) => o.organisation_id)).toEqual([org2]);
  });

  it('les entreprises restent isolées entre gérants', async () => {
    const vues = await enTantQue(pool, awa, (q) => q<{ id: string }>(`select id from organisations`));
    expect(vues.map((v) => v.id)).toEqual([org]);
    const magasins = await enTantQue(pool, koffi, (q) => q(`select * from magasins where organisation_id = $1`, [org]));
    expect(magasins).toHaveLength(0);
  });
});

describe('consultation par l’administrateur général', () => {
  let session: string;

  beforeAll(async () => {
    // Une vente dans l'entreprise d'Awa.
    await enTantQue(pool, awa, async (q) => {
      const c = await un(q<{ id: string }>(`select id from caisses where organisation_id = $1 and code = 'CAISSE01'`, [org]));
      session = (await un(q<{ id: string }>(`select public.ouvrir_session($1, $2, 5000) id`, [org, c.id]))).id;
      const p = await un(q<{ id: string }>(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'Savon', 500) returning id`, [org]));
      const especes = await un(q<{ id: string }>(`select id from moyens_paiement where organisation_id = $1 and code = 'especes'`, [org]));
      await q(`select public.enregistrer_vente($1::jsonb)`, [JSON.stringify({
        id: randomUUID(), organisation_id: org, caisse_id: c.id, session_id: session, date_vente: new Date().toISOString(),
        lignes: [{ produit_id: p.id, quantite: 3, prix_unitaire: 500 }], reglements: [{ moyen_id: especes.id, montant: 1500 }],
      })]);
    });
  });

  it('voit toutes les entreprises dans sa liste, en consultation', async () => {
    const orgs = await enTantQue(pool, admin, (q) => q<{ nom: string; role_code: string; permissions: string[] }>(`select * from public.mes_organisations()`));
    expect(orgs.map((o) => o.nom)).toEqual(['Boutique Awa', 'Quincaillerie Koffi']);
    expect(orgs[0]!.role_code).toBe('admin_general');
    expect(orgs[0]!.permissions).toContain('ventes.consulter');
    expect(orgs[0]!.permissions.some((p) => /\.(creer|modifier|valider|supprimer)$/.test(p))).toBe(false);
  });

  it('lit magasins, caisses, ventes, stock, utilisateurs et journal de chaque entreprise', async () => {
    await enTantQue(pool, admin, async (q) => {
      expect(await q(`select * from organisations where id = $1`, [org])).toHaveLength(1);
      expect(await q(`select * from parametres_impression where organisation_id = $1`, [org])).toHaveLength(1);
      expect(await q(`select * from moyens_paiement where organisation_id = $1`, [org])).toHaveLength(8);
      expect(await q(`select * from magasins where organisation_id = $1`, [org])).toHaveLength(1);
      expect(await q(`select * from caisses where organisation_id = $1`, [org])).toHaveLength(2);
      expect(await q(`select * from ventes where organisation_id = $1`, [org])).toHaveLength(1);
      expect(await q(`select * from membres where organisation_id = $1`, [org])).toHaveLength(1);
      expect((await q(`select * from journal_audit where organisation_id = $1`, [org])).length).toBeGreaterThan(0);
      expect(await q(`select * from public.etat_stock($1)`, [org])).toHaveLength(1);
      const r = await un(q<{ r: { total_ventes: number } }>(`select public.rapport_session($1) r`, [session]));
      expect(r.r.total_ventes).toBe(1500);
    });
  });

  it('ne peut ni écrire, ni vendre, ni ouvrir une caisse, ni modifier un membre', async () => {
    const mag = (await pool.query(`select id from magasins where organisation_id = $1`, [org])).rows[0].id;
    const caisse = (await pool.query(`select id from caisses where organisation_id = $1 and code = 'CAISSE02'`, [org])).rows[0].id;
    const membre = (await pool.query(`select id from membres where organisation_id = $1`, [org])).rows[0].id;
    await expect(enTantQue(pool, admin, (q) => q(`insert into magasins (organisation_id, code, nom) values ($1, 'MAG09', 'X')`, [org]))).rejects.toThrow(/row-level security/);
    await expect(enTantQue(pool, admin, (q) => q(`insert into produits (organisation_id, designation, prix_vente) values ($1, 'X', 1)`, [org]))).rejects.toThrow(/row-level security/);
    const maj = await enTantQue(pool, admin, (q) => q(`update organisations set nom = 'Piraté' where id = $1 returning id`, [org]));
    expect(maj).toHaveLength(0);
    await expect(enTantQue(pool, admin, (q) => q(`select public.ouvrir_session($1, $2, 0)`, [org, caisse]))).rejects.toThrow(/caisse\.creer/);
    await expect(enTantQue(pool, admin, (q) => q(`select public.cloturer_session($1, 0)`, [session]))).rejects.toThrow();
    await expect(enTantQue(pool, admin, (q) => q(`select public.desactiver_membre($1, 'test admin')`, [membre]))).rejects.toThrow(/utilisateurs\.modifier/);
    await expect(enTantQue(pool, admin, (q) => q(`select public.enregistrer_mouvement_manuel($1, $2, (select id from produits where organisation_id = $1 limit 1), 'perte', 1, 'test', null, gen_random_uuid())`, [org, mag]))).rejects.toThrow();
  });

  it('tableau de bord : ventes du jour et du mois, caisses ouvertes, gérants', async () => {
    const lignes = await enTantQue(pool, admin, (q) => q<Record<string, unknown>>(`select * from public.admin_tableau_de_bord()`));
    const awaL = lignes.find((l) => l.organisation_id === org)!;
    expect(awaL).toMatchObject({ nom: 'Boutique Awa', caisses: 2, caisses_ouvertes: 1, utilisateurs: 1, actif: true, gerants_en_attente: [] });
    expect(Number(awaL.ventes_jour)).toBe(1500);
    expect(Number(awaL.tickets_jour)).toBe(1);
    expect(Number(awaL.ventes_mois)).toBe(1500);
    expect((awaL.gerants as { email: string }[])[0]!.email).toBe('awa@boutique.ci');
    await expect(enTantQue(pool, awa, (q) => q(`select * from public.admin_tableau_de_bord()`))).rejects.toThrow(/Réservé/);
  });
});

describe('suspension d’une entreprise', () => {
  it('motif obligatoire, réservé à l’administrateur', async () => {
    await expect(enTantQue(pool, admin, (q) => q(`select public.admin_suspendre_entreprise($1, '')`, [org]))).rejects.toThrow(/motif/);
    await expect(enTantQue(pool, awa, (q) => q(`select public.admin_suspendre_entreprise($1, 'impayé')`, [org]))).rejects.toThrow(/Réservé/);
  });

  it('coupe l’accès du gérant ; l’administrateur voit toujours l’entreprise ; la réactivation rétablit tout', async () => {
    await enTantQue(pool, admin, (q) => q(`select public.admin_suspendre_entreprise($1, 'Abonnement impayé')`, [org]));
    expect(await enTantQue(pool, awa, (q) => q(`select * from public.mes_organisations()`))).toHaveLength(0);
    expect(await enTantQue(pool, awa, (q) => q(`select * from magasins`))).toHaveLength(0);
    const orgs = await enTantQue(pool, admin, (q) => q<{ nom: string }>(`select nom from public.mes_organisations()`));
    expect(orgs.map((o) => o.nom)).toContain('Boutique Awa (suspendue)');
    const { rows } = await pool.query(`select contexte from journal_audit where organisation_id = $1 and action = 'organisations.update' order by id desc limit 1`, [org]);
    expect(rows[0].contexte).toEqual({ motif: 'Abonnement impayé' });
    await enTantQue(pool, admin, (q) => q(`select public.admin_reactiver_entreprise($1)`, [org]));
    expect(await enTantQue(pool, awa, (q) => q(`select * from public.mes_organisations()`))).toHaveLength(1);
  });
});

describe('contrôles de la fonction de création d’accès', () => {
  const ctrl = (uid: string, email: string) =>
    enTantQue(pool, uid, (q) => un(q<{ r: { statut: string; organisations?: string[]; user_id?: string } }>(`select public.controle_creation_compte($1) r`, [email]))).then((x) => x.r);
  const reinit = (uid: string, email: string) =>
    enTantQue(pool, uid, (q) => un(q<{ r: { statut: string; user_id?: string } }>(`select public.controle_reinitialisation($1) r`, [email]))).then((x) => x.r);

  it('administrateur : accès d’un gérant invité qui n’a pas encore de compte', async () => {
    await enTantQue(pool, admin, (q) => q(`select public.admin_ajouter_gerant($1, 'adjoint@boutique.ci')`, [org]));
    expect(await ctrl(admin, 'adjoint@boutique.ci')).toEqual({ statut: 'ok', organisations: [org] });
    expect((await ctrl(admin, 'awa@boutique.ci')).statut).toBe('existe');
    expect((await ctrl(admin, 'personne@nulle.part')).statut).toBe('refuse');
  });

  it('gérant : accès de ses caissiers ; pas d’un propriétaire s’il ne l’est pas ; jamais pour une autre entreprise', async () => {
    await enTantQue(pool, awa, (q) => q(`select public.inviter_membre($1, 'caissier@boutique.ci', 'caissier', true)`, [org]));
    expect((await ctrl(awa, 'caissier@boutique.ci')).statut).toBe('ok');
    expect((await ctrl(koffi, 'caissier@boutique.ci')).statut).toBe('refuse');
    expect((await ctrl(intrus, 'caissier@boutique.ci')).statut).toBe('refuse');
  });

  it('réinitialisation : le gérant pour ses employés, l’administrateur pour les gérants, personne pour l’administrateur', async () => {
    const caissier = await creerCompte(pool, 'caissier@boutique.ci');
    await enTantQue(pool, caissier, (q) => q(`select public.accepter_invitations()`));
    expect(await reinit(awa, 'caissier@boutique.ci')).toMatchObject({ statut: 'ok', user_id: caissier });
    expect((await reinit(koffi, 'caissier@boutique.ci')).statut).toBe('refuse');
    expect((await reinit(admin, 'awa@boutique.ci')).statut).toBe('ok');
    expect((await reinit(awa, 'admin@df.ci')).statut).toBe('refuse');
    expect((await reinit(awa, 'awa@boutique.ci')).statut).toBe('refuse');
    // Une personne aussi membre d'une autre entreprise échappe au gérant d'une seule d'entre elles.
    await enTantQue(pool, koffi, (q) => q(`select public.inviter_membre($1, 'caissier@boutique.ci', 'vendeur', true)`, [org2]));
    expect((await reinit(awa, 'caissier@boutique.ci')).statut).toBe('refuse');
  });
});

describe('inscription libre', () => {
  it('l’administrateur peut rouvrir la création d’entreprise à tous', async () => {
    await expect(enTantQue(pool, awa, (q) => q(`select public.admin_definir_inscription_libre(true)`))).rejects.toThrow(/Réservé/);
    await enTantQue(pool, admin, (q) => q(`select public.admin_definir_inscription_libre(true)`));
    const id = await enTantQue(pool, intrus, (q) => un(q<{ id: string }>(`select public.creer_organisation('Libre') id`)));
    expect(id.id).toBeTruthy();
    await enTantQue(pool, admin, (q) => q(`select public.admin_definir_inscription_libre(false)`));
  });
});
