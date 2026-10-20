export interface WelcomeBannerProps {
  onFollowGuide: () => void;
  onDismiss: () => void;
}

/** Three sentences, no obligation: what Fripon does, what it needs, and that it can wait. */
export function WelcomeBanner({ onFollowGuide, onDismiss }: WelcomeBannerProps) {
  return (
    <section class="welcome" id="welcome" aria-labelledby="welcome-title">
      <h2 id="welcome-title" class="visually-hidden">
        Bienvenue
      </h2>
      <p class="welcome__text">
        Fripon vérifie chaque annonce Vinted que tu ouvres : vendeur, photos, description. Pour
        repérer les articles Shein, Temu ou AliExpress revendus, il lui faut une clé Google
        gratuite. Ça prend 2 minutes, et tu peux le faire plus tard.
      </p>
      <div class="welcome__actions">
        <button type="button" class="button button--primary" onClick={onFollowGuide}>
          Suivre le guide
        </button>
        <button type="button" class="button button--ghost" onClick={onDismiss}>
          Plus tard
        </button>
      </div>
    </section>
  );
}
