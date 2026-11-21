import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { creerCompte, enTantQue, preparerBase } from './helpers';

// 3.22 : un message Telegram non parti est renvoyé (jusqu'à 5 essais), sans que personne soit connecté.
let pool: pg.Pool;
let alice: string;
let org: string;

beforeAll(async () => {
  pool = await preparerBase('v3220');
  alice = await creerCompte(pool, 'alice@v322.ci', 'Alice');
  org = (await enTantQue(pool, alice, (q) => q<{ id: string }>(`select public.creer_organisation('Chez Alice') id`)))[0]!.id;
  await pool.query(`insert into prive.telegram_robot (jeton, nom_utilisateur, nom, secret) values ('1:x', 'dfg_bot', 'DF Gestion', 's')`);
  await pool.query(`insert into prive.otp_membres (organisation_id, user_id, actif, otp, chat_id) values ($1, $2, true, true, 77)`, [org, alice]);
});
afterAll(async () => {
  await pool?.end();
});

describe('Relance des notifications', () => {
  it('garde le message, le renvoie, puis abandonne après 5 essais', async () => {
    await pool.query(`select prive.notifier($1, $2, 'Nouvelle commande')`, [org, alice]);
    const n = (await pool.query(`select statut, essais, chat_id from prive.notifications_envoi`)).rows;
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ statut: 'envoi', essais: 1, chat_id: '77' });
    await pool.query(`update prive.notifications_envoi set maj_le = now() - interval '3 minutes'`);
    expect((await pool.query(`select prive.relancer_notifications() r`)).rows[0].r).toBe(1);
    expect((await pool.query(`select essais from prive.notifications_envoi`)).rows[0].essais).toBe(2);
    await pool.query(`update prive.notifications_envoi set maj_le = now() - interval '3 minutes', essais = 5`);
    await pool.query(`select prive.relancer_notifications()`);
    expect((await pool.query(`select statut from prive.notifications_envoi`)).rows[0].statut).toBe('echec');
  });
});
