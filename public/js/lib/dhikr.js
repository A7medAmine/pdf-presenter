/**
 * PDF Presenter — periodic dhikr reminders.
 *
 * Shows a short Arabic phrase in a toast every 2–5 minutes. Reminders are
 * skipped while a page is in fullscreen so they never cover the slides.
 *
 * Licensed under the Apache License, Version 2.0.
 */

const PHRASES = [
  "الْحَمْدُ لِلَّهِ",
  "لَا إِلٰهَ إِلَّا اللَّهُ",
  "اللَّهُ أَكْبَرُ",
  "سُبْحَانَ اللَّه",
  "اللَّهُمَّ صَلِّ عَلَىٰ مُحَمَّدٍ ﷺ",
  "اللَّهُمَّ إِنِّي أَسْأَلُكَ الْجَنَّةَ",
  "اللَّهُ أَكْبَرُ كَبِيرًا",
  "الْحَمْدُ لِلَّهِ كَثِيرًا",
  "سُبْحَانَ اللَّهِ بُكْرَةً وَأَصِيلًا",
  "اللَّهُمَّ يَسِّرْ لِي أَمْرِي",
  "اللَّهُمَّ اغْفِرْ لِي",
  "اللَّهُمَّ اشْرَحْ لِي صَدْرِي",
];

const FIRST_DELAY_MS = 2000;
const VISIBLE_MS = 8000;
const MIN_INTERVAL_MS = 2 * 60 * 1000;
const MAX_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Starts the reminders.
 * @param {{ isSuppressed?: () => boolean }} [options]
 * @returns {() => void} Stops the reminders and hides the toast.
 */
export function startDhikr({ isSuppressed = () => false } = {}) {
  const toast = document.createElement("div");
  toast.className = "dhikr-toast";
  toast.lang = "ar";
  toast.dir = "rtl";
  toast.setAttribute("role", "status");
  toast.title = "Click to dismiss";
  document.body.appendChild(toast);

  let hideTimer = null;
  let nextTimer = null;
  let lastIndex = -1;

  const hide = () => {
    clearTimeout(hideTimer);
    toast.classList.remove("visible");
  };
  toast.addEventListener("click", hide);

  const show = () => {
    if (isSuppressed() || document.visibilityState !== "visible") return;
    let index = Math.floor(Math.random() * PHRASES.length);
    if (index === lastIndex) index = (index + 1) % PHRASES.length;
    lastIndex = index;
    toast.textContent = PHRASES[index];
    toast.classList.add("visible");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, VISIBLE_MS);
  };

  const schedule = (delay) => {
    nextTimer = setTimeout(() => {
      show();
      schedule(MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS));
    }, delay);
  };
  schedule(FIRST_DELAY_MS);

  return () => {
    clearTimeout(nextTimer);
    hide();
  };
}
