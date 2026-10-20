import { useState } from 'preact/hooks';
import { saveSettings, type AnalysisMode, type Settings } from '../../lib/settings';

const CHOICES: { mode: AnalysisMode; label: string; help: string }[] = [
  {
    mode: 'auto',
    label: 'Automatique',
    help: "Chaque annonce est analysée dès que tu l'ouvres.",
  },
  {
    mode: 'click',
    label: 'Au clic',
    help: "Les vérifications gratuites restent automatiques ; la recherche d'image et l'IA attendent ton clic pour économiser tes crédits.",
  },
];

export function ModeSection({ settings, onSaved }: { settings: Settings; onSaved: () => void }) {
  const [error, setError] = useState(false);

  async function choose(mode: AnalysisMode) {
    try {
      await saveSettings({ mode });
      setError(false);
      onSaved();
    } catch {
      setError(true);
    }
  }

  return (
    <section class="card" id="mode" aria-labelledby="mode-title">
      <h2 id="mode-title">Mode d'analyse</h2>
      <fieldset class="choices">
        <legend class="visually-hidden">Quand lancer l'analyse</legend>
        {CHOICES.map(({ mode, label, help }) => (
          <label class="choice" key={mode}>
            <input
              type="radio"
              name="mode"
              value={mode}
              checked={settings.mode === mode}
              onChange={() => void choose(mode)}
            />
            <span class="choice__text">
              <span class="choice__label">{label}</span>
              <span class="choice__help">{help}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {error && (
        <p class="status status--bad" role="status">
          Impossible d'enregistrer ce réglage. Réessaie dans un instant.
        </p>
      )}
    </section>
  );
}
