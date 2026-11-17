/** Icônes au trait (24 × 24), dessinées pour DF Marché. */
const base = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

export const IcoAccueil = () => (<svg {...base} aria-hidden><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" /></svg>);
export const IcoRayons = () => (<svg {...base} aria-hidden><rect x="3" y="3" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="2" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="2" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2" /></svg>);
export const IcoPanier = () => (<svg {...base} aria-hidden><path d="M3 4h2l2.2 11.2a2 2 0 0 0 2 1.6h7.9a2 2 0 0 0 2-1.5L21 8H6" /><circle cx="10" cy="20.5" r="1.2" /><circle cx="17" cy="20.5" r="1.2" /></svg>);
export const IcoCoeur = ({ plein }: { plein?: boolean }) => (<svg {...base} fill={plein ? 'currentColor' : 'none'} aria-hidden><path d="M12 20.5s-7.5-4.4-9.2-9.3C1.7 7.9 3.9 4.5 7.3 4.5c2 0 3.5 1.1 4.7 2.8 1.2-1.7 2.7-2.8 4.7-2.8 3.4 0 5.6 3.4 4.5 6.7-1.7 4.9-9.2 9.3-9.2 9.3Z" /></svg>);
export const IcoCommandes = () => (<svg {...base} aria-hidden><path d="M6 3h12a1 1 0 0 1 1 1v17l-3-2-3 2-3-2-3 2-2-1.3V4a1 1 0 0 1 1-1Z" /><path d="M9 8h6M9 12h6" /></svg>);
export const IcoRecherche = () => (<svg {...base} aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>);
export const IcoRetour = () => (<svg {...base} aria-hidden><path d="M15 5l-7 7 7 7" /></svg>);
export const IcoPlus = () => (<svg {...base} strokeWidth={2.4} aria-hidden><path d="M12 5v14M5 12h14" /></svg>);
export const IcoMoins = () => (<svg {...base} strokeWidth={2.4} aria-hidden><path d="M5 12h14" /></svg>);
export const IcoBoutique = () => (<svg {...base} aria-hidden><path d="M4 9.5 5.5 4h13L20 9.5" /><path d="M4 9.5a2.7 2.7 0 0 0 5.3 0 2.7 2.7 0 0 0 5.4 0 2.7 2.7 0 0 0 5.3 0" /><path d="M5 11.5V20h14v-8.5" /><path d="M10 20v-5h4v5" /></svg>);
export const IcoFlamme = () => (<svg {...base} aria-hidden><path d="M12 21c4 0 7-2.8 7-6.8 0-3.6-2.4-6-4.3-8.2-.4 2.2-1.4 3.4-2.7 4-0.2-3.3-1.7-5.8-4-7.5.2 3.4-3 5.8-3 10.6C5 18.6 8 21 12 21Z" /></svg>);
export const IcoSuivi = () => (<svg {...base} aria-hidden><path d="M3 7h11v10H3z" /><path d="M14 10h4l3 3v4h-7" /><circle cx="7" cy="18.5" r="1.7" /><circle cx="17.5" cy="18.5" r="1.7" /></svg>);
export const IcoRecommander = () => (<svg {...base} aria-hidden><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v4.5h-4.5" /></svg>);
export const IcoWhatsapp = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden fill="currentColor">
    <path d="M12 2a9.9 9.9 0 0 0-8.5 15l-1.4 5 5.1-1.3A10 10 0 1 0 12 2Zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.4.1-.2 0-.3 0-.5l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3Z" />
  </svg>
);
export const IcoPosition = () => (<svg {...base} aria-hidden><path d="M12 21s-7-6.1-7-11.5A7 7 0 0 1 19 9.5C19 14.9 12 21 12 21Z" /><circle cx="12" cy="9.5" r="2.5" /></svg>);
export const IcoTelephone = () => (<svg {...base} aria-hidden><path d="M5 3h3l2 5-2.5 1.5a11 11 0 0 0 7 7L16 14l5 2v3a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2Z" /></svg>);
export const IcoPartager = () => (<svg {...base} aria-hidden><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4" /></svg>);
export const IcoFleche = () => (<svg {...base} aria-hidden><path d="M9 5l7 7-7 7" /></svg>);
export const IcoFermer = () => (<svg {...base} aria-hidden><path d="M6 6l12 12M18 6 6 18" /></svg>);
export const IcoCompte = () => (<svg {...base} aria-hidden><circle cx="12" cy="8" r="4" /><path d="M4 21c.8-4 4-6 8-6s7.2 2 8 6" /></svg>);
