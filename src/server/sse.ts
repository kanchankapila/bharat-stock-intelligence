import { Request, Response } from 'express';

// Store all connected SSE clients, tagged with the userId query param they connected with
// (if any) so broadcastAlert can target one user instead of leaking every alert to every
// open tab. Untagged connections (userId omitted) still receive untargeted broadcasts.
const clients = new Map<Response, string | undefined>();

export function sseHandler(req: Request, res: Response) {
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send an initial connected message
  res.write('data: {"type": "connected"}\n\n');

  const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
  clients.set(res, userId);

  req.on('close', () => {
    clients.delete(res);
  });
}

// Broadcasts a message to connected clients. If message.userId is set, only delivers to
// connections tagged with that same userId (plus any untagged/anonymous connections, so the
// feature degrades gracefully for callers that don't yet pass userId on either side).
export function broadcastAlert(message: any) {
  const dataString = `data: ${JSON.stringify(message)}\n\n`;
  for (const [client, clientUserId] of clients) {
    if (message.userId && clientUserId && clientUserId !== message.userId) continue;
    client.write(dataString);
  }
}
