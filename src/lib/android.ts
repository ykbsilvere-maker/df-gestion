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
}

declare global {
  interface Window {
    DFGAndroid?: PontAndroid;
  }
}

export const pontAndroid = (): PontAndroid | undefined => window.DFGAndroid;
export const estApplicationAndroid = () => !!window.DFGAndroid;
