import { resolveTicket } from './tickets.js';
import { isReservationReference, resolveReservation } from './reservations.js';

// The administrator scanner's single entry point. NUFR1: (and RC-) references are discussion room reservations; everything
// else keeps its stub meaning (NUFV1:, a bare reference, or a ticket id), so existing scans behave exactly as before.
export async function resolveScan({ db, config, reference, now }) {
  if (isReservationReference(reference)) return { kind: 'reservation', ...(await resolveReservation({ db, config, reference, now })) };
  return { kind: 'ticket', ...(await resolveTicket({ db, reference, now })) };
}
