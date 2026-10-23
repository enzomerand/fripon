import type { ComponentChildren } from 'preact';

/** Links to Google open in a new tab, so the options page (and the key being pasted) stays put. */
function Ext({ href, children }: { href: string; children: ComponentChildren }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

function Steps({ children }: { children: ComponentChildren }) {
  return <ol class="steps">{children}</ol>;
}

export interface GuideSectionProps {
  geminiOpen: boolean;
  visionOpen: boolean;
  onGeminiToggle: (open: boolean) => void;
  onVisionToggle: (open: boolean) => void;
}

export function GuideSection({
  geminiOpen,
  visionOpen,
  onGeminiToggle,
  onVisionToggle,
}: GuideSectionProps) {
  return (
    <section class="card" id="guide" aria-labelledby="guide-title">
      <h2 id="guide-title">Guide pas à pas</h2>
      <p class="callout callout--warn" role="note">
        <strong>Important :</strong> utilise un projet Google différent pour Gemini et pour Vision.
        Dès qu'un projet a la facturation activée (c'est obligatoire pour Vision), Gemini y passe en
        offre payante. La clé Gemini doit donc venir d'un projet sans facturation.
      </p>

      <details
        class="guide"
        open={geminiOpen}
        onToggle={(event) => onGeminiToggle(event.currentTarget.open)}
      >
        <summary>Gemini : gratuit, sans carte bancaire</summary>
        <Steps>
          <li>
            Ouvre <Ext href="https://aistudio.google.com/apikey">Google AI Studio</Ext>.
          </li>
          <li>Connecte-toi avec un compte Google.</li>
          <li>Clique sur « Create API key ».</li>
          <li>Copie la clé : elle commence par « AIza ».</li>
          <li>
            Colle-la plus haut, dans le champ « Analyse IA — Gemini », puis clique sur « Tester ».
          </li>
        </Steps>
      </details>

      <details
        class="guide"
        open={visionOpen}
        onToggle={(event) => onVisionToggle(event.currentTarget.open)}
      >
        <summary>
          Google Cloud Vision : carte bancaire demandée, 1 000 recherches gratuites par mois
        </summary>
        <p class="muted">
          Google demande une carte bancaire pour activer Vision, même dans la limite gratuite. Les 1
          000 premières recherches de chaque mois ne coûtent rien, et Fripon s'arrête à 1 000 par
          défaut.
        </p>
        <Steps>
          <li>
            Crée un projet sur{' '}
            <Ext href="https://console.cloud.google.com/projectcreate">Google Cloud</Ext> et
            appelle-le « Fripon Vision ».
          </li>
          <li>
            Associe-lui un compte de{' '}
            <Ext href="https://console.cloud.google.com/billing">facturation</Ext> (c'est ici que la
            carte bancaire est demandée).
          </li>
          <li>
            Active l'API sur la page{' '}
            <Ext href="https://console.cloud.google.com/apis/library/vision.googleapis.com">
              Cloud Vision API
            </Ext>{' '}
            avec le bouton « Activer ».
          </li>
          <li>
            Ouvre la page des{' '}
            <Ext href="https://console.cloud.google.com/apis/credentials">identifiants</Ext>, puis «
            Créer des identifiants » et « Clé API ».
          </li>
          <li>
            Restreins la clé : dans « Restrictions relatives aux API », choisis « Cloud Vision API
            ». Ne mets pas de restriction de site web, Fripon ne pourrait plus s'en servir.
          </li>
          <li>
            Colle la clé plus haut, dans le champ « Recherche d'image — Google Cloud Vision », puis
            clique sur « Tester ».
          </li>
        </Steps>
      </details>
    </section>
  );
}
