/**
 * PDF Presenter — poll card rendering (presenter, viewer and remote).
 *
 * Builds the card with DOM nodes only, so questions and options can never
 * inject HTML. Viewers get buttons to vote; everyone sees the live bars once
 * results are visible.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { t, formatNumber } from "./i18n.js";

/**
 * @typedef {{ id: string, question: string, options: string[], counts: number[], total: number, open: boolean }} PublicPoll
 */

/**
 * Renders a poll into a container (replacing its content).
 * @param {HTMLElement} container
 * @param {PublicPoll} poll
 * @param {object} [options]
 * @param {number|null} [options.myVote]       Option chosen by this device.
 * @param {(option: number) => void} [options.onVote] Makes options clickable while the poll is open.
 * @param {boolean} [options.showResults]     Shows bars (defaults to true).
 */
export function renderPoll(container, poll, { myVote = null, onVote = null, showResults = true } = {}) {
  const card = document.createElement("div");
  card.className = "poll-card";

  const status = document.createElement("p");
  status.className = `poll-status ${poll.open ? "open" : "closed"}`;
  status.textContent = poll.open ? t("pollLive") : t("pollClosed");

  const question = document.createElement("h3");
  question.className = "poll-question";
  question.textContent = poll.question;
  question.dir = "auto"; // user text may be in another script than the UI

  const list = document.createElement("div");
  list.className = "poll-options";
  const voting = Boolean(onVote) && poll.open;

  poll.options.forEach((label, index) => {
    const count = poll.counts[index] || 0;
    const pct = poll.total ? Math.round((count / poll.total) * 100) : 0;
    const row = document.createElement(voting ? "button" : "div");
    row.className = "poll-option";
    if (voting) {
      row.type = "button";
      row.addEventListener("click", () => onVote(index));
    }
    if (myVote === index) row.classList.add("chosen");
    row.setAttribute("aria-pressed", String(myVote === index));

    const bar = document.createElement("span");
    bar.className = "poll-bar";
    bar.style.width = showResults ? `${pct}%` : "0";

    const text = document.createElement("span");
    text.className = "poll-option-label";
    text.textContent = label;
    text.dir = "auto";

    row.append(bar, text);
    if (showResults) {
      const value = document.createElement("span");
      value.className = "poll-option-value";
      value.textContent = `${formatNumber(pct)}%`;
      row.append(value);
    }
    list.append(row);
  });

  const total = document.createElement("p");
  total.className = "poll-total";
  total.textContent = t("pollVotes", { count: poll.total, n: formatNumber(poll.total) });

  card.append(status, question, list, total);
  container.replaceChildren(card);
}
