import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Base de test : PostgreSQL local (TEST_DATABASE_URL) remis à zéro à chaque
 * exécution, puis préparé avec le shim Supabase et toutes les migrations.
 * Ne jamais pointer cette variable vers une base de production.
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:54329/postgres';

export function urlBase(nom: string): string {
  const u = new URL(ADMIN_URL);
  u.pathname = `/${nom}`;
  return u.toString();
}

/** Chaque fichier de test a sa propre base, pour pouvoir s'exécuter en parallèle. */
export async function preparerBase(suffixe: string): Promise<pg.Pool> {
  const DB_NAME = `dfg_vitest_${suffixe.replace(/[^a-z0-9_]/gi, '_').toLowerCase()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${DB_NAME} with (force)`);
  await admin.query(`create database ${DB_NAME}`);
  await admin.end();

  const pool = new pg.Pool({ connectionString: urlBase(DB_NAME), max: 4 });
  const racine = join(import.meta.dirname, '..', '..');
  await pool.query(readFileSync(join(racine, 'tests/db/shim-supabase.sql'), 'utf8'));
  const dossier = join(racine, 'supabase/migrations');
  for (const fichier of readdirSync(dossier).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(readFileSync(join(dossier, fichier), 'utf8'));
  }
  return pool;
}

/** Crée un compte comme le ferait Supabase Auth à l'inscription. */
export async function creerCompte(pool: pg.Pool, email: string, nom = 'Test'): Promise<string> {
  const { rows } = await pool.query(
    `insert into auth.users (id, email, raw_user_meta_data)
     values (gen_random_uuid(), $1, jsonb_build_object('nom_complet', $2::text)) returning id`,
    [email, nom],
  );
  return rows[0].id as string;
}

export type Execution = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

/**
 * Exécute du SQL exactement comme l'API Supabase pour un utilisateur connecté :
 * rôle `authenticated` et claims JWT positionnés, dans une transaction.
 * Une erreur annule la transaction et est relancée.
 */
export async function enTantQue<R>(pool: pg.Pool, userId: string | null, fn: (q: Execution) => Promise<R>): Promise<R> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`set local role ${userId ? 'authenticated' : 'anon'}`);
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify(userId ? { sub: userId, role: 'authenticated' } : { role: 'anon' }),
    ]);
    const q: Execution = async (sql, params) => (await client.query(sql, params)).rows;
    const res = await fn(q);
    await client.query('commit');
    return res;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

/** Dans la même transaction, agit désormais comme cet utilisateur (auth.uid() change). */
export async function devenir(q: Execution, userId: string) {
  await q(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
}

/**
 * Le gérant principal ne vend pas : il ouvre la caisse pour un caissier. Rattache le caissier
 * (compte déjà créé avec creerCompte) s'il n'est pas encore membre, ouvre la caisse pour lui
 * avec le fond indiqué, et laisse q agir COMME LE CAISSIER (revenir avec devenir(q, gerant)).
 */
export async function ouvrirPourCaissier(
  q: Execution,
  o: { org: string; caisse: string; fond?: number; gerant: string; caissier: string; email: string },
): Promise<string> {
  const deja = await q<{ n: number }>(`select count(*)::int n from public.membres where organisation_id = $1 and user_id = $2`, [o.org, o.caissier]);
  if (!deja[0]!.n) {
    const invite = await q<{ n: number }>(
      `select count(*)::int n from public.invitations where organisation_id = $1 and lower(email) = lower($2) and statut = 'en_attente'`, [o.org, o.email]);
    if (!invite[0]!.n) await q(`select public.inviter_membre($1, $2, 'caissier', true, '{}', '{}')`, [o.org, o.email]);
    await devenir(q, o.caissier);
    await q(`select public.accepter_invitations()`);
    await devenir(q, o.gerant);
  }
  const s = await q<{ id: string }>(`select public.ouvrir_session($1, $2, $3, $4) id`, [o.org, o.caisse, o.fond ?? 0, o.caissier]);
  await devenir(q, o.caissier);
  return s[0]!.id;
}
