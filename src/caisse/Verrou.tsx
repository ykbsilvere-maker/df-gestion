import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';

/**
 * Code personnel de caisse (4 à 6 chiffres).
 * Vérifié par le serveur ; une empreinte locale (PBKDF2) permet de déverrouiller sans réseau.
 * La caisse se verrouille à l'ouverture, après 5 minutes sans activité et sur demande.
 */

const INACTIVITE_MS = 5 * 60 * 1000;

async function empreinteLocale(uid: string, code: string): Promise<string | null> {
  try {
    const cle = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt: new TextEncoder().encode(`dfg-caisse:${uid}`), iterations: 60000, hash: 'SHA-256' },
      cle,
      256,
    );
    return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

const cleLocale = (org: string, uid: string) => `dfg_code_caisse_${org}_${uid}`;
function lireLocal(org: string, uid: string): { defini: boolean; empreinte?: string } | null {
  try {
    const v = localStorage.getItem(cleLocale(org, uid));
    return v ? (JSON.parse(v) as { defini: boolean; empreinte?: string }) : null;
  } catch {
    return null;
  }
}
function ecrireLocal(org: string, uid: string, v: { defini: boolean; empreinte?: string }) {
  try {
    localStorage.setItem(cleLocale(org, uid), JSON.stringify(v));
  } catch {
    /* stockage indisponible */
  }
}

function Clavier({ valeur, onChange, onValider, longueurMax = 6 }: { valeur: string; onChange: (v: string) => void; onValider: () => void; longueurMax?: number }) {
  const touches = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'];
  const pret = valeur.length >= 4;
  return (
    <div className="clavier-pin">
      {touches.map((t) => (
        <button
          key={t}
          type="button"
          className={`touche-pin ${t === '✓' ? 'touche-pin-valider' : ''} ${t === '⌫' ? 'touche-pin-effacer' : ''} ${t === '✓' && pret ? 'pret' : ''}`}
          disabled={(t === '✓' && !pret) || (t === '⌫' && !valeur)}
          onClick={() => {
            if (t === '⌫') onChange(valeur.slice(0, -1));
            else if (t === '✓') onValider();
            else if (valeur.length < longueurMax) onChange(valeur + t);
          }}
          aria-label={t === '⌫' ? 'Effacer' : t === '✓' ? 'Valider' : t}
        >
          {t === '⌫' ? (
            <>
              <span aria-hidden>⌫</span>
              <small>Effacer</small>
            </>
          ) : t === '✓' ? (
            <>
              <span aria-hidden>✓</span>
              <small>Valider</small>
            </>
          ) : (
            t
          )}
        </button>
      ))}
    </div>
  );
}

function Points({ code, visible }: { code: string; visible: boolean }) {
  return (
    <div className="points-pin" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <span key={i} className={`${i < code.length ? 'plein' : ''} ${i >= 4 ? 'facultatif' : ''} ${visible ? 'chiffre' : ''}`}>
          {visible && i < code.length ? code[i] : ''}
        </span>
      ))}
    </div>
  );
}

export function VerrouCaisse({ children }: { children: ReactNode }) {
  const { organisation, session } = useSession();
  const org = organisation!.organisation_id;
  const uid = session?.user.id ?? '';
  const nom = (session?.user.user_metadata?.nom_complet as string | undefined) ?? session?.user.email ?? '';
  const [etat, setEtat] = useState<'chargement' | 'creer' | 'verrouille' | 'ouvert'>('chargement');
  const [code, setCode] = useState('');
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [erreur, setErreur] = useState('');
  const [occupe, setOccupe] = useState(false);
  const [voir, setVoir] = useState(false);
  const derniereActivite = useRef(Date.now());

  useEffect(() => {
    let actif = true;
    void supabase.rpc('etat_code_caisse', { p_org: org }).then(({ data, error }) => {
      if (!actif) return;
      if (error) {
        // Hors ligne : on se fie à ce que l'appareil sait.
        const l = lireLocal(org, uid);
        setEtat(l?.defini ? 'verrouille' : l ? 'creer' : 'verrouille');
        return;
      }
      const l = lireLocal(org, uid);
      ecrireLocal(org, uid, { defini: !!data, empreinte: data ? l?.empreinte : undefined });
      setEtat(data ? 'verrouille' : 'creer');
    });
    return () => {
      actif = false;
    };
  }, [org, uid]);

  const verrouiller = useCallback(() => {
    setCode('');
    setErreur('');
    setEtat((e) => (e === 'ouvert' ? 'verrouille' : e));
  }, []);

  // Verrouillage automatique après 5 minutes sans activité.
  useEffect(() => {
    if (etat !== 'ouvert') return;
    const activite = () => {
      derniereActivite.current = Date.now();
    };
    const evenements = ['pointerdown', 'keydown', 'touchstart'];
    evenements.forEach((e) => window.addEventListener(e, activite, { passive: true }));
    const minuterie = window.setInterval(() => {
      if (Date.now() - derniereActivite.current > INACTIVITE_MS) verrouiller();
    }, 15000);
    return () => {
      evenements.forEach((e) => window.removeEventListener(e, activite));
      window.clearInterval(minuterie);
    };
  }, [etat, verrouiller]);

  async function deverrouiller() {
    if (occupe || code.length < 4) return;
    setOccupe(true);
    setErreur('');
    const { data, error } = await supabase.rpc('verifier_code_caisse', { p_org: org, p_code: code });
    if (error) {
      // Sans réseau : comparaison avec l'empreinte locale.
      const l = lireLocal(org, uid);
      const e = await empreinteLocale(uid, code);
      setOccupe(false);
      if (l?.empreinte && e && e === l.empreinte) {
        derniereActivite.current = Date.now();
        setCode('');
        setEtat('ouvert');
      } else {
        setCode('');
        setErreur(l?.empreinte ? 'Code incorrect.' : 'Pas de réseau : ce code n’a jamais été utilisé sur cet appareil.');
      }
      return;
    }
    const r = data as { ok: boolean; essais_restants?: number; bloque_jusqu?: string | null; sans_code?: boolean };
    setOccupe(false);
    if (r.sans_code) {
      setCode('');
      setEtat('creer');
      return;
    }
    if (r.ok) {
      const e = await empreinteLocale(uid, code);
      ecrireLocal(org, uid, { defini: true, empreinte: e ?? undefined });
      derniereActivite.current = Date.now();
      setCode('');
      setEtat('ouvert');
      return;
    }
    setCode('');
    setErreur(
      r.bloque_jusqu
        ? `Trop d’essais : code bloqué jusqu’à ${new Date(r.bloque_jusqu).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`
        : `Code incorrect. ${r.essais_restants ?? 0} essai${(r.essais_restants ?? 0) > 1 ? 's' : ''} restant${(r.essais_restants ?? 0) > 1 ? 's' : ''}.`,
    );
  }

  async function creer() {
    if (occupe) return;
    if (confirmation === null) {
      if (code.length < 4) return;
      setConfirmation(code);
      setCode('');
      return;
    }
    if (code !== confirmation) {
      setErreur('Les deux codes ne correspondent pas. Recommencez.');
      setConfirmation(null);
      setCode('');
      return;
    }
    setOccupe(true);
    const { error } = await supabase.rpc('definir_code_caisse', { p_org: org, p_code: code });
    setOccupe(false);
    if (error) {
      setErreur(messageErreur(error));
      setConfirmation(null);
      setCode('');
      return;
    }
    const e = await empreinteLocale(uid, code);
    ecrireLocal(org, uid, { defini: true, empreinte: e ?? undefined });
    setCode('');
    setConfirmation(null);
    setErreur('');
    derniereActivite.current = Date.now();
    setEtat('ouvert');
  }

  // Clavier du PC : chiffres, Retour arrière et Entrée fonctionnent sans cliquer dans un champ.
  useEffect(() => {
    if (etat !== 'creer' && etat !== 'verrouille') return;
    const touche = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.classList?.contains('pin-cache')) return;
      if (/^[0-9]$/.test(e.key)) setCode((c) => (c.length < 6 ? c + e.key : c));
      else if (e.key === 'Backspace') setCode((c) => c.slice(0, -1));
      else if (e.key === 'Enter') document.getElementById('valider-pin')?.click();
    };
    window.addEventListener('keydown', touche);
    return () => window.removeEventListener('keydown', touche);
  }, [etat]);

  if (etat === 'ouvert') {
    return (
      <>
        {children}
        <button type="button" className="bouton-verrou" onClick={verrouiller} title="Verrouiller la caisse" aria-label="Verrouiller la caisse">
          🔒
        </button>
      </>
    );
  }
  if (etat === 'chargement') return <div className="chargement">Chargement de la caisse…</div>;

  const creation = etat === 'creer';
  return (
    <div className="ecran-verrou">
      <div className="carte-verrou">
        <div className="verrou-avatar" aria-hidden>
          {nom.trim().charAt(0).toUpperCase() || '🔒'}
        </div>
        {creation && (
          <div className="etapes-pin" aria-label={`Étape ${confirmation === null ? 1 : 2} sur 2`}>
            <span className={confirmation === null ? 'actif' : 'fait'}>1 · Choisir</span>
            <span className={confirmation === null ? '' : 'actif'}>2 · Confirmer</span>
          </div>
        )}
        <h1>{creation ? (confirmation === null ? 'Choisissez votre code de caisse' : 'Retapez le même code') : 'Caisse verrouillée'}</h1>
        <p className="secondaire">
          {creation
            ? confirmation === null
              ? 'Inventez 4 à 6 chiffres, rien qu’à vous. Ce code vous sera demandé pour ouvrir la caisse et après 5 minutes sans activité.'
              : 'Pour être sûr qu’il n’y a pas d’erreur, tapez exactement le même code.'
            : `${nom} — tapez votre code personnel de caisse.`}
        </p>
        {creation && confirmation === null && (
          <p className="conseil-pin">N’utilisez ni votre code Mobile Money, ni celui de votre carte, ni votre date de naissance.</p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void (creation ? creer() : deverrouiller());
          }}
        >
          <Points code={code} visible={voir} />
          <p className="aide-pin">
            {code.length < 4 ? `Encore ${4 - code.length} chiffre${4 - code.length > 1 ? 's' : ''} au minimum` : code.length < 6 ? 'Vous pouvez valider (ou ajouter jusqu’à 6 chiffres)' : 'Code complet : validez'}
            <button type="button" className="bouton-lien voir-pin" onClick={() => setVoir(!voir)}>
              {voir ? '🙈 Masquer' : '👁 Voir'}
            </button>
          </p>
          <input
            className="pin-cache"
            inputMode="numeric"
            autoComplete="off"
            autoFocus={!('ontouchstart' in window)}
            value={code}
            maxLength={6}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            aria-label="Code de caisse"
          />
          {erreur && <p className="texte-negatif" role="alert">{erreur}</p>}
          <Clavier valeur={code} onChange={setCode} onValider={() => void (creation ? creer() : deverrouiller())} />
          <button id="valider-pin" type="submit" hidden aria-hidden tabIndex={-1} />
        </form>
        {creation && confirmation !== null && (
          <button type="button" className="bouton-lien petit" onClick={() => { setConfirmation(null); setCode(''); setErreur(''); }}>
            ← Changer de code
          </button>
        )}
        {!creation && <p className="secondaire petit">Code oublié ? Votre gérant le réinitialise dans Utilisateurs → votre fiche → « Code caisse ».</p>}
      </div>
    </div>
  );
}
