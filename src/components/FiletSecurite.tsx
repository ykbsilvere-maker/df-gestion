import { Component, type ErrorInfo, type ReactNode } from 'react';
import { supabase } from '../lib/supabase';

/**
 * Filet de sécurité : une erreur dans un module n'efface plus toute l'application.
 * - niveau « page » : le menu et l'en-tête restent ; seul le module affiche un message
 *   avec « Réessayer » et « Accueil » (remis à zéro à chaque changement de page) ;
 * - niveau « application » : dernier rempart, avec « Recharger ».
 * L'erreur est signalée au serveur (sans données de vente) pour être corrigée.
 */
interface Props {
  niveau: 'page' | 'application';
  children: ReactNode;
}
interface Etat {
  erreur: Error | null;
}

const dejaSignale = new Set<string>();

export function signalerErreur(erreur: unknown, origine: string) {
  try {
    const e = erreur instanceof Error ? erreur : new Error(String(erreur));
    const cle = `${origine}|${e.message}`;
    if (dejaSignale.has(cle) || dejaSignale.size > 20) return;
    dejaSignale.add(cle);
    let org: string | null = null;
    try {
      org = localStorage.getItem('dfg_org');
    } catch {
      /* rien */
    }
    void supabase
      .rpc('signaler_erreur', {
        p_org: org,
        p_page: `${location.pathname}${location.search}`.slice(0, 200),
        p_message: `${origine} : ${e.message}`.slice(0, 500),
        p_pile: (e.stack ?? '').slice(0, 3000),
        p_version: __VERSION_APP__,
        p_appareil: navigator.userAgent.slice(0, 300),
      })
      .then(undefined, () => undefined);
  } catch {
    /* le signalement ne doit jamais aggraver la situation */
  }
}

export class FiletSecurite extends Component<Props, Etat> {
  state: Etat = { erreur: null };

  static getDerivedStateFromError(erreur: Error): Etat {
    return { erreur };
  }

  componentDidCatch(erreur: Error, info: ErrorInfo) {
    const e = new Error(erreur.message);
    e.stack = `${erreur.stack ?? ''}\n--- composants ---${info.componentStack ?? ''}`;
    signalerErreur(e, this.props.niveau);
  }

  render() {
    const { erreur } = this.state;
    if (!erreur) return this.props.children;
    const page = this.props.niveau === 'page';
    return (
      <div className={page ? 'filet-page' : 'filet-application'} role="alert">
        <div className="filet-carte">
          <span className="filet-icone" aria-hidden>
            🛠️
          </span>
          <h2>{page ? 'Ce module a rencontré un problème' : 'L’application a rencontré un problème'}</h2>
          <p className="secondaire">
            Vos données sont en sécurité : rien n’a été perdu. Le problème a été signalé automatiquement.
            {page ? ' Vous pouvez réessayer ou revenir à l’accueil.' : ' Rechargez pour reprendre.'}
          </p>
          <div className="filet-actions">
            {page && (
              <button type="button" className="bouton bouton-principal" onClick={() => this.setState({ erreur: null })}>
                Réessayer
              </button>
            )}
            {page && (
              <a className="bouton bouton-discret" href="/">
                Accueil
              </a>
            )}
            <button type="button" className={`bouton ${page ? 'bouton-discret' : 'bouton-principal'}`} onClick={() => location.reload()}>
              Recharger l’application
            </button>
          </div>
          <details className="filet-detail">
            <summary>Détail technique</summary>
            <code>{erreur.message}</code>
            <span className="secondaire">Version {__VERSION_APP__}</span>
          </details>
        </div>
      </div>
    );
  }
}
