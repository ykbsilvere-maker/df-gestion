import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { appeler, type BonAchat, type CommandeCompte } from './api';
import { useCompte } from './compte';
import { mesCommandes } from './panier';

/* ------------------------------------------------------------------------------------------
 * Alertes du client : un nouveau bon d'achat, une commande confirmée, prête, en route, remise…
 * Une fenêtre bien visible apparaît (son discret, vibration), avec un bouton pour voir.
 * Ce qui a déjà été montré est mémorisé sur le téléphone.
 * ---------------------------------------------------------------------------------------- */

interface Alerte {
  id: string;
  icone: string;
  titre: string;
  texte: string;
  vers: string;
  bouton: string;
  ton: 'or' | 'vert' | 'bleu' | 'rouge';
}

const CLE = 'dfm_alertes_vues';
type Vus = { bons: string[]; statuts: Record<string, string>; init: boolean };
function lireVus(): Vus {
  try {
    return { bons: [], statuts: {}, init: false, ...(JSON.parse(localStorage.getItem(CLE) ?? '{}') as Partial<Vus>) };
  } catch {
    return { bons: [], statuts: {}, init: false };
  }
}
function ecrireVus(v: Vus) {
  try {
    localStorage.setItem(CLE, JSON.stringify(v));
  } catch {
    /* stockage indisponible */
  }
}

const STATUTS: Record<string, { icone: string; texte: (n: string, b: string) => string; ton: Alerte['ton'] }> = {
  confirmee: { icone: '👍', texte: (n, b) => `${b} a confirmé votre commande ${n}.`, ton: 'vert' },
  prete: { icone: '📦', texte: (n, b) => `Votre commande ${n} est prête chez ${b}.`, ton: 'vert' },
  en_livraison: { icone: '🛵', texte: (n) => `Votre commande ${n} est en route : le livreur vous appelle bientôt.`, ton: 'bleu' },
  livree: { icone: '🎉', texte: (n) => `Commande ${n} remise. Merci ! Votre reçu est disponible.`, ton: 'vert' },
  annulee: { icone: '⚠️', texte: (n, b) => `${b} a annulé la commande ${n}. Ouvrez le suivi pour le motif.`, ton: 'rouge' },
};

const remiseBon = (b: BonAchat) => (b.type === 'pourcent' ? `−${b.valeur} %` : `−${Number(b.valeur).toLocaleString('fr-FR')} FCFA`);

function son() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    [784, 1175].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = f;
      const t = ctx.currentTime + i * 0.14;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.32);
    });
    window.setTimeout(() => void ctx.close(), 1000);
  } catch {
    /* son indisponible */
  }
}

export function AlertesClient() {
  const { session, pret } = useCompte();
  const [alertes, setAlertes] = useState<Alerte[]>([]);
  const enCours = useRef(false);
  const { pathname } = useLocation();

  const verifier = useCallback(async () => {
    if (!pret || enCours.current) return;
    enCours.current = true;
    try {
      const vus = lireVus();
      const nouvelles: Alerte[] = [];
      // 1. Bons d'achat (compte connecté)
      if (session) {
        const bons = await appeler<BonAchat[]>('mes_bons_marche').catch(() => [] as BonAchat[]);
        const inedits = bons.filter((b) => !vus.bons.includes(b.code));
        if (inedits.length === 1) {
          const b = inedits[0]!;
          nouvelles.push({
            id: `bon-${b.code}`, icone: '🎁', ton: 'or', vers: '/compte/bons', bouton: 'Voir mon bon',
            titre: b.personnel ? 'Un bon rien que pour vous !' : 'Nouveau bon d’achat',
            texte: `${remiseBon(b)}${b.boutique ? ` chez ${b.boutique.nom}` : ''} avec le code ${b.code}${b.fin ? `, jusqu’au ${new Date(b.fin).toLocaleDateString('fr-FR')}` : ''}.`,
          });
        } else if (inedits.length > 1) {
          nouvelles.push({
            id: 'bons', icone: '🎁', ton: 'or', vers: '/compte/bons', bouton: 'Voir mes bons',
            titre: `${inedits.length} nouveaux bons d’achat`, texte: 'Des réductions vous attendent : touchez pour les voir.',
          });
        }
        vus.bons = [...new Set([...vus.bons, ...inedits.map((b) => b.code)])].slice(-100);
      }
      // 2. Suivi des commandes (compte + commandes passées sur ce téléphone)
      const liste: { code: string; numero: string; boutique: string; statut: string }[] = [];
      if (session) {
        const cmds = await appeler<CommandeCompte[]>('mes_commandes_marche').catch(() => [] as CommandeCompte[]);
        cmds.slice(0, 15).forEach((c) => liste.push({ code: c.code, numero: c.numero, boutique: c.boutique, statut: c.statut }));
      }
      const locales = mesCommandes().filter((c) => !liste.some((x) => x.code === c.code)).slice(0, 4);
      for (const c of locales) {
        if (vus.statuts[c.code] === 'livree' || vus.statuts[c.code] === 'annulee') continue;
        const s = await appeler<{ statut: string; numero: string; boutique: { nom: string } }>('marche_suivi', { p_code: c.code }).catch(() => null);
        if (s) liste.push({ code: c.code, numero: s.numero, boutique: s.boutique?.nom ?? c.boutique, statut: s.statut });
      }
      for (const c of liste) {
        const avant = vus.statuts[c.code];
        if (vus.init && avant && avant !== c.statut && STATUTS[c.statut]) {
          const d = STATUTS[c.statut]!;
          nouvelles.push({
            id: `cmd-${c.code}-${c.statut}`, icone: d.icone, ton: d.ton, vers: `/suivi/${c.code}`, bouton: 'Suivre',
            titre: `Commande ${c.numero}`, texte: d.texte(c.numero, c.boutique),
          });
        }
        vus.statuts[c.code] = c.statut;
      }
      vus.init = true;
      ecrireVus(vus);
      if (nouvelles.length) {
        setAlertes((a) => [...nouvelles.filter((n) => !a.some((x) => x.id === n.id)), ...a].slice(0, 3));
        son();
        navigator.vibrate?.([120, 80, 120]);
        try {
          if (document.hidden && 'Notification' in window && Notification.permission === 'granted')
            nouvelles.forEach((n) => new Notification(`${n.icone} ${n.titre}`, { body: n.texte, icon: '/icone-marche.svg' }));
        } catch {
          /* rien */
        }
      }
    } finally {
      enCours.current = false;
    }
  }, [session, pret]);

  useEffect(() => {
    void verifier();
    const id = window.setInterval(() => void verifier(), 45000);
    const retour = () => document.visibilityState === 'visible' && void verifier();
    document.addEventListener('visibilitychange', retour);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', retour);
    };
  }, [verifier]);

  // Sur la page concernée, l'alerte n'a plus besoin de rester affichée.
  useEffect(() => {
    setAlertes((a) => a.filter((x) => x.vers !== pathname));
  }, [pathname]);

  if (!alertes.length) return null;
  return (
    <div className="alertes-client" aria-live="polite">
      {alertes.map((a) => (
        <div key={a.id} className={`alerte-client ton-${a.ton}`} role="status">
          <span className="alerte-client-icone" aria-hidden>{a.icone}</span>
          <div className="alerte-client-texte">
            <strong>{a.titre}</strong>
            <span>{a.texte}</span>
          </div>
          <div className="alerte-client-actions">
            <Link to={a.vers} className="alerte-client-voir" onClick={() => setAlertes((x) => x.filter((y) => y.id !== a.id))}>{a.bouton}</Link>
            <button type="button" aria-label="Fermer" onClick={() => setAlertes((x) => x.filter((y) => y.id !== a.id))}>✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}
