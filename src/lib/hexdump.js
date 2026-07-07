/* hexdump — the classic `offset  hex…  ascii` view of a byte slice. Pure,
 * dependency-free. Kit-generic: an extraction candidate for a shared yeet
 * formatting module. */

/* Dump a byte slice as `offset  hex…  ascii` rows. Caps at `maxBytes` with a
 * "… N more" note so a huge buffer can't blow up the caller; returns one string
 * with "\n" between rows (the caller splits it into lines). */
export function hexDump(u8, maxBytes = 512) {
  if (!u8 || !u8.length) return "";
  const n = Math.min(u8.length, maxBytes);
  const rows = [];
  for (let off = 0; off < n; off += 16) {
    const end = Math.min(off + 16, n);
    let hex = "";
    let asc = "";
    for (let i = 0; i < 16; i++) {
      if (off + i < end) {
        const b = u8[off + i];
        hex += b.toString(16).padStart(2, "0") + " ";
        asc += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
      } else {
        hex += "   ";
      }
      if (i === 7) hex += " ";
    }
    rows.push(`${off.toString(16).padStart(6, "0")}  ${hex} ${asc}`);
  }
  if (u8.length > n) rows.push(`… ${u8.length - n} more bytes`);
  return rows.join("\n");
}
