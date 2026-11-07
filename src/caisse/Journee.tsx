import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { messageErreur } from '../lib/format';
import { montant } from '../lib/argent';
import { Alerte, Fenetre, Pastille } from '../components/ui';

interface FicheJournee {
  id: string;
  date: string;
  statut: 'ouverte' | 'cloturee';
  ouverte_le: string;
  ouverte_par: string | null;
  cloturee_le: string | null;
  cloturee_par: string | null;
  totaux: {
    caisses: number;
    nombre_ventes: number;
    total_ventes: number;
    nombre_annulations: number;
    ecart: number;
    par_moyen: { libelle: string; montant: number }[];
  } | null;
}

export interface EtatJournee {
  aujourdhui: string;
  maintenant: string;
  suivie: boolean;
  ouverte: FicheJournee | null;
  derniere: FicheJournee | null;
  peut_gerer: boolean;
  peut_rouvrir: boolean;
  caisses_ouvertes: string[];
  historique: FicheJournee[];
}

const ZONE = 'Africa/Abidjan';
export const jourLong = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: ZONE });
const heure = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: ZONE }) : '');

/** État de la journée de l'entreprise (null tant que le serveur ne le fournit pas). */
export function useJournee(org: string | undefined) {
  const [etat, setEtat] = useState<EtatJournee | null>(null);
  const recharger = useCallback(async () => {
    if (!org) return;
    const { data, error } = await supabase.rpc('ma_journee', { p_org: org });
    if (!error) setEtat(data as EtatJournee);
  }, [org]);
  useEffect(() => {
    void recharger();
  }, [recharger]);
  return { etat, recharger };
}

/** Vrai quand l'entreprise suit les journées et qu'aucune n'est ouverte : rien ne peut s'ouvrir. */
export const journeeFermee = (e: EtatJournee | null) => !!e && e.suivie && !e.ouverte;

/**
 * Bandeau de la journée pour le gérant : date du jour (celle du serveur), ouverture,
 * clôture une fois toutes les caisses fermées, réouverture par le gérant principal.
 */
export function BandeauJournee({ org, etat, horsLigne, onChange }: { org: string; etat: EtatJournee | null; horsLigne: boolean; onChange: () => void }) {
  const [erreur, setErreur] = useState('');
  const [envoi, setEnvoi] = useState(false);
  const [confirmer, setConfirmer] = useState(false);
  const [bilan, setBilan] = useState<FicheJournee | null>(null);
  if (!etat) return null;

  // Horloge de l'appareil faussée de plus de 5 minutes : on prévient.
  const decalage = Math.abs(Date.now() - new Date(etat.maintenant).getTime());
  const horlogeFausse = decalage > 5 * 60 * 1000;
  const o = etat.ouverte;
  const enRetard = !!o && o.date !== etat.aujourdhui;
  const clotureeAujourdhui = !o && etat.derniere?.date === etat.aujourdhui && etat.derniere.statut === 'cloturee' ? etat.derniere : null;

  async function action(fn: 'ouvrir_journee' | 'cloturer_journee') {
    setErreur('');
    setEnvoi(true);
    const { data, error } = await supabase.rpc(fn, { p_org: org });
    setEnvoi(false);
    if (error) return setErreur(messageErreur(error));
    setConfirmer(false);
    if (fn === 'cloturer_journee') setBilan(data as FicheJournee);
    onChange();
  }

  const ton = o ? (enRetard ? 'or' : 'vert') : 'gris';
  return (
    <section className={`carte bandeau-journee ${o ? 'journee-ouverte' : 'journee-fermee'}`}>
      <div className="bandeau-journee-ligne">
        <div className="bandeau-journee-date">
          <span className="secondaire">Aujourd’hui</span>
          <strong>{jourLong(etat.aujourdhui)}</strong>
        </div>
        <Pastille ton={ton}>{o ? (enRetard ? `Journée du ${jourLong(o.date)} encore ouverte` : 'Journée ouverte') : clotureeAujourdhui ? 'Journée clôturée' : 'Journée non ouverte'}</Pastille>
      </div>
      {horlogeFausse && (
        <Alerte>
          {`La date ou l’heure de cet appareil est fausse (${new Date().toLocaleString('fr-FR', { timeZone: ZONE })}). Corrigez-la dans les réglages du téléphone : l’application utilise la date du serveur.`}
        </Alerte>
      )}
      <Alerte>{erreur}</Alerte>

      {o && !enRetard && (
        <p className="secondaire bandeau-journee-texte">
          Ouverte à {heure(o.ouverte_le)}
          {o.ouverte_par ? ` par ${o.ouverte_par}` : ''}. En fin de journée, clôturez chaque caisse puis la journée : plus aucune opération ne sera
          possible jusqu’à demain.
        </p>
      )}
      {enRetard && (
        <p className="bandeau-journee-texte">
          La journée du <strong>{jourLong(o!.date)}</strong> n’a pas été clôturée. Clôturez ses caisses puis la journée, avant d’ouvrir celle
          d’aujourd’hui.
        </p>
      )}
      {!o && !clotureeAujourdhui && (
        <p className="bandeau-journee-texte">
          Voulez-vous ouvrir la journée du <strong>{jourLong(etat.aujourdhui)}</strong> ? Les caisses s’ouvrent ensuite, une par une.
        </p>
      )}
      {clotureeAujourdhui && (
        <p className="secondaire bandeau-journee-texte">
          Clôturée à {heure(clotureeAujourdhui.cloturee_le)}
          {clotureeAujourdhui.cloturee_par ? ` par ${clotureeAujourdhui.cloturee_par}` : ''}
          {clotureeAujourdhui.totaux
            ? ` · ${montant(Number(clotureeAujourdhui.totaux.total_ventes))} de ventes, ${clotureeAujourdhui.totaux.nombre_ventes} tickets`
            : ''}
          . Aucune opération n’est possible jusqu’à la prochaine ouverture.
        </p>
      )}

      {etat.peut_gerer && (
        <div className="actions-demande">
          {!o && !clotureeAujourdhui && (
            <button type="button" className="bouton bouton-principal" disabled={envoi || horsLigne} onClick={() => void action('ouvrir_journee')}>
              ☀️ Ouvrir la journée du {new Date(`${etat.aujourdhui}T12:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: ZONE })}
            </button>
          )}
          {o && (
            <button type="button" className="bouton bouton-discret" disabled={envoi || horsLigne} onClick={() => setConfirmer(true)}>
              🌙 Clôturer la journée{enRetard ? ` du ${new Date(`${o.date}T12:00:00Z`).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: ZONE })}` : ''}
            </button>
          )}
          {clotureeAujourdhui && etat.peut_rouvrir && (
            <button
              type="button"
              className="bouton-lien"
              disabled={envoi || horsLigne}
              onClick={() => window.confirm('Rouvrir la journée d’aujourd’hui ? Les opérations seront de nouveau possibles.') && void action('ouvrir_journee')}
            >
              Rouvrir la journée
            </button>
          )}
        </div>
      )}
      {!etat.peut_gerer && !o && <p className="secondaire petit-texte">Le gérant ouvre la journée, puis votre caisse.</p>}

      <Fenetre titre="Clôturer la journée" ouverte={confirmer} onFermer={() => setConfirmer(false)}>
        {o && (
          <div className="rapport-provisoire">
            <p>
              Journée du <strong>{jourLong(o.date)}</strong>.
            </p>
            {etat.caisses_ouvertes.length > 0 ? (
              <Alerte>{`Clôturez d’abord les caisses encore ouvertes : ${etat.caisses_ouvertes.join(', ')}.`}</Alerte>
            ) : (
              <p className="secondaire">
                Toutes les caisses sont clôturées. Après la clôture, plus personne ne pourra enregistrer de vente, de dépense, de mouvement de
                stock ni d’annulation jusqu’à la prochaine ouverture.
              </p>
            )}
            <Alerte>{erreur}</Alerte>
            <button
              type="button"
              className="bouton bouton-principal bouton-plein"
              disabled={envoi || etat.caisses_ouvertes.length > 0}
              onClick={() => void action('cloturer_journee')}
            >
              {envoi ? 'Clôture…' : 'Confirmer la clôture de la journée'}
            </button>
          </div>
        )}
      </Fenetre>

      <Fenetre titre={bilan ? `Journée du ${jourLong(bilan.date)} clôturée` : ''} ouverte={!!bilan} onFermer={() => setBilan(null)}>
        {bilan?.totaux && (
          <div className="rapport-provisoire">
            <div className="rapport-chiffres">
              <div>
                <span>Ventes</span>
                <strong>{montant(Number(bilan.totaux.total_ventes))}</strong>
              </div>
              <div>
                <span>Tickets</span>
                <strong>{bilan.totaux.nombre_ventes}</strong>
              </div>
              <div>
                <span>Caisses</span>
                <strong>{bilan.totaux.caisses}</strong>
              </div>
              <div>
                <span>Écart de caisse</span>
                <strong className={Number(bilan.totaux.ecart) < 0 ? 'texte-negatif' : ''}>{montant(Number(bilan.totaux.ecart))}</strong>
              </div>
            </div>
            {bilan.totaux.par_moyen.length > 0 && (
              <div className="rapport-bloc">
                <h3>Règlements</h3>
                {bilan.totaux.par_moyen.map((m) => (
                  <div key={m.libelle} className="rapport-ligne">
                    <span>{m.libelle}</span>
                    <strong>{montant(Number(m.montant))}</strong>
                  </div>
                ))}
              </div>
            )}
            <button type="button" className="bouton bouton-principal bouton-plein" onClick={() => setBilan(null)}>
              Fermer
            </button>
          </div>
        )}
      </Fenetre>
    </section>
  );
}
