import { Request, Response } from 'express';

// Store all connected SSE clients
const clients = new Set<Response>();

export function sseHandler(req: Request, res: Response) {
  // Set headers for SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send an initial connected message
  res.write('data: {"type": "connected"}\n\n');

  clients.add(res);

  req.on('close', () => {
    clients.delete(res);
  });
}

// Function to broadcast a message to all connected clients
export function broadcastAlert(message: any) {
  const dataString = `data: ${JSON.stringify(message)}\n\n`;
  for (const client of clients) {
    client.write(dataString);
  }
}
