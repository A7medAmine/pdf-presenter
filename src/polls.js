"use strict";

/**
 * Live audience polls.
 *
 * A session holds at most one poll. The presenter or a remote starts it,
 * viewers vote (one vote per device, which they may change while the poll is
 * open), and everyone sees the live tally. Closing a poll freezes the results;
 * clearing it removes it from every screen.
 */

const { randomToken, sanitizeText } = require("./security");

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 6;
/** Upper bound of distinct voters per poll. */
const MAX_VOTERS = 20_000;

/**
 * @typedef {object} Poll
 * @property {string} id
 * @property {string} question
 * @property {string[]} options
 * @property {Map<string, number>} votes  Voter key → option index.
 * @property {boolean} open
 */

class PollError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Creates a poll from untrusted input.
 * @returns {Poll}
 */
function createPoll({ question, options }) {
  const cleanQuestion = sanitizeText(question, 140);
  if (!cleanQuestion) throw new PollError("BAD_INPUT", "The poll needs a question");
  if (!Array.isArray(options)) throw new PollError("BAD_INPUT", "The poll needs options");
  const cleanOptions = options.map((option) => sanitizeText(option, 60)).filter(Boolean);
  if (cleanOptions.length < MIN_OPTIONS || cleanOptions.length > MAX_OPTIONS) {
    throw new PollError("BAD_INPUT", `A poll needs ${MIN_OPTIONS}–${MAX_OPTIONS} options`);
  }
  return { id: randomToken(8), question: cleanQuestion, options: cleanOptions, votes: new Map(), open: true };
}

/**
 * Records a vote.
 * @param {Poll} poll
 * @param {string} voterKey
 * @param {number} option
 */
function castVote(poll, voterKey, option) {
  if (!poll.open) throw new PollError("POLL_CLOSED", "This poll is closed");
  if (!Number.isInteger(option) || option < 0 || option >= poll.options.length) {
    throw new PollError("BAD_INPUT", "Invalid option");
  }
  if (!poll.votes.has(voterKey) && poll.votes.size >= MAX_VOTERS) {
    throw new PollError("POLL_FULL", "This poll cannot take more votes");
  }
  poll.votes.set(voterKey, option);
}

/** Snapshot safe to broadcast (counts only, never who voted for what). */
function publicPoll(poll) {
  if (!poll) return null;
  const counts = poll.options.map(() => 0);
  for (const option of poll.votes.values()) counts[option]++;
  return { id: poll.id, question: poll.question, options: poll.options, counts, total: poll.votes.size, open: poll.open };
}

module.exports = { createPoll, castVote, publicPoll, PollError, MAX_OPTIONS };
