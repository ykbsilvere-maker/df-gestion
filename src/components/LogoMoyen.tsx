import orangeMoney from '../assets/moyens/orange_money.webp';
import wave from '../assets/moyens/wave.webp';
import mtnMomo from '../assets/moyens/mtn_momo.webp';
import moovMoney from '../assets/moyens/moov_money.webp';
import carte from '../assets/moyens/carte.webp';
import virement from '../assets/moyens/virement.webp';
import especes from '../assets/moyens/especes.webp';

const EMOJIS: Record<string, string> = { especes: '💵', mobile: '📱', carte: '💳', virement: '🏦', cheque: '📝', autre: '🔹' };

/** Image du moyen de règlement : réseau reconnu par son code ou son libellé, sinon par sa nature. */
export function imageMoyen(m: { nature: string; code?: string | null; libelle?: string | null }): string | null {
  const t = `${m.code ?? ''} ${m.libelle ?? ''}`.toLowerCase();
  if (/wave/.test(t)) return wave;
  if (/orange/.test(t)) return orangeMoney;
  if (/mtn|momo/.test(t)) return mtnMomo;
  if (/moov|flooz/.test(t)) return moovMoney;
  if (m.nature === 'especes') return especes;
  if (m.nature === 'carte') return carte;
  if (m.nature === 'virement') return virement;
  return null;
}

/** Logo (ou émoji à défaut) affiché devant le nom d'un moyen de règlement. Décoratif. */
export function LogoMoyen({ moyen, grand }: { moyen: { nature: string; code?: string | null; libelle?: string | null }; grand?: boolean }) {
  const src = imageMoyen(moyen);
  if (!src)
    return (
      <span className="ico" aria-hidden>
        {EMOJIS[moyen.nature] ?? '🔹'}
      </span>
    );
  return <img className={`logo-moyen${grand ? ' grand' : ''}`} src={src} alt="" aria-hidden />;
}
