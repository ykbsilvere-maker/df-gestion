/** Logo de l'éditeur, Le Décodeur Financier (pages publiques : connexion, configuration). */
export function MarqueDecodeur({ sousTitre }: { sousTitre?: string }) {
  return (
    <div className="marque-decodeur">
      <img src="/marque/logo-decodeur.png" alt="Le Décodeur Financier — Comprendre. Planifier. Prospérer." width={244} height={187} />
      {sousTitre && <span>{sousTitre}</span>}
    </div>
  );
}
