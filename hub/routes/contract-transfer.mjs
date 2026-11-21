function heldMessages(ctx, source, project, pendingIds) {
  const ids = new Set(pendingIds);
  const senders = new Set(ctx.state.messages.filter(m => m.to === source && m.project === project).map(m => m.from));
  for (const sender of senders) {
    for (const contract of ctx.contractsFor(sender, { project, windowMs: Number.MAX_SAFE_INTEGER })) {
      if (contract.to !== source) continue;
      if (!contract.answered && !["ack", "superseded"].includes(contract.disposition)) ids.add(contract.id);
    }
  }
  return ctx.state.messages.filter(m => ids.has(m.id) && m.to === source && m.project === project);
}

export async function routeContractTransfer({ req, res, q, P, auth, ctx }) {
  if (P !== "/contracts/transfer") return false;
  if (!["GET", "POST"].includes(req.method)) return ctx.json(res, 405, { error: "GET or POST required" });
  const b = req.method === "POST" ? await ctx.body(req) : q;
  const { from, to, project } = b;
  if (!project || !from || !to || !from.endsWith(`:${project}`) || !to.endsWith(`:${project}`)) {
    return ctx.json(res, 400, { error: "source and replacement must belong to the named project" });
  }
  const signer = auth?.identity?.name;
  if (signer && !signer.endsWith(`:${project}`) && auth.identity.kind !== "human") {
    return ctx.json(res, 403, { error: "swap must be requested from its project" });
  }
  // #11221: a seat may never move another seat's work; only the orchestrator or a human swaps.
  if (signer && auth.identity.kind !== "human" && ctx.state.peers[signer]?.kind !== "orch") {
    return ctx.json(res, 403, { error: "only the project's orchestrator or a human can swap seats" });
  }
  const messages = heldMessages(ctx, from, project, b.pendingIds || []);
  if (req.method === "GET") return ctx.json(res, 200, { ok: true, messages });
  if (!ctx.state.peers[b.readySession]?.lastSeen || ctx.state.peers[b.readySession].project !== project) {
    return ctx.json(res, 409, { error: "replacement has not registered on this project's bus" });
  }
  // IDs and original senders survive the move, so replies settle the assigner's original ledger.
  for (let i = 0; i < messages.length; i++) {
    const message = ctx.copyMessage(messages[i]);
    messages[i] = message;
    message.to = to;
  }
  const ids = new Set(messages.map(m => m.id));
  for (const [index, original] of ctx.state.messages.entries()) {
    let message = original;
    if (message.project !== project) continue;
    const mutate = () => { message = ctx.copyMessage(message); ctx.state.messages[index] = message; };
    if (message.kind === "ask" && message.from === from && (ids.has(message.re) || message.id === b.heldAsk)) {
      mutate();
      message.from = to;
      for (const answer of ctx.state.messages) {
        if (answer.re !== message.id || answer.to !== from) continue;
        const answerIndex = ctx.state.messages.indexOf(answer);
        const copy = ctx.copyMessage(answer);
        ctx.state.messages[answerIndex] = copy;
        copy.to = to;
        if (!ids.has(copy.id)) { messages.push(copy); ids.add(copy.id); }
      }
    }
  }
  for (const original of ctx.state.tasks) {
    let card = original;
    if (card.project !== project || card.assignee !== from || !["todo", "doing", "testing", "blocked", "failed"].includes(card.status)) continue;
    card = ctx.copyTask(card);
    card.assignee = to;
    card.updated = ctx.now();
    ctx.appendTaskLog(card, signer || from, `swap reassigned ${from} → ${to}`);
    ctx.appendCardEvent("updated", card, signer || from);
  }
  ctx.appendEvent("crew.swap", project, signer || from, { from, to, moved: [...ids] });
  ctx.markDirty();
  return ctx.json(res, 200, { ok: true, moved: [...ids], messages, cursor: ctx.state.seq });
}
