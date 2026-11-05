import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/session';
import { messageErreur } from '../lib/format';
import { montant, nombreMonnaie } from '../lib/argent';
import { quantite } from '../lib/stock';
import { MontantFort } from '../components/ui';

type Periode = 'jour' | 'semaine' | 'mois' | 'annee';
interface Donnees {
  periode: Periode;
  debut: string;
  ca: number;
  ca_precedent: number;
  tickets: number;
  tickets_precedent: number;
  panier_moyen: number;
  marge: number | null;
  serie: { debut: string; ca: number; tickets: number }[];
  paiements: { libelle: string; montant: number }[];
  top_produits: { designation: string; quantite: number; ca: number }[];
  dernieres_ventes: { numero: string; date_vente: string; total: number; client: string | null; caissier: string | null }[];
  alertes_stock: number;
  clients_creances: number | null;
  creances_echues: number | null;
}

const PERIODES: { code: Periode; libelle: string; precedent: string }[] = [
  { code: 'jour', libelle: 'Jour', precedent: 'hier à la même heure' },
  { code: 'semaine', libelle: 'Semaine', precedent: 'la semaine dernière à date' },
  { code: 'mois', libelle: 'Mois', precedent: 'le mois dernier à date' },
  { code: 'annee', libelle: 'Année', precedent: 'l’an dernier à date' },
];

// Palette des graphiques : teintes de la marque, lisibles en clair.
const COULEURS = ['#c8161b', '#1f8a65', '#b8862b', '#3b6fb6', '#7a4fb0', '#5f5f5f', '#d9822b', '#2a9d8f'];

function evolution(actuel: number, precedent: number): { texte: string; sens: 'hausse' | 'baisse' | 'stable' } {
  if (!precedent) return { texte: actuel ? 'nouveau' : '—', sens: 'stable' };
  const p = ((actuel - precedent) / precedent) * 100;
  if (Math.abs(p) < 0.5) return { texte: '= stable', sens: 'stable' };
  return { texte: `${p > 0 ? '+' : ''}${p.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`, sens: p > 0 ? 'hausse' : 'baisse' };
}

function libelleBarre(iso: string, p: Periode): string {
  const d = new Date(iso);
  if (p === 'jour') return `${d.getHours()}h`;
  if (p === 'annee') return d.toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '');
  if (p === 'semaine') return d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '');
  return String(d.getDate());
}

/** Abréviation des axes : 1 250 000 → « 1,25 M ». */
function court(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} k`;
  return nombreMonnaie(v);
}

function Histogramme({ serie, periode }: { serie: Donnees['serie']; periode: Periode }) {
  const [survol, setSurvol] = useState<number | null>(null);
  const max = Math.max(1, ...serie.map((s) => Number(s.ca)));
  const L = 640;
  const H = 210;
  const marge = { g: 44, b: 26, h: 10 };
  const largeurBarre = (L - marge.g) / Math.max(serie.length, 1);
  const pas = periode === 'mois' ? Math.ceil(serie.length / 10) : 1;
  const graduations = [0, 0.5, 1].map((f) => f * max);
  const actuelle = serie.findIndex((s) => new Date(s.debut) > new Date()) - 1;
  return (
    <div className="graphique">
      <svg viewBox={`0 0 ${L} ${H}`} role="img" aria-label="Chiffre d’affaires par période" onMouseLeave={() => setSurvol(null)}>
        {graduations.map((g) => {
          const y = marge.h + (H - marge.b - marge.h) * (1 - g / max);
          return (
            <g key={g}>
              <line x1={marge.g} x2={L} y1={y} y2={y} className="graphique-grille" />
              <text x={marge.g - 6} y={y + 4} textAnchor="end" className="graphique-axe">
                {court(g)}
              </text>
            </g>
          );
        })}
        {serie.map((s, i) => {
          const h = ((H - marge.b - marge.h) * Number(s.ca)) / max;
          const x = marge.g + i * largeurBarre + largeurBarre * 0.15;
          return (
            <g key={s.debut} onMouseEnter={() => setSurvol(i)} onClick={() => setSurvol(i)}>
              <rect x={marge.g + i * largeurBarre} y={marge.h} width={largeurBarre} height={H - marge.b - marge.h} fill="transparent" />
              <rect
                x={x}
                y={H - marge.b - h}
                width={largeurBarre * 0.7}
                height={Math.max(h, Number(s.ca) > 0 ? 2 : 0)}
                rx={Math.min(4, largeurBarre * 0.2)}
                className={`graphique-barre ${i === actuelle ? 'graphique-barre-actuelle' : ''} ${survol === i ? 'graphique-barre-survol' : ''}`}
              />
              {i % pas === 0 && (
                <text x={x + largeurBarre * 0.35} y={H - 8} textAnchor="middle" className="graphique-axe">
                  {libelleBarre(s.debut, periode)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className="graphique-info">
        {survol !== null && serie[survol] ? (
          <>
            <strong>{montant(serie[survol]!.ca)}</strong> · {serie[survol]!.tickets} ticket{serie[survol]!.tickets > 1 ? 's' : ''} ·{' '}
            {new Date(serie[survol]!.debut).toLocaleString('fr-FR', periode === 'jour' ? { hour: '2-digit', minute: '2-digit' } : periode === 'annee' ? { month: 'long', year: 'numeric' } : { weekday: 'long', day: 'numeric', month: 'long' })}
          </>
        ) : (
          <span className="secondaire">Touchez une barre pour voir le détail.</span>
        )}
      </div>
    </div>
  );
}

function Anneau({ parts }: { parts: { libelle: string; montant: number }[] }) {
  const total = parts.reduce((t, p) => t + Number(p.montant), 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  let cumul = 0;
  return (
    <div className="anneau">
      <svg viewBox="0 0 140 140" role="img" aria-label="Répartition par moyen de paiement">
        <circle cx="70" cy="70" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="20" />
        {total > 0 &&
          parts.map((p, i) => {
            const part = Number(p.montant) / total;
            const el = (
              <circle
                key={p.libelle}
                cx="70"
                cy="70"
                r={R}
                fill="none"
                stroke={COULEURS[i % COULEURS.length]}
                strokeWidth="20"
                strokeDasharray={`${Math.max(part * C - 1.5, 0)} ${C}`}
                strokeDashoffset={-cumul * C}
                transform="rotate(-90 70 70)"
              />
            );
            cumul += part;
            return el;
          })}
        <text x="70" y="66" textAnchor="middle" className="anneau-chiffre">
          {parts.length}
        </text>
        <text x="70" y="84" textAnchor="middle" className="anneau-legende">
          moyen{parts.length > 1 ? 's' : ''}
        </text>
      </svg>
      <ul className="legende">
        {parts.map((p, i) => (
          <li key={p.libelle}>
            <span className="legende-pastille" style={{ background: COULEURS[i % COULEURS.length] }} />
            <span>{p.libelle}</span>
            <strong>{total ? Math.round((100 * Number(p.montant)) / total) : 0} %</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TableauDeBord() {
  const { organisation, peut } = useSession();
  const org = organisation!.organisation_id;
  const [periode, setPeriode] = useState<Periode>(() => {
    try {
      return (localStorage.getItem('dfg-periode-tdb') as Periode) || 'mois';
    } catch {
      return 'mois';
    }
  });
  const [d, setD] = useState<Donnees | null>(null);
  const [erreur, setErreur] = useState('');

  useEffect(() => {
    try {
      localStorage.setItem('dfg-periode-tdb', periode);
    } catch {
      /* stockage indisponible */
    }
    let actif = true;
    void supabase.rpc('tableau_de_bord', { p_org: org, p_periode: periode }).then(({ data, error }) => {
      if (!actif) return;
      if (error) setErreur(messageErreur(error));
      else {
        setErreur('');
        setD(data as Donnees);
      }
    });
    return () => {
      actif = false;
    };
  }, [org, periode]);

  const p = PERIODES.find((x) => x.code === periode)!;
  const evoCa = d ? evolution(Number(d.ca), Number(d.ca_precedent)) : null;
  const evoTk = d ? evolution(Number(d.tickets), Number(d.tickets_precedent)) : null;
  const maxTop = Math.max(1, ...(d?.top_produits ?? []).map((t) => Number(t.ca)));

  return (
    <section className="tdb">
      <div className="tdb-entete">
        <h2>Tableau de bord</h2>
        <div className="segments" role="tablist" aria-label="Périodicité">
          {PERIODES.map((x) => (
            <button key={x.code} type="button" role="tab" aria-selected={periode === x.code} className={periode === x.code ? 'actif' : ''} onClick={() => setPeriode(x.code)}>
              {x.libelle}
            </button>
          ))}
        </div>
      </div>
      {erreur && <p className="texte-negatif">{erreur}</p>}
      {d && (
        <>
          <div className="tdb-tuiles">
            <div className="kpi">
              <span className="kpi-icone" aria-hidden>💰</span>
              <span className="kpi-libelle">Chiffre d’affaires</span>
              <span className="kpi-valeur"><MontantFort v={d.ca} /></span>
              <span className={`kpi-evolution kpi-${evoCa!.sens}`}>{evoCa!.texte} <span className="secondaire">vs {p.precedent}</span></span>
            </div>
            <div className="kpi">
              <span className="kpi-icone" aria-hidden>🧾</span>
              <span className="kpi-libelle">Tickets</span>
              <span className="kpi-valeur">{Number(d.tickets).toLocaleString('fr-FR')}</span>
              <span className={`kpi-evolution kpi-${evoTk!.sens}`}>{evoTk!.texte}</span>
            </div>
            <div className="kpi">
              <span className="kpi-icone" aria-hidden>🛍️</span>
              <span className="kpi-libelle">Panier moyen</span>
              <span className="kpi-valeur"><MontantFort v={d.panier_moyen} /></span>
              {d.marge !== null && (
                <span className="kpi-evolution kpi-stable">
                  Marge <strong>{montant(d.marge)}</strong>
                  {Number(d.ca) > 0 && ` (${Math.round((100 * Number(d.marge)) / Number(d.ca))} %)`}
                </span>
              )}
            </div>
            <Link to="/stock/alertes" className={`kpi kpi-lien ${d.alertes_stock > 0 ? 'kpi-alerte' : ''}`}>
              <span className="kpi-icone" aria-hidden>📦</span>
              <span className="kpi-libelle">Stock faible ou en rupture</span>
              <span className="kpi-valeur">{d.alertes_stock}</span>
              <span className="kpi-evolution">Voir les alertes →</span>
            </Link>
            {d.creances_echues !== null && (
              <Link to="/tresorerie/creances" className={`kpi kpi-lien ${Number(d.creances_echues) > 0 ? 'kpi-alerte' : ''}`}>
                <span className="kpi-icone" aria-hidden>📨</span>
                <span className="kpi-libelle">Créances échues</span>
                <span className="kpi-valeur"><MontantFort v={d.creances_echues} /></span>
                <span className="kpi-evolution">{d.clients_creances} client{Number(d.clients_creances) > 1 ? 's' : ''} débiteur{Number(d.clients_creances) > 1 ? 's' : ''} →</span>
              </Link>
            )}
          </div>

          <div className="tdb-grille">
            <div className="carte tdb-carte-large">
              <div className="tdb-carte-tete">
                <h3>Chiffre d’affaires</h3>
                {(peut('rapports.consulter') || peut('ventes.exporter')) && (
                  <Link to="/rapports/ventes" className="bouton bouton-discret bouton-petit">
                    Voir plus
                  </Link>
                )}
              </div>
              <Histogramme serie={d.serie} periode={periode} />
            </div>
            <div className="carte">
              <h3>Paiements</h3>
              {d.paiements.length ? <Anneau parts={d.paiements} /> : <p className="secondaire">Aucune vente sur la période.</p>}
            </div>
            <div className="carte">
              <h3>Produits les plus vendus</h3>
              {d.top_produits.length === 0 ? (
                <p className="secondaire">Aucune vente sur la période.</p>
              ) : (
                <ul className="classement">
                  {d.top_produits.map((t) => (
                    <li key={t.designation}>
                      <div className="classement-tete">
                        <span>{t.designation}</span>
                        <strong className="montant-bloc">{montant(t.ca)}</strong>
                      </div>
                      <div className="classement-barre">
                        <span style={{ width: `${(100 * Number(t.ca)) / maxTop}%` }} />
                      </div>
                      <span className="secondaire">{quantite(t.quantite)} vendus</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="carte">
              <div className="tdb-carte-tete">
                <h3>Dernières ventes</h3>
              </div>
              {d.dernieres_ventes.length === 0 ? (
                <p className="secondaire">Aucune vente sur la période.</p>
              ) : (
                <ul className="dernieres">
                  {d.dernieres_ventes.map((v) => (
                    <li key={v.numero}>
                      <span className="dernieres-avatar" aria-hidden>
                        {(v.client ?? v.caissier ?? '?').trim().charAt(0).toUpperCase()}
                      </span>
                      <span className="dernieres-texte">
                        <strong>{v.client || v.numero}</strong>
                        <span className="secondaire">
                          {v.numero} · {v.caissier ?? '—'}
                        </span>
                      </span>
                      <span className="dernieres-droite">
                        <strong className="montant-bloc">{montant(v.total)}</strong>
                        <span className="secondaire">{new Date(v.date_vente).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
