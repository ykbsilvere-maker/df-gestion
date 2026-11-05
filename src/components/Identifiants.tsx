import { useState } from 'react';

/** Message d'identifiants à transmettre (copie, WhatsApp). Le mot de passe n'est affiché qu'ici. */
export function Identifiants({ texte }: { texte: string }) {
  const [copie, setCopie] = useState(false);
  return (
    <div className="formulaire">
      <p>Envoyez ce message à la personne (WhatsApp, SMS). Le mot de passe n’est affiché qu’ici.</p>
      <pre className="message-identifiants">{texte}</pre>
      <div className="actions-ligne">
        <button
          type="button"
          className="bouton bouton-principal"
          onClick={() => void navigator.clipboard?.writeText(texte).then(() => setCopie(true))}
        >
          {copie ? 'Copié' : 'Copier le message'}
        </button>
        <a className="bouton bouton-discret" href={`https://wa.me/?text=${encodeURIComponent(texte)}`} target="_blank" rel="noreferrer">
          Envoyer par WhatsApp
        </a>
      </div>
    </div>
  );
}

