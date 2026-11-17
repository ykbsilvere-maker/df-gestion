/**
 * Pont vers l'application Android (APK) : impression par le service d'impression
 * d'Android et enregistrement de fichiers dans « Téléchargements ».
 * Dans un navigateur, ces fonctions n'existent pas et l'application utilise
 * les mécanismes du navigateur.
 */
interface PontAndroid {
  imprimer: (titre: string) => void;
  enregistrer: (nom: string, type: string, contenu: string) => string;
  /** Depuis la v0.8 : fichier binaire (xlsx) transmis en base64. */
  enregistrerBase64?: (nom: string, type: string, base64: string) => string;
  version?: () => string;
  /** Depuis la v3.9 : notification du téléphone (nombre ≤ 0 l'efface). */
  notifier?: (titre: string, texte: string, nombre: number) => void;
  /** Depuis la v3.10 : vérification des commandes toutes les 15 minutes, application fermée. */
  veilleCommandes?: (url: string, cle: string, jeton: string) => void;
  /** Depuis la v3.10 : arrête la vérification (déconnexion). */
  arreterVeille?: () => void;
}

declare global {
  interface Window {
    DFGAndroid?: PontAndroid;
  }
}

export const pontAndroid = (): PontAndroid | undefined => window.DFGAndroid;
export const estApplicationAndroid = () => !!window.DFGAndroid;
