import { useCallback, useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';
import { PENDING_SECTION_KEY, takePendingSection } from '../../lib/options-nav';
import { PROVIDERS } from '../../lib/settings';
import { saveUiState } from '../../lib/ui-state';
import { Logo } from '../Logo';
import { CloudSection } from './CloudSection';
import { CreditsSection } from './CreditsSection';
import { GuideSection } from './GuideSection';
import { KeysSection } from './KeysSection';
import { ModeSection } from './ModeSection';
import { WelcomeBanner } from './WelcomeBanner';
import { useStored } from './useStored';

const REPO_URL = 'https://github.com/enzomerand/fripon';
const SECTION_IDS: readonly string[] = ['welcome', 'mode', 'cloud', 'keys', 'credits', 'guide'];

function hashSection(): string {
  return location.hash.replace(/^#/, '');
}

function scrollToSection(id: string, smooth: boolean) {
  const target = document.getElementById(id);
  if (!target) return;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  target.scrollIntoView?.({ behavior: smooth && !reduced ? 'smooth' : 'auto', block: 'start' });
}

interface Target {
  section: string;
  smooth: boolean;
}

export function OptionsApp() {
  const { stored, failed, reload } = useStored();
  // The page can be opened straight on a section (`options.html#guide`).
  const [welcomeAsked, setWelcomeAsked] = useState(() => hashSection() === 'welcome');
  const [welcomeClosed, setWelcomeClosed] = useState(false);
  const [geminiOpen, setGeminiOpen] = useState(() => hashSection() === 'guide');
  const [visionOpen, setVisionOpen] = useState(() => hashSection() === 'guide');
  const [target, setTarget] = useState<Target | null>(() => {
    const section = hashSection();
    return section ? { section, smooth: false } : null;
  });
  const loaded = stored !== null;

  /** Brings a section into view, opening what it needs to show. */
  const goTo = useCallback((section: string, smooth: boolean) => {
    if (section === 'welcome') {
      setWelcomeAsked(true);
      setWelcomeClosed(false);
    }
    if (section === 'guide') {
      setGeminiOpen(true);
      setVisionOpen(true);
    }
    setTarget({ section, smooth });
  }, []);

  // The background asks for a section (a card button, a fresh install) through session storage,
  // which also reaches an options tab that is already open.
  useEffect(() => {
    let alive = true;
    const consume = async (smooth: boolean) => {
      const section = await takePendingSection();
      if (alive && section) goTo(section, smooth);
    };
    void consume(false);
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'session' && PENDING_SECTION_KEY in changes) void consume(true);
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, [goTo]);

  // `#section` links followed while the page is open.
  useEffect(() => {
    const onHashChange = () => {
      const section = hashSection();
      if (section) goTo(section, true);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [goTo]);

  // Scroll once the content exists.
  useEffect(() => {
    if (!loaded || !target) return;
    if (SECTION_IDS.includes(target.section)) scrollToSection(target.section, target.smooth);
    setTarget(null);
  }, [loaded, target]);

  function followGuide() {
    history.replaceState(null, '', '#guide');
    goTo('guide', true);
  }

  function dismissWelcome() {
    setWelcomeAsked(false);
    setWelcomeClosed(true);
    // Remembered so it does not come back; the page is already closed if this fails.
    void saveUiState({ welcomeDismissed: true }).catch(() => undefined);
  }

  const onSaved = () => void reload();
  const showWelcome =
    stored !== null &&
    !welcomeClosed &&
    (welcomeAsked ||
      // A subscriber needs no Google key: the banner would send them to a guide they do not need.
      (stored.cloud === null &&
        stored.cloudExpired === null &&
        !PROVIDERS.some((provider) => stored.settings.keys[provider] !== '') &&
        !stored.ui.welcomeDismissed));

  return (
    <div class="page">
      <header class="header">
        <h1>
          <Logo />
          Fripon
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
              <WelcomeBanner onFollowGuide={followGuide} onDismiss={dismissWelcome} />
            )}
            <ModeSection settings={stored.settings} onSaved={onSaved} />
            <CloudSection status={stored.cloud} expired={stored.cloudExpired} onChanged={onSaved} />
            <KeysSection
              settings={stored.settings}
              signedIn={stored.cloud !== null}
              onSaved={onSaved}
            />
            <CreditsSection
              usage={stored.usage}
              cloud={stored.cloud}
              now={stored.now}
              onSaved={onSaved}
            />
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
          Sans abonnement, tes clés restent dans ton navigateur et aucun serveur de Fripon n'est
          appelé. Avec l'abonnement, l'analyse d'une annonce passe par le serveur de Fripon, qui la
          confie à Google (recherche d'image) et à Anthropic (avis de l'IA).{' '}
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer">
            Code source sur GitHub
          </a>
        </p>
      </footer>
    </div>
  );
}
