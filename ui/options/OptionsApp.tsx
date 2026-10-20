import { useEffect, useState } from 'preact/hooks';
import { CreditsSection } from './CreditsSection';
import { GuideSection } from './GuideSection';
import { KeysSection } from './KeysSection';
import { ModeSection } from './ModeSection';
import { WelcomeBanner } from './WelcomeBanner';
import { useStored } from './useStored';
import { PROVIDERS } from '../../lib/settings';

const REPO_URL = 'https://github.com/enzomerand/fripon';
const SECTION_IDS = ['welcome', 'mode', 'keys', 'credits', 'guide'] as const;

function hashSection(): string {
  return location.hash.replace(/^#/, '');
}

function scrollToSection(id: string, smooth: boolean) {
  const target = document.getElementById(id);
  if (!target) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  target.scrollIntoView?.({ behavior: smooth && !reduced ? 'smooth' : 'auto', block: 'start' });
}

export function OptionsApp() {
  const { stored, failed, reload } = useStored();
  // The page can be opened straight on a section (`options.html#guide`).
  const [startsAtGuide] = useState(() => hashSection() === 'guide');
  const [welcomeAsked] = useState(() => hashSection() === 'welcome');
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const [geminiOpen, setGeminiOpen] = useState(startsAtGuide);
  const [visionOpen, setVisionOpen] = useState(startsAtGuide);
  const loaded = stored !== null;

  function openGuide() {
    setGeminiOpen(true);
    setVisionOpen(true);
    history.replaceState(null, '', '#guide');
    scrollToSection('guide', true);
  }

  // Land on the requested section once the content exists, and follow later `#section` links.
  useEffect(() => {
    if (!loaded) return;
    const id = hashSection();
    if (SECTION_IDS.includes(id as (typeof SECTION_IDS)[number])) scrollToSection(id, false);
  }, [loaded]);

  useEffect(() => {
    const onHashChange = () => {
      const id = hashSection();
      if (id === 'guide') {
        setGeminiOpen(true);
        setVisionOpen(true);
      }
      if (SECTION_IDS.includes(id as (typeof SECTION_IDS)[number])) scrollToSection(id, true);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const hasKey = stored
    ? PROVIDERS.some((provider) => stored.settings.keys[provider] !== '')
    : true;
  const showWelcome = loaded && !welcomeDismissed && (welcomeAsked || !hasKey);

  return (
    <div class="page">
      <header class="header">
        <h1>
          <span aria-hidden="true">🦊</span> Fripon
        </h1>
        <p class="header__subtitle">Réglages</p>
      </header>

      <main>
        {failed && (
          <p class="status status--bad" role="alert">
            Impossible de lire tes réglages. Recharge la page.
          </p>
        )}
        {stored && (
          <>
            {showWelcome && (
              <WelcomeBanner
                onFollowGuide={openGuide}
                onDismiss={() => setWelcomeDismissed(true)}
              />
            )}
            <ModeSection settings={stored.settings} onSaved={() => void reload()} />
            <KeysSection settings={stored.settings} onSaved={() => void reload()} />
            <CreditsSection usage={stored.usage} now={stored.now} onSaved={() => void reload()} />
            <GuideSection
              geminiOpen={geminiOpen}
              visionOpen={visionOpen}
              onGeminiToggle={setGeminiOpen}
              onVisionToggle={setVisionOpen}
            />
          </>
        )}
      </main>

      <footer class="footer">
        <p>
          Tes clés restent dans ton navigateur. Fripon n'a aucun serveur.{' '}
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            Code source sur GitHub
          </a>
        </p>
      </footer>
    </div>
  );
}
