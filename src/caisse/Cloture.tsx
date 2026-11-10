import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { clavierMontant, deviseCourante, libelleCoupure, lireMontant, montant } from '../lib/argent';
import { messageErreur } from '../lib/format';
import { Alerte, Champ } from '../components/ui';
import { ConfirmerCode } from '../components/ConfirmerCode';
import type { RapportSession } from '../impression/RapportCaisse';

/**
 * Clôture de la session : comptage des espèces (par coupure ou en total), comparaison
 * avec le montant attendu, justification de l'écart, puis rapport Z.
 */
export function Cloture({
  sessionId,
  enAttente,
  rejetees,
  onCloturee,
}: {
  sessionId: string;
  enAttente: number;
  rejetees: number;
  onCloturee: (z: RapportSession) => void;
}) {
  const [rapport, setRapport] = useState<RapportSession | null>(null);
  const [erreur, setErreur] = useState('');
  const [mode, setMode] = useState<'coupures' | 'total'>('coupures');
  const [nombres, setNombres] = useState<Record<string, string>>({});
  const [totalSaisi, setTotalSaisi] = useState('');
  const [motif, setMotif] = useState('');
  const [enCours, setEnCours] = useState(false);

  useEffect(() => {
    void supabase.rpc('rapport_session', { p_session: sessionId }).then(({ data, error }) => {
      if (error) setErreur(messageErreur(error));
      else setRapport(data as RapportSession);
    });
  }, [sessionId]);

  const d = deviseCourante();
  const coupures = [...d.billets.map((v) => ({ cle: String(v), valeur: v, piece: false })), ...d.pieces.map((v) => ({ cle: `p${v}`, valeur: v, piece: true }))];
  const totalCoupures = coupures.reduce((s, c) => s + c.valeur * (Number(nombres[c.cle]) || 0), 0);
  const compte = mode === 'coupures' ? totalCoupures : lireMontant(totalSaisi);
  const attendu = rapport?.especes_attendues ?? 0;
  const ecart = compte == null ? null : compte - attendu;
  const motifRequis = ecart != null && ecart !== 0;
  const bloque = enAttente > 0;
  const possible = !!rapport && compte != null && (!motifRequis || motif.trim().length >= 3) && !bloque && !enCours;

  const [confirmation, setConfirmation] = useState(false);
  async function cloturer() {
    if (!possible || compte == null) return;
    setEnCours(true);
    setErreur('');
    const billetage =
      mode === 'coupures'
        ? Object.fromEntries(Object.entries(nombres).filter(([, n]) => Number(n) > 0).map(([c, n]) => [c, Number(n)]))
        : null;
    const { data, error } = await supabase.rpc('cloturer_session', {
      p_session: sessionId,
      p_especes_comptees: compte,
      p_billetage: billetage,
      p_motif_ecart: motifRequis ? motif.trim() : null,
    });
    setEnCours(false);
    if (error) return setErreur(messageErreur(error));
    onCloturee(data as RapportSession);
  }

  return (
    <div className="cloture">
      {bloque && (
        <Alerte>
          {enAttente} vente{enAttente > 1 ? 's' : ''} hors connexion pas encore envoyée{enAttente > 1 ? 's' : ''}. Reconnectez
          l’appareil et synchronisez avant de clôturer : sinon elles manqueraient au rapport Z.
        </Alerte>
      )}
      {rejetees > 0 && (
        <Alerte type="info">
          {rejetees} vente{rejetees > 1 ? 's' : ''} refusée{rejetees > 1 ? 's' : ''} par le serveur ne figure{rejetees > 1 ? 'nt' : ''} pas
          dans les totaux (voir « Ventes refusées »).
        </Alerte>
      )}
      <Alerte>{erreur}</Alerte>
      {!rapport && !erreur && <p>Calcul des totaux…</p>}

      {rapport && (
        <>
          <div className="cloture-resume">
            <div>
              <span>Ventes</span>
              <strong>{rapport.nombre_ventes}</strong>
            </div>
            <div>
              <span>Chiffre d’affaires</span>
              <strong>{montant(rapport.total_ventes)}</strong>
            </div>
            <div>
              <span>Espèces attendues</span>
              <strong>{montant(attendu)}</strong>
              <small>
                fond {montant(rapport.fond_initial)} + encaissé {montant(rapport.especes_encaissees)}
              </small>
            </div>
          </div>

          <div className="onglets onglets-compacts" role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'coupures'} className={mode === 'coupures' ? 'actif' : ''} onClick={() => setMode('coupures')}>
              Compter par coupure
            </button>
            <button type="button" role="tab" aria-selected={mode === 'total'} className={mode === 'total' ? 'actif' : ''} onClick={() => setMode('total')}>
              Saisir le total
            </button>
          </div>

          {mode === 'coupures' ? (
            <div className="billetage">
              {coupures.map((c) => (
                <label key={c.cle} className="billetage-ligne">
                  <span className={c.piece ? 'coupure coupure-piece' : 'coupure'}>
                    {libelleCoupure(c.valeur)}
                    <small>{c.piece ? 'pièce' : 'billet'}</small>
                  </span>
                  <input
                    inputMode="numeric"
                    value={nombres[c.cle] ?? ''}
                    onChange={(e) => setNombres((n) => ({ ...n, [c.cle]: e.target.value.replace(/\D/g, '') }))}
                    aria-label={`Nombre de ${c.piece ? 'pièces' : 'billets'} de ${c.valeur}`}
                    placeholder="0"
                  />
                  <span className="billetage-sous-total">{montant(c.valeur * (Number(nombres[c.cle]) || 0), '')}</span>
                </label>
              ))}
            </div>
          ) : (
            <Champ label={`Espèces comptées (${d.symbole})`}>
              <input inputMode={clavierMontant()} value={totalSaisi} onChange={(e) => setTotalSaisi(e.target.value)} autoFocus />
            </Champ>
          )}

          <div className="cloture-bilan">
            <div>
              <span>Comptées</span>
              <strong>{compte == null ? '—' : montant(compte)}</strong>
            </div>
            <div className={ecart ? (ecart < 0 ? 'texte-negatif' : 'texte-positif') : ''}>
              <span>Écart</span>
              <strong>
                {ecart == null ? '—' : `${ecart > 0 ? '+ ' : ''}${montant(ecart)}`}
                {ecart != null && ecart < 0 ? ' (manquant)' : ecart != null && ecart > 0 ? ' (excédent)' : ''}
              </strong>
            </div>
          </div>

          {motifRequis && (
            <Champ label="Justification de l’écart *" aide="Obligatoire : elle figure sur le rapport Z et dans le journal.">
              <textarea rows={2} maxLength={300} value={motif} onChange={(e) => setMotif(e.target.value)} />
            </Champ>
          )}

          <button type="button" className="bouton bouton-principal bouton-plein" disabled={!possible} onClick={() => setConfirmation(true)}>
            {enCours ? 'Clôture…' : 'Clôturer et imprimer le rapport Z'}
          </button>
        </>
      )}
      <ConfirmerCode
        ouverte={confirmation}
        titre="Clôturer la caisse"
        consigne="Saisissez votre code d’entrée pour confirmer la clôture de la caisse."
        onFermer={() => setConfirmation(false)}
        onValide={() => {
          setConfirmation(false);
          void cloturer();
        }}
      />
    </div>
  );
}
