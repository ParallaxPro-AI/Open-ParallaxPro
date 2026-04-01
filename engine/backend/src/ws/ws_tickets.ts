/**
 * WebSocket Ticket System — short-lived, one-time-use tickets for WS auth.
 * Prevents JWT tokens from appearing in WebSocket URLs (browser history, logs).
 */

import { randomUUID } from 'crypto';
import type { AuthUser } from '../middleware/auth.js';

interface WsTicket {
    user: AuthUser;
    authToken: string;
    expiresAt: number;
}

const tickets = new Map<string, WsTicket>();

// Clean expired tickets every 60 seconds
setInterval(() => {
    const now = Date.now();
    for (const [id, ticket] of tickets) {
        if (now > ticket.expiresAt) tickets.delete(id);
    }
}, 60000);

/** Create a ticket that expires in 30 seconds. */
export function createWsTicket(user: AuthUser, authToken: string): string {
    const id = randomUUID();
    tickets.set(id, { user, authToken, expiresAt: Date.now() + 30000 });
    return id;
}

/** Consume a ticket (one-time use). Returns user + original auth token, or null. */
export function consumeWsTicket(ticketId: string): { user: AuthUser; authToken: string } | null {
    const ticket = tickets.get(ticketId);
    if (!ticket) return null;
    tickets.delete(ticketId);
    if (Date.now() > ticket.expiresAt) return null;
    return { user: ticket.user, authToken: ticket.authToken };
}
