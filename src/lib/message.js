/* message — domain helpers over a retained WebSocket message record (the shape
 * state.js publishes). Wssnoop-specific: it knows a record's fields. The generic
 * query DSL (kit/query.js) is fed this record's searchable text via `messageText`. */

/* The plain-text haystack for a retained message record — its opcode name, the
 * decoded text, and any inflate error. Shared by the inspector's message search
 * and the table's per-service match counting so both test the same thing. */
export const messageText = (rec) => `${rec.name ?? ""} ${rec.text ?? ""}${rec.inflateError ?? ""}`;
