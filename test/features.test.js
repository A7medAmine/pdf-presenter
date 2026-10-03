"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { startServer, ask, next, delay, MINIMAL_PDF } = require("./helpers");
const { AnnotationBoard } = require("../src/annotations");
const { createPoll, castVote, publicPoll } = require("../src/polls");

/** Joins a fresh session as presenter (with a PDF) and as one viewer. */
async function setupSession(ctx) {
  const session = await ctx.createSession();
  const upload = await ctx.uploadPdf(session);
  const presenter = await ctx.socket();
  await ask(presenter, "join-session", {
    sessionId: session.sessionId,
    role: "presenter",
    presenterToken: session.presenterToken,
  });
  await ask(presenter, "set-total-slides", { totalSlides: 5 });
  const viewer = await ctx.socket();
  const joined = await ask(viewer, "join-session", {
    sessionId: session.sessionId,
    role: "viewer",
    deviceId: "viewer-device-0001",
  });
  return { session, presenter, viewer, upload: upload.json, state: joined.state };
}

describe("AnnotationBoard", () => {
  test("streams chunks into one stroke and clamps coordinates", () => {
    const board = new AnnotationBoard();
    const first = board.apply({ slide: 1, id: "abcd1", tool: "pen", color: "#FF0000", width: 0.004, points: [0, 0, 2, -1] });
    assert.deepEqual(first.points, [0, 0, 1, 0]);
    assert.equal(first.color, "#ff0000");
    board.apply({ slide: 1, id: "abcd1", points: [0.5, 0.5] });
    assert.equal(board.get(1)[0].points.length, 6);
  });

  test("rejects malformed chunks", () => {
    const board = new AnnotationBoard();
    assert.equal(board.apply({ slide: 1, id: "abcd1", tool: "spray", color: "#ff0000", width: 0.01, points: [0, 0] }), null);
    assert.equal(board.apply({ slide: 1, id: "abcd1", tool: "pen", color: "red", width: 0.01, points: [0, 0] }), null);
    assert.equal(board.apply({ slide: 1, id: "abcd1", tool: "pen", color: "#ff0000", width: 0.01, points: [0] }), null);
    assert.equal(board.apply({ slide: 0, id: "abcd1", tool: "pen", color: "#ff0000", width: 0.01, points: [0, 0] }), null);
    assert.equal(board.apply({ slide: 1, id: "x", tool: "pen", color: "#ff0000", width: 0.01, points: [0, 0] }), null);
  });

  test("undo and clear keep the point count consistent", () => {
    const board = new AnnotationBoard();
    board.apply({ slide: 2, id: "s0001", tool: "pen", color: "#000000", width: 0.01, points: [0, 0, 1, 1] });
    board.apply({ slide: 2, id: "s0002", tool: "highlighter", color: "#ffff00", width: 0.02, points: [0, 0] });
    assert.equal(board.pointCount, 3);
    assert.equal(board.undo(2), "s0002");
    assert.equal(board.pointCount, 2);
    board.clear(2);
    assert.equal(board.pointCount, 0);
    assert.deepEqual(board.get(2), []);
  });
});

describe("Polls", () => {
  test("one vote per voter, changeable while open, frozen when closed", () => {
    const poll = createPoll({ question: "Lunch?", options: ["Pizza", "Sushi", ""] });
    assert.deepEqual(poll.options, ["Pizza", "Sushi"]);
    castVote(poll, "a", 0);
    castVote(poll, "a", 1);
    castVote(poll, "b", 1);
    assert.deepEqual(publicPoll(poll).counts, [0, 2]);
    poll.open = false;
    assert.throws(() => castVote(poll, "c", 0), /closed/);
  });

  test("validates options", () => {
    assert.throws(() => createPoll({ question: "Q", options: ["only one"] }));
    assert.throws(() => createPoll({ question: "", options: ["a", "b"] }));
    assert.throws(() => createPoll({ question: "Q", options: ["1", "2", "3", "4", "5", "6", "7"] }));
  });
});

describe("Realtime features", () => {
  let ctx;
  before(async () => {
    ctx = await startServer();
  });
  after(() => ctx.close());

  test("strokes reach viewers and are served to late joiners", async () => {
    const { session, presenter, viewer } = await setupSession(ctx);
    const received = next(viewer, "draw-stroke");
    presenter.emit("draw-stroke", { slide: 1, id: "stroke01", tool: "pen", color: "#ff0000", width: 0.005, points: [0.1, 0.1, 0.2, 0.2] });
    const chunk = await received;
    assert.equal(chunk.id, "stroke01");

    const late = await ctx.socket();
    await ask(late, "join-session", { sessionId: session.sessionId, role: "viewer" });
    const res = await ask(late, "get-annotations", { slide: 1 });
    assert.equal(res.strokes.length, 1);

    const cleared = next(viewer, "draw-clear");
    assert.equal((await ask(presenter, "draw-clear", { slide: 1 })).ok, true);
    assert.deepEqual(await cleared, { slide: 1 });
  });

  test("viewers cannot draw", async () => {
    const { session, viewer } = await setupSession(ctx);
    viewer.emit("draw-stroke", { slide: 1, id: "stroke02", tool: "pen", color: "#ff0000", width: 0.005, points: [0, 0] });
    await delay(50);
    assert.equal(ctx.store.get(session.sessionId).annotations.get(1).length, 0);
    assert.equal((await ask(viewer, "draw-clear", { slide: 1 })).code, "FORBIDDEN");
  });

  test("view effects are shared, and a zoom resets on slide change", async () => {
    const { presenter, viewer, state } = await setupSession(ctx);
    assert.equal(state.effect.mode, "none");
    const zoomed = next(viewer, "view-effect");
    presenter.emit("view-effect", { mode: "zoom", x: 0.3, y: 2, zoom: 9 });
    assert.deepEqual(await zoomed, { mode: "zoom", x: 0.3, y: 1, zoom: 5 });

    const reset = next(viewer, "view-effect");
    await ask(presenter, "slide-change", { slide: 2 });
    assert.equal((await reset).mode, "none");
  });

  test("poll lifecycle: start, vote, close, clear", async () => {
    const { presenter, viewer } = await setupSession(ctx);
    const started = next(viewer, "poll-update");
    const res = await ask(presenter, "poll-start", { question: "Ready?", options: ["Yes", "No"] });
    assert.equal(res.ok, true);
    const { poll } = await started;
    assert.equal(poll.question, "Ready?");

    assert.equal((await ask(presenter, "poll-vote", { pollId: poll.id, option: 0 })).code, "FORBIDDEN");
    const tally = next(presenter, "poll-update");
    assert.equal((await ask(viewer, "poll-vote", { pollId: poll.id, option: 1 })).ok, true);
    assert.deepEqual((await tally).poll.counts, [0, 1]);

    await ask(presenter, "poll-close");
    assert.equal((await ask(viewer, "poll-vote", { pollId: poll.id, option: 0 })).code, "POLL_CLOSED");
    const cleared = next(viewer, "poll-update");
    await ask(presenter, "poll-clear");
    assert.equal((await cleared).poll, null);
  });

  test("downloads need the presenter's permission", async () => {
    const { presenter, viewer, upload } = await setupSession(ctx);
    const url = `${upload.pdf.url}&download=1`;
    assert.equal((await ctx.request(url, { xhr: false })).status, 403);

    const update = next(viewer, "download-update");
    assert.equal((await ask(presenter, "set-download", { enabled: true })).ok, true);
    assert.equal((await update).enabled, true);
    const res = await ctx.request(url, { xhr: false });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /attachment; filename="slides\.pdf"/);
    assert.equal((await ask(viewer, "set-download", { enabled: false })).code, "FORBIDDEN");
  });
});

describe("PowerPoint uploads", () => {
  const PPTX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);

  test("are refused when no converter is available", async () => {
    const ctx = await startServer({}, { converter: { available: false, formats: [], busy: false } });
    try {
      const session = await ctx.createSession();
      const res = await ctx.uploadPdf(session, PPTX, "deck.pptx", "application/octet-stream");
      assert.equal(res.status, 415);
      const caps = await ctx.request("/api/capabilities");
      assert.deepEqual(caps.json.formats, [".pdf"]);
    } finally {
      await ctx.close();
    }
  });

  test("are converted to PDF when a converter is available", async () => {
    const converted = [];
    const fake = {
      available: true,
      formats: [".pptx"],
      busy: false,
      async convert(input, output) {
        converted.push(input);
        await fs.promises.writeFile(output, MINIMAL_PDF);
      },
    };
    const ctx = await startServer({}, { converter: fake });
    try {
      const session = await ctx.createSession();
      const res = await ctx.uploadPdf(session, PPTX, "deck.pptx", "application/octet-stream");
      assert.equal(res.status, 201);
      assert.equal(res.json.pdf.name, "deck.pptx");
      assert.equal(res.json.pdf.converted, true);
      assert.equal(fs.existsSync(converted[0]), false, "source file is removed");
      const pdf = await ctx.request(res.json.pdf.url, { xhr: false });
      assert.equal(pdf.status, 200);
      assert.match(pdf.text, /^%PDF-/);

      const fakePptx = await ctx.uploadPdf(session, Buffer.from("not a zip"), "evil.pptx", "application/octet-stream");
      assert.equal(fakePptx.status, 415);
    } finally {
      await ctx.close();
    }
  });
});
