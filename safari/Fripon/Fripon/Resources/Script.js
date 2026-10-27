function show(enabled, useSettingsInsteadOfPreferences) {
    if (useSettingsInsteadOfPreferences) {
        document.getElementsByClassName('state-on')[0].innerText = "L’extension Fripon est activée. Tu peux la désactiver dans la section Extensions des réglages de Safari.";
        document.getElementsByClassName('state-off')[0].innerText = "L’extension Fripon est désactivée. Tu peux l’activer dans la section Extensions des réglages de Safari.";
        document.getElementsByClassName('state-unknown')[0].innerText = "Tu peux activer l’extension Fripon dans la section Extensions des réglages de Safari.";
        document.getElementsByClassName('open-preferences')[0].innerText = "Quitter et ouvrir les réglages de Safari…";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);
