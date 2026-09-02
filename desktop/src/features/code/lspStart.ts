// The reuse rule for starting a language server (#5857 bounce), pure so it is testable without
// monaco or Tauri. Given what `lsp_start` reported and whether the frontend already has a client
// registered for the same (workspace root, language):
//
//   client already registered → REUSE it; do not build a second client for a live server.
//   server reports initialized:true and NO client exists → the client that ran the handshake was
//     lost (its start rejected after the handshake). A new client.start() would send a second
//     `initialize` and rust-analyzer exits on the spot (rust-1.log: "expected initialized
//     notification, got: Request initialize") — RESPAWN a fresh process instead, stopping the
//     clientless one first.
//   otherwise → the process is fresh and owes the handshake the new client sends: FRESH.
export type LspStartDecision =
  | { action: "reuse"; id: number }
  | { action: "respawn"; stopId: number }
  | { action: "fresh" };

export function decideLspStart(
  started: { id: number; initialized: boolean },
  clientExists: boolean,
): LspStartDecision {
  if (clientExists) return { action: "reuse", id: started.id };
  if (started.initialized) return { action: "respawn", stopId: started.id };
  return { action: "fresh" };
}
